const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Game constants
const GRID_WIDTH = 15;
const GRID_HEIGHT = 13;
const MAX_PLAYERS = 4;
const BOMB_TIMER = 3000;
const EXPLOSION_DURATION = 800;

// Shadow system constants
const SNAPSHOT_INTERVAL = 100; // 10 Hz per-player filtered snapshots
const LIGHT_RADIUS_BASE = 3;
const LIGHT_RADIUS_MAX = 6;
const LANTERN_RADIUS = 2.5;
const FLASH_RADIUS = 5;
const FLASH_DURATION = 1500;
const FOOTPRINT_LIFETIME = 2500;
const FOOTPRINT_MIN_DIST = 0.8;
const NOISE_RADIUS = 5;
const NOISE_RECENT_MS = 400;
const BOMB_GLOW_MS = 1000;
const SHADOW_CHARGE_MS = 3000;
const SHADOW_FORM_MS = 4000;
const SHADOW_COOLDOWN_MS = 10000;

// Tile types
const TILE_EMPTY = 0;
const TILE_WALL = 1;
const TILE_BLOCK = 2; // destructible

// Power-up types
const POWERUP_BOMB = 'bomb';
const POWERUP_FLAME = 'flame';
const POWERUP_SPEED = 'speed';
const POWERUP_TORCH = 'torch';

// Fixed lantern positions (tiles get cleared during map generation)
const LANTERN_SPOTS = [
  { x: 7, y: 6 },
  { x: 3, y: 6 },
  { x: 11, y: 6 },
  { x: 7, y: 2 },
  { x: 7, y: 10 },
];

// Player start positions
const START_POSITIONS = [
  { x: 1, y: 1 },
  { x: GRID_WIDTH - 2, y: GRID_HEIGHT - 2 },
  { x: GRID_WIDTH - 2, y: 1 },
  { x: 1, y: GRID_HEIGHT - 2 },
];

const START_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12'];

// Game rooms
const rooms = new Map();

function dist(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2);
}

function generateMap() {
  const map = [];
  for (let y = 0; y < GRID_HEIGHT; y++) {
    map[y] = [];
    for (let x = 0; x < GRID_WIDTH; x++) {
      // Border walls
      if (x === 0 || y === 0 || x === GRID_WIDTH - 1 || y === GRID_HEIGHT - 1) {
        map[y][x] = TILE_WALL;
      }
      // Interior fixed walls (every 2 cells)
      else if (x % 2 === 0 && y % 2 === 0) {
        map[y][x] = TILE_WALL;
      }
      // Clear corners for players
      else if (
        (x <= 2 && y <= 2) ||
        (x >= GRID_WIDTH - 3 && y >= GRID_HEIGHT - 3) ||
        (x >= GRID_WIDTH - 3 && y <= 2) ||
        (x <= 2 && y >= GRID_HEIGHT - 3)
      ) {
        map[y][x] = TILE_EMPTY;
      }
      // Random destructible blocks
      else if (Math.random() < 0.65) {
        map[y][x] = TILE_BLOCK;
      } else {
        map[y][x] = TILE_EMPTY;
      }
    }
  }
  // Keep lantern tiles walkable
  LANTERN_SPOTS.forEach(({ x, y }) => {
    if (map[y][x] !== TILE_WALL) map[y][x] = TILE_EMPTY;
  });
  return map;
}

function createLanterns() {
  return LANTERN_SPOTS.map((spot, i) => ({ id: i, x: spot.x, y: spot.y, alive: true }));
}

function createRoom(roomId) {
  return {
    id: roomId,
    players: new Map(),
    bombs: [],
    explosions: [],
    powerups: [],
    footprints: [],
    flashes: [],
    lanterns: createLanterns(),
    map: generateMap(),
    gameStarted: false,
    gameOver: false,
    nextPlayerId: 0,
  };
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, createRoom(roomId));
  }
  return rooms.get(roomId);
}

function broadcast(room, message, excludeId = null) {
  const data = JSON.stringify(message);
  room.players.forEach((player, id) => {
    if (id !== excludeId && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(data);
    }
  });
}

