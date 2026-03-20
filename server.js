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
const CELL_SIZE = 40;
const MAX_PLAYERS = 4;
const BOMB_TIMER = 3000;
const EXPLOSION_DURATION = 800;

// Tile types
const TILE_EMPTY = 0;
const TILE_WALL = 1;
const TILE_BLOCK = 2; // destructible

// Power-up types
const POWERUP_BOMB = 'bomb';
const POWERUP_FLAME = 'flame';
const POWERUP_SPEED = 'speed';

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
  return map;
}

function createRoom(roomId) {
  return {
    id: roomId,
    players: new Map(),
    bombs: [],
    explosions: [],
    powerups: [],
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

function getGameState(room) {
  const players = {};
  room.players.forEach((p, id) => {
    players[id] = {
      id: p.id,
      x: p.x,
      y: p.y,
      alive: p.alive,
      color: p.color,
      name: p.name,
      bombCount: p.bombCount,
      maxBombs: p.maxBombs,
      flameSize: p.flameSize,
    };
  });
  return {
    type: 'gameState',
    players,
    bombs: room.bombs,
    explosions: room.explosions,
    powerups: room.powerups,
    map: room.map,
    gameStarted: room.gameStarted,
    gameOver: room.gameOver,
  };
}

function checkCollision(room, x, y) {
  const tileX = Math.round(x);
  const tileY = Math.round(y);
  if (tileX < 0 || tileX >= GRID_WIDTH || tileY < 0 || tileY >= GRID_HEIGHT) return true;
  return room.map[tileY][tileX] !== TILE_EMPTY;
}

function placeBomb(room, player) {
  if (player.bombCount >= player.maxBombs) return;

  const bx = Math.round(player.x);
  const by = Math.round(player.y);

  // Don't place if bomb already there
  if (room.bombs.find(b => b.x === bx && b.y === by)) return;

  player.bombCount++;

  const bomb = {
    id: Date.now() + Math.random(),
    x: bx,
    y: by,
    playerId: player.id,
    flameSize: player.flameSize,
    timer: BOMB_TIMER,
  };

  room.bombs.push(bomb);
  broadcastAll(room, { type: 'bombPlaced', bomb });

  setTimeout(() => explodeBomb(room, bomb), BOMB_TIMER);
}

function explodeBomb(room, bomb) {
  const idx = room.bombs.indexOf(bomb);
  if (idx === -1) return;
  room.bombs.splice(idx, 1);

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
        if (Math.random() < 0.3) {
          const types = [POWERUP_BOMB, POWERUP_FLAME, POWERUP_SPEED];
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

  // Check player hits
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
  broadcastAll(room, { type: 'explosion', explosion, map: room.map, powerups: room.powerups });

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

  broadcastAll(room, {
    type: 'powerupCollected',
    powerupId: pu.id,
    playerId: player.id,
    maxBombs: player.maxBombs,
    flameSize: player.flameSize,
    speed: player.speed,
  });
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
          x: startPos.x,
          y: startPos.y,
          alive: true,
          color: START_COLORS[currentPlayerId % START_COLORS.length],
          name: msg.name || `Spieler ${currentPlayerId + 1}`,
          bombCount: 0,
          maxBombs: 1,
          flameSize: 2,
          speed: 0.08,
        };

        room.players.set(currentPlayerId, player);

        sendTo(ws, {
          type: 'joined',
          playerId: currentPlayerId,
          roomId,
          ...getGameState(room),
        });

        broadcast(room, {
          type: 'playerJoined',
          player: {
            id: player.id,
            x: player.x,
            y: player.y,
            alive: player.alive,
            color: player.color,
            name: player.name,
          },
        }, currentPlayerId);

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

        let { x, y } = msg;
        x = Math.max(0.5, Math.min(GRID_WIDTH - 1.5, x));
        y = Math.max(0.5, Math.min(GRID_HEIGHT - 1.5, y));

        if (!checkCollision(currentRoom, x, y)) {
          player.x = x;
          player.y = y;
          collectPowerups(currentRoom, player);
          broadcast(currentRoom, { type: 'playerMoved', playerId: currentPlayerId, x, y }, currentPlayerId);
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

      case 'restart': {
        if (!currentRoom) return;
        // Reset game
        currentRoom.map = generateMap();
        currentRoom.bombs = [];
        currentRoom.explosions = [];
        currentRoom.powerups = [];
        currentRoom.gameOver = false;
        currentRoom.gameStarted = currentRoom.players.size >= 2;

        currentRoom.players.forEach((p, i) => {
          const pos = START_POSITIONS[i % START_POSITIONS.length];
          p.x = pos.x;
          p.y = pos.y;
          p.alive = true;
          p.bombCount = 0;
          p.maxBombs = 1;
          p.flameSize = 2;
          p.speed = 0.08;
        });

        broadcastAll(currentRoom, getGameState(currentRoom));
        if (currentRoom.gameStarted) {
          broadcastAll(currentRoom, { type: 'gameStarted' });
        }
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
  console.log(`Bomberman Multiplayer Server läuft auf Port ${PORT}`);
  console.log(`Öffne http://localhost:${PORT} im Browser`);
});