function broadcastAll(room, message) {
  broadcast(room, message, null);
}

function sendTo(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// ---- Shadow / visibility system ----

function isShadowForm(player, now) {
  return player.shadowFormUntil > now;
}

// Is the tile/position (x, y) lit from the viewer's perspective?
function isLitFor(room, viewer, x, y, now) {
  if (dist(viewer.x, viewer.y, x, y) <= viewer.lightRadius) return true;
  for (const lantern of room.lanterns) {
    if (lantern.alive && dist(lantern.x, lantern.y, x, y) <= LANTERN_RADIUS) return true;
  }
  for (const flash of room.flashes) {
    if (flash.until > now && dist(flash.x, flash.y, x, y) <= flash.r) return true;
  }
  return false;
}

// "In shadow" for the shadow meter: not lit by lanterns, flashes or OTHER players' lights.
// The player's own light never counts, otherwise nobody could ever charge the meter.
function computeInShadow(room, player, now) {
  for (const lantern of room.lanterns) {
    if (lantern.alive && dist(lantern.x, lantern.y, player.x, player.y) <= LANTERN_RADIUS) return false;
  }
  for (const flash of room.flashes) {
    if (flash.until > now && dist(flash.x, flash.y, player.x, player.y) <= flash.r) return false;
  }
  for (const [, other] of room.players) {
    if (other.id === player.id || !other.alive) continue;
    if (dist(other.x, other.y, player.x, player.y) <= other.lightRadius) return false;
  }
  return true;
}

function directionBucket(dx, dy) {
  const angle = Math.atan2(dy, dx);
  const buckets = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  const idx = Math.round(angle / (Math.PI / 4));
  return buckets[(idx + 8) % 8];
}

function buildSnapshot(room, viewer, now) {
  // Roster: names & stats of everyone (no positions) for the info bar
  const roster = {};
  room.players.forEach((p, id) => {
    roster[id] = {
      id,
      name: p.name,
      color: p.color,
      alive: p.alive,
      maxBombs: p.maxBombs,
      flameSize: p.flameSize,
    };
  });

  // Players: only those the viewer is allowed to see
  const players = {};
  room.players.forEach((p, id) => {
    if (!p.alive) return;
    if (id !== viewer.id && isShadowForm(p, now)) return; // shadow form: invisible even in light
    if (id === viewer.id || isLitFor(room, viewer, p.x, p.y, now)) {
      players[id] = { id, x: p.x, y: p.y, color: p.color, name: p.name };
    }
  });

  // Bombs: fully visible when lit; unlit bombs only appear as a faint glow
  // during their last second
  const bombs = [];
  const glows = [];
  for (const b of room.bombs) {
    if (isLitFor(room, viewer, b.x, b.y, now)) {
      bombs.push({ id: b.id, x: b.x, y: b.y });
    } else {
      const remaining = b.explodeAt - now;
      if (remaining <= BOMB_GLOW_MS) {
        glows.push({ id: b.id, x: b.x, y: b.y, remaining });
      }
    }
  }

  const powerups = room.powerups.filter(pu => isLitFor(room, viewer, pu.x, pu.y, now));

  const footprints = room.footprints
    .filter(fp => fp.playerId !== viewer.id && isLitFor(room, viewer, fp.x, fp.y, now))
    .map(fp => ({ x: fp.x, y: fp.y, age: now - fp.t }));

  // Noise hints: direction of nearby invisible enemies that recently moved
  // or placed a bomb — never exact coordinates
  const noises = new Set();
  room.players.forEach((p, id) => {
    if (id === viewer.id || !p.alive || players[id]) return;
    if (now - (p.lastActionAt || 0) > NOISE_RECENT_MS) return;
    if (dist(viewer.x, viewer.y, p.x, p.y) > NOISE_RADIUS) return;
    noises.add(directionBucket(p.x - viewer.x, p.y - viewer.y));
  });

  return {
    type: 'shadow',
    you: {
      shadowMeter: viewer.shadowMeter,
      shadowForm: isShadowForm(viewer, now),
      cooldownMs: Math.max(0, viewer.shadowCooldownUntil - now),
      lightRadius: viewer.lightRadius,
      inShadow: viewer.inShadow,
      speed: viewer.speed,
      alive: viewer.alive,
    },
    roster,
    players,
    bombs,
    glows,
    powerups,
    footprints,
    lanterns: room.lanterns,
    flashes: room.flashes.map(f => ({ x: f.x, y: f.y, r: f.r, remaining: f.until - now })),
    noises: [...noises],
    gameStarted: room.gameStarted,
    gameOver: room.gameOver,
  };
}

function tickRoom(room, now) {
  room.flashes = room.flashes.filter(f => f.until > now);
  room.footprints = room.footprints.filter(fp => now - fp.t < FOOTPRINT_LIFETIME);

  room.players.forEach(p => {
    if (!p.alive) return;
    p.inShadow = computeInShadow(room, p, now);
    if (
      room.gameStarted && !room.gameOver &&
      p.inShadow && !isShadowForm(p, now) && now >= p.shadowCooldownUntil
    ) {
      p.shadowMeter = Math.min(1, p.shadowMeter + SNAPSHOT_INTERVAL / SHADOW_CHARGE_MS);
    }
  });

  room.players.forEach(p => {
    sendTo(p.ws, buildSnapshot(room, p, now));
  });
}

setInterval(() => {
  const now = Date.now();
  rooms.forEach(room => {
    if (room.players.size > 0) tickRoom(room, now);
  });
}, SNAPSHOT_INTERVAL);

// ---- Core game logic ----

function checkCollision(room, x, y, phasing) {
  const tileX = Math.round(x);
  const tileY = Math.round(y);
  if (tileX < 0 || tileX >= GRID_WIDTH || tileY < 0 || tileY >= GRID_HEIGHT) return true;
  const tile = room.map[tileY][tileX];
  if (tile === TILE_WALL) return true;
  if (tile === TILE_BLOCK) return !phasing; // shadow form slips through blocks
  return false;
}

function placeBomb(room, player) {
  if (player.bombCount >= player.maxBombs) return;
  if (isShadowForm(player, Date.now())) return; // no bombs while in shadow form

  const bx = Math.round(player.x);
  const by = Math.round(player.y);

  // Don't place if bomb already there
  if (room.bombs.find(b => b.x === bx && b.y === by)) return;

  player.bombCount++;
  player.lastActionAt = Date.now();

  const bomb = {
    id: Date.now() + Math.random(),
    x: bx,
    y: by,
    playerId: player.id,
    flameSize: player.flameSize,
    explodeAt: Date.now() + BOMB_TIMER,
  };

  room.bombs.push(bomb);
  // Only the owner learns about it immediately — everyone else has to see it
  sendTo(player.ws, { type: 'bombPlaced', bomb: { id: bomb.id, x: bomb.x, y: bomb.y } });

  setTimeout(() => explodeBomb(room, bomb), BOMB_TIMER);
}

function explodeBomb(room, bomb) {
  const idx = room.bombs.indexOf(bomb);
  if (idx === -1) return;
  room.bombs.splice(idx, 1);

  const now = Date.now();
  const player = room.players.get(bomb.playerId);
  if (player) player.bombCount = Math.max(0, player.bombCount - 1);

  const cells = [{ x: bomb.x, y: bomb.y }];
  const directions = [[0, 1], [0, -1], [1, 0], [-1, 0]];

  for (const [dx, dy] of directions) {
    for (let i = 1; i <= bomb.flameSize; i++) {
      const nx = bomb.x + dx * i;
      const ny = bomb.y + dy * i;
      if (nx < 0 || nx >= GRID_WIDTH || ny < 0 || ny >= GRID_HEIGHT) break;
      if (room.map[ny][nx] === TILE_WALL) break;
      if (room.map[ny][nx] === TILE_BLOCK) {
        cells.push({ x: nx, y: ny });
        // Destroy block
        room.map[ny][nx] = TILE_EMPTY;
        // Maybe spawn powerup
        if (Math.random() < 0.35) {
          const types = [POWERUP_BOMB, POWERUP_FLAME, POWERUP_SPEED, POWERUP_TORCH];
          const pu = {
            id: Date.now() + Math.random(),
            x: nx,
            y: ny,
            type: types[Math.floor(Math.random() * types.length)],
          };
          room.powerups.push(pu);
        }
        break;
      }
      cells.push({ x: nx, y: ny });

      // Chain explosion
      const chainBomb = room.bombs.find(b => b.x === nx && b.y === ny);
      if (chainBomb) {
        setTimeout(() => explodeBomb(room, chainBomb), 50);
      }
    }
  }

  // Destroy lanterns caught in the blast
  room.lanterns.forEach(l => {
    if (l.alive && cells.some(c => c.x === l.x && c.y === l.y)) {
      l.alive = false;
    }
  });

  // The blast lights up the surroundings for a moment
  room.flashes.push({ x: bomb.x, y: bomb.y, r: FLASH_RADIUS, until: now + FLASH_DURATION });

  // Check player hits (shadow form does NOT protect)
  room.players.forEach((p) => {
    if (!p.alive) return;
    const hit = cells.find(c => Math.abs(c.x - Math.round(p.x)) < 0.6 && Math.abs(c.y - Math.round(p.y)) < 0.6);
    if (hit) {
      p.alive = false;
      broadcastAll(room, { type: 'playerDied', playerId: p.id });
      checkGameOver(room);
    }
  });

  const explosion = { id: Date.now() + Math.random(), cells };
  room.explosions.push(explosion);
  broadcastAll(room, { type: 'explosion', explosion, map: room.map });

  setTimeout(() => {
    const ei = room.explosions.indexOf(explosion);
    if (ei !== -1) room.explosions.splice(ei, 1);
  }, EXPLOSION_DURATION);
}

function checkGameOver(room) {
  const alivePlayers = [...room.players.values()].filter(p => p.alive);
  if (alivePlayers.length <= 1 && room.players.size > 1) {
    room.gameOver = true;
    const winner = alivePlayers[0] || null;
    broadcastAll(room, {
      type: 'gameOver',
      winnerId: winner ? winner.id : null,
      winnerName: winner ? winner.name : null,
    });
  }
}

function collectPowerups(room, player) {
  const px = Math.round(player.x);
  const py = Math.round(player.y);
  const pu = room.powerups.find(p => p.x === px && p.y === py);
  if (!pu) return;

  room.powerups.splice(room.powerups.indexOf(pu), 1);
  if (pu.type === POWERUP_BOMB) player.maxBombs = Math.min(player.maxBombs + 1, 8);
  if (pu.type === POWERUP_FLAME) player.flameSize = Math.min(player.flameSize + 1, 8);
  if (pu.type === POWERUP_SPEED) player.speed = Math.min(player.speed + 0.02, 0.15);
  if (pu.type === POWERUP_TORCH) player.lightRadius = Math.min(player.lightRadius + 1, LIGHT_RADIUS_MAX);

  sendTo(player.ws, {
    type: 'powerupCollected',
    powerupType: pu.type,
    maxBombs: player.maxBombs,
    flameSize: player.flameSize,
    speed: player.speed,
    lightRadius: player.lightRadius,
  });
}

function resetPlayer(player, index) {
  const pos = START_POSITIONS[index % START_POSITIONS.length];
  player.x = pos.x;
  player.y = pos.y;
  player.alive = true;
  player.bombCount = 0;
  player.maxBombs = 1;
  player.flameSize = 2;
  player.speed = 0.08;
  player.lightRadius = LIGHT_RADIUS_BASE;
  player.shadowMeter = 0;
  player.shadowFormUntil = 0;
  player.shadowCooldownUntil = 0;
  player.inShadow = false;
  player.lastFootprint = null;
  player.lastActionAt = 0;
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentPlayerId = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        const roomId = msg.roomId || 'default';
        const room = getRoom(roomId);

        if (room.players.size >= MAX_PLAYERS) {
          sendTo(ws, { type: 'error', message: 'Raum ist voll!' });
          return;
        }

        currentRoom = room;
        currentPlayerId = room.nextPlayerId++;

        const startPos = START_POSITIONS[currentPlayerId % START_POSITIONS.length];
        const player = {
          id: currentPlayerId,
          ws,
          name: (msg.name || `Spieler ${currentPlayerId + 1}`).slice(0, 16),
          color: START_COLORS[currentPlayerId % START_COLORS.length],
          x: startPos.x,
          y: startPos.y,
        };
        resetPlayer(player, currentPlayerId);

        room.players.set(currentPlayerId, player);

        sendTo(ws, {
          type: 'joined',
          playerId: currentPlayerId,
          roomId,
          map: room.map,
          spawn: { x: player.x, y: player.y },
          gameStarted: room.gameStarted,
          gameOver: room.gameOver,
        });

        // Auto-start when 2+ players
        if (room.players.size >= 2 && !room.gameStarted) {
          room.gameStarted = true;
          broadcastAll(room, { type: 'gameStarted' });
        }
        break;
      }

      case 'move': {
        if (!currentRoom || currentPlayerId === null) return;
        const player = currentRoom.players.get(currentPlayerId);
        if (!player || !player.alive || !currentRoom.gameStarted) return;

        const now = Date.now();
        let { x, y } = msg;
        if (typeof x !== 'number' || typeof y !== 'number') return;
        x = Math.max(0.5, Math.min(GRID_WIDTH - 1.5, x));
        y = Math.max(0.5, Math.min(GRID_HEIGHT - 1.5, y));

        const phasing = isShadowForm(player, now);
        if (!checkCollision(currentRoom, x, y, phasing)) {
          player.x = x;
          player.y = y;
          player.lastActionAt = now;

          // Footprints — but not while gliding in shadow form
          if (!phasing) {
            const lf = player.lastFootprint;
            if (!lf || dist(lf.x, lf.y, x, y) >= FOOTPRINT_MIN_DIST) {
              currentRoom.footprints.push({ x, y, t: now, playerId: player.id });
              player.lastFootprint = { x, y };
            }
          }

          collectPowerups(currentRoom, player);
        }
        break;
      }

      case 'placeBomb': {
        if (!currentRoom || currentPlayerId === null) return;
        const player = currentRoom.players.get(currentPlayerId);
        if (!player || !player.alive || !currentRoom.gameStarted) return;
        placeBomb(currentRoom, player);
        break;
      }

      case 'shadowForm': {
        if (!currentRoom || currentPlayerId === null) return;
        const player = currentRoom.players.get(currentPlayerId);
        if (!player || !player.alive || !currentRoom.gameStarted) return;

        const now = Date.now();
        if (player.shadowMeter >= 1 && now >= player.shadowCooldownUntil && !isShadowForm(player, now)) {
          player.shadowMeter = 0;
          player.shadowFormUntil = now + SHADOW_FORM_MS;
          player.shadowCooldownUntil = player.shadowFormUntil + SHADOW_COOLDOWN_MS;
        }
        break;
      }

      case 'restart': {
        if (!currentRoom) return;
        currentRoom.map = generateMap();
        currentRoom.bombs = [];
        currentRoom.explosions = [];
        currentRoom.powerups = [];
        currentRoom.footprints = [];
        currentRoom.flashes = [];
        currentRoom.lanterns = createLanterns();
        currentRoom.gameOver = false;
        currentRoom.gameStarted = currentRoom.players.size >= 2;

        let i = 0;
        currentRoom.players.forEach((p) => {
          resetPlayer(p, i++);
          sendTo(p.ws, {
            type: 'restart',
            map: currentRoom.map,
            spawn: { x: p.x, y: p.y },
            gameStarted: currentRoom.gameStarted,
          });
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!currentRoom || currentPlayerId === null) return;
    currentRoom.players.delete(currentPlayerId);
    broadcast(currentRoom, { type: 'playerLeft', playerId: currentPlayerId });

    if (currentRoom.players.size === 0) {
      rooms.delete(currentRoom.id);
    } else {
      checkGameOver(currentRoom);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Shadow Bomber Server läuft auf Port ${PORT}`);
  console.log(`Öffne http://localhost:${PORT} im Browser`);
});
