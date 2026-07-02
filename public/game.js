// Game constants (must match server.js)
const GRID_WIDTH = 15;
const GRID_HEIGHT = 13;
const CELL_SIZE = 40;

const TILE_EMPTY = 0;
const TILE_WALL = 1;
const TILE_BLOCK = 2;

const LANTERN_RADIUS = 2.5;
const SHADOW_SPEED_BOOST = 1.3;

// Color palette
const COLORS = {
  empty: '#22223c',
  wall: '#0f3460',
  block: '#8B6914',
  blockHighlight: '#c49a1e',
  blockShadow: '#5a4208',
};

// State
let ws = null;
let myId = null;
let map = [];
let seen = []; // memory fog: tiles the player has seen at least once
let gameStarted = false;
let gameOver = false;

// Own player (client-side movement, server-verified)
let me = {
  x: 1, y: 1, alive: true, speed: 0.08,
  lightRadius: 3, shadowMeter: 0, shadowForm: false,
  cooldownMs: 0, inShadow: false,
};
let meSpawned = false;

// Server-filtered snapshot data
let roster = {};
let others = {}; // id -> { x, y, tx, ty, color, name, lastSeen }
let bombs = [];
let glows = [];
let powerups = [];
let footprints = [];
let lanterns = [];
let flashes = [];
let noises = [];
let explosions = [];

let animFrame = null;
let keys = {};

// Input
const moveKeys = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
  W: [0, -1], S: [0, 1], A: [-1, 0], D: [1, 0],
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Shift' || e.key === 'e' || e.key === 'E') {
    sendShadowForm();
    return;
  }
  if (keys[e.key]) return;
  keys[e.key] = true;
  if (e.key === ' ') {
    e.preventDefault();
    sendBomb();
  }
});
document.addEventListener('keyup', (e) => { keys[e.key] = false; });

let lastMoveTime = 0;
const MOVE_INTERVAL = 50;       // ms between network position updates
const BASE_TILES_PER_SEC = 4.5; // base movement speed (scaled by speed power-up)
const BODY_MARGIN = 0.4;        // leading-edge distance for wall collision

let lastFrameTs = 0;

function gameLoop(ts) {
  animFrame = requestAnimationFrame(gameLoop);

  const dt = lastFrameTs ? Math.min(0.05, (ts - lastFrameTs) / 1000) : 0;
  lastFrameTs = ts;

  if (myId !== null && dt > 0) handleMovement(dt, ts);
  interpolateOthers(dt);
  updateSeenTiles();
  render();
  updateShadowMeterUI();
}

function blockedTile(tx, ty) {
  if (tx < 0 || tx >= GRID_WIDTH || ty < 0 || ty >= GRID_HEIGHT) return true;
  if (!map[ty]) return true;
  const tile = map[ty][tx];
  if (tile === TILE_WALL) return true;
  if (tile === TILE_BLOCK) return !me.shadowForm; // shadow form glides through blocks
  // Bombs are solid — except the tile we're standing on (so you can
  // step off a freshly placed bomb) and while in shadow form
  if (!me.shadowForm && !(Math.round(me.x) === tx && Math.round(me.y) === ty)) {
    if (bombs.some(b => b.x === tx && b.y === ty)) return true;
    if (glows.some(g => g.x === tx && g.y === ty)) return true;
  }
  return false;
}

function blockedAt(x, y) {
  return blockedTile(Math.round(x), Math.round(y));
}

const clampX = (x) => Math.max(1, Math.min(GRID_WIDTH - 2, x));
const clampY = (y) => Math.max(1, Math.min(GRID_HEIGHT - 2, y));

function handleMovement(dt, ts) {
  if (!me.alive || !gameStarted || !meSpawned) return;

  let dx = 0, dy = 0;
  for (const [key, [kx, ky]] of Object.entries(moveKeys)) {
    if (keys[key]) { dx += kx; dy += ky; }
  }
  dx = Math.sign(dx);
  dy = Math.sign(dy);
  if (dx === 0 && dy === 0) return;

  const spd = BASE_TILES_PER_SEC * ((me.speed || 0.08) / 0.08) * (me.shadowForm ? SHADOW_SPEED_BOOST : 1);
  let step = spd * dt;
  if (dx !== 0 && dy !== 0) step *= 0.707;

  const oldX = me.x, oldY = me.y;
  const col = Math.round(me.x);
  const row = Math.round(me.y);
  let assisted = false; // corner assist and lane centering must not fight

  // X axis with leading-edge collision
  if (dx !== 0) {
    const nx = clampX(me.x + dx * step);
    if (!blockedAt(nx + dx * BODY_MARGIN, me.y)) {
      me.x = nx;
    } else if (dy === 0) {
      // Corner assist: slide toward an adjacent open row
      const prefer = Math.sign(me.y - row) || 1;
      for (const side of [prefer, -prefer]) {
        const r = row + side;
        if (!blockedTile(col, r) && !blockedTile(col + dx, r)) {
          me.y = clampY(me.y + side * step);
          assisted = true;
          break;
        }
      }
    }
  }

  // Y axis with leading-edge collision
  if (dy !== 0) {
    const ny = clampY(me.y + dy * step);
    if (!blockedAt(me.x, ny + dy * BODY_MARGIN)) {
      me.y = ny;
    } else if (dx === 0) {
      // Corner assist: slide toward an adjacent open column
      const prefer = Math.sign(me.x - col) || 1;
      for (const side of [prefer, -prefer]) {
        const c = col + side;
        if (!blockedTile(c, row) && !blockedTile(c, row + dy)) {
          me.x = clampX(me.x + side * step);
          assisted = true;
          break;
        }
      }
    }
  }

  // Lane centering: while walking along one axis, drift to the middle
  // of the corridor so the character stays aligned with the grid
  if (!assisted) {
    if (dx !== 0 && dy === 0 && me.y !== row) {
      me.y += Math.max(-step, Math.min(step, Math.round(me.y) - me.y));
    } else if (dy !== 0 && dx === 0 && me.x !== col) {
      me.x += Math.max(-step, Math.min(step, Math.round(me.x) - me.x));
    }
  }

  // Rate-limited network update, movement itself stays per-frame smooth
  if ((me.x !== oldX || me.y !== oldY) && ts - lastMoveTime > MOVE_INTERVAL) {
    lastMoveTime = ts;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'move', x: me.x, y: me.y }));
    }
  }
}

function sendBomb() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'placeBomb' }));
  }
}

function sendShadowForm() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'shadowForm' }));
  }
}

function sendAddBot() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'addBot' }));
  }
}

// Smoothly move other players toward their latest snapshot position
// (exponential smoothing, frame-rate independent)
function interpolateOthers(dt) {
  const f = 1 - Math.exp(-14 * dt);
  Object.values(others).forEach(o => {
    o.x += (o.tx - o.x) * f;
    o.y += (o.ty - o.y) * f;
  });
}

// ---- Memory fog ----
function resetSeen() {
  seen = [];
  for (let y = 0; y < GRID_HEIGHT; y++) seen[y] = new Array(GRID_WIDTH).fill(false);
}
resetSeen();

function updateSeenTiles() {
  if (!meSpawned) return;
  const sources = [{ x: me.x, y: me.y, r: me.lightRadius }];
  lanterns.forEach(l => { if (l.alive) sources.push({ x: l.x, y: l.y, r: LANTERN_RADIUS }); });
  flashes.forEach(f => sources.push({ x: f.x, y: f.y, r: f.r }));

  for (const s of sources) {
    const minX = Math.max(0, Math.floor(s.x - s.r));
    const maxX = Math.min(GRID_WIDTH - 1, Math.ceil(s.x + s.r));
    const minY = Math.max(0, Math.floor(s.y - s.r));
    const maxY = Math.min(GRID_HEIGHT - 1, Math.ceil(s.y + s.r));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (Math.hypot(x - s.x, y - s.y) <= s.r + 0.5) seen[y][x] = true;
      }
    }
  }
}

// ---- Rendering ----
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
canvas.width = GRID_WIDTH * CELL_SIZE;
canvas.height = GRID_HEIGHT * CELL_SIZE;

// Offscreen darkness layer
const darkCanvas = document.createElement('canvas');
darkCanvas.width = canvas.width;
darkCanvas.height = canvas.height;
const darkCtx = darkCanvas.getContext('2d');

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!map.length) return;

  drawMap();
  drawFootprints();
  drawPowerups();
  drawLanterns();
  drawBombs();
  drawGlows();
  drawExplosions();
  drawPlayers();
  drawDarkness();
  drawUnseen();
  drawNoiseIndicators();
}

function drawMap() {
  for (let y = 0; y < GRID_HEIGHT; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      const px = x * CELL_SIZE;
      const py = y * CELL_SIZE;
      const tile = map[y] ? map[y][x] : 0;

      if (tile === TILE_WALL) {
        ctx.fillStyle = '#1c3a6b';
        ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
        ctx.fillStyle = '#0d2445';
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        ctx.fillStyle = '#2a5299';
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, 3);
        ctx.fillRect(px + 2, py + 2, 3, CELL_SIZE - 4);
      } else if (tile === TILE_BLOCK) {
        ctx.fillStyle = COLORS.block;
        ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
        ctx.fillStyle = COLORS.blockHighlight;
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, 4);
        ctx.fillRect(px + 2, py + 2, 4, CELL_SIZE - 4);
        ctx.fillStyle = COLORS.blockShadow;
        ctx.fillRect(px + 2, py + CELL_SIZE - 6, CELL_SIZE - 4, 4);
        ctx.fillRect(px + CELL_SIZE - 6, py + 2, 4, CELL_SIZE - 4);
      } else {
        ctx.fillStyle = COLORS.empty;
        ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
        ctx.strokeStyle = '#1b1b33';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(px, py, CELL_SIZE, CELL_SIZE);
      }
    }
  }
}

function drawFootprints() {
  footprints.forEach(fp => {
    const alpha = Math.max(0, 1 - fp.age / 2500) * 0.5;
    ctx.fillStyle = `rgba(200, 200, 255, ${alpha})`;
    ctx.beginPath();
    ctx.ellipse(fp.x * CELL_SIZE + CELL_SIZE / 2, fp.y * CELL_SIZE + CELL_SIZE / 2, 5, 8, 0, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawLanterns() {
  lanterns.forEach(l => {
    const px = l.x * CELL_SIZE + CELL_SIZE / 2;
    const py = l.y * CELL_SIZE + CELL_SIZE / 2;

    ctx.save();
    ctx.translate(px, py);

    // Post
    ctx.fillStyle = l.alive ? '#5a4a3a' : '#3a3a3a';
    ctx.fillRect(-3, -4, 6, 16);

    if (l.alive) {
      // Warm glow
      const grd = ctx.createRadialGradient(0, -8, 0, 0, -8, 18);
      grd.addColorStop(0, 'rgba(255, 200, 100, 0.7)');
      grd.addColorStop(1, 'transparent');
      ctx.fillStyle = grd;
      ctx.fillRect(-18, -26, 36, 36);

      ctx.fillStyle = '#ffcf70';
      ctx.beginPath();
      ctx.arc(0, -8, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#8a6a30';
    } else {
      // Broken lantern
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(0, -8, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#444';
    }
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.restore();
  });
}

function drawPowerups() {
  powerups.forEach(pu => {
    const px = pu.x * CELL_SIZE + CELL_SIZE / 2;
    const py = pu.y * CELL_SIZE + CELL_SIZE / 2;
    const r = CELL_SIZE * 0.3;

    ctx.save();
    ctx.translate(px, py);

    const glowColors = {
      bomb: 'rgba(255,100,50,0.4)',
      flame: 'rgba(255,200,0,0.4)',
      speed: 'rgba(100,255,100,0.4)',
      torch: 'rgba(180,140,255,0.5)',
    };
    const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, r + 6);
    grd.addColorStop(0, glowColors[pu.type] || 'rgba(255,255,255,0.3)');
    grd.addColorStop(1, 'transparent');
    ctx.fillStyle = grd;
    ctx.fillRect(-r - 6, -r - 6, (r + 6) * 2, (r + 6) * 2);

    const fillColors = { bomb: '#ff6432', flame: '#ffc800', speed: '#64ff64', torch: '#b48cff' };
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = fillColors[pu.type] || '#ccc';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const icons = { bomb: '💣', flame: '🔥', speed: '👟', torch: '🔦' };
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${r * 1.1}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(icons[pu.type] || '?', 0, 0);

    ctx.restore();
  });
}

function drawBombs() {
  const t = Date.now();
  bombs.forEach(bomb => {
    const px = bomb.x * CELL_SIZE + CELL_SIZE / 2;
    const py = bomb.y * CELL_SIZE + CELL_SIZE / 2;
    const pulse = Math.sin(t / 200) * 0.15 + 0.85;
    const r = CELL_SIZE * 0.38 * pulse;

    ctx.save();
    ctx.translate(px, py);

    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(3, 6, r * 0.8, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = '#111';
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(-r * 0.3, -r * 0.3, r * 0.25, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fill();

    ctx.strokeStyle = '#8B6914';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(r * 0.4, -r * 0.6);
    ctx.quadraticCurveTo(r * 0.8, -r * 1.2, r * 0.3, -r * 1.5);
    ctx.stroke();

    ctx.fillStyle = '#ff0';
    ctx.beginPath();
    ctx.arc(r * 0.3, -r * 1.5, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  });
}

// Bombs hidden in darkness betray themselves with a faint ember during the last second
function drawGlows() {
  const t = Date.now();
  glows.forEach(g => {
    const px = g.x * CELL_SIZE + CELL_SIZE / 2;
    const py = g.y * CELL_SIZE + CELL_SIZE / 2;
    const intensity = 1 - Math.max(0, g.remaining) / 1000; // brighter as timer runs out
    const flicker = Math.sin(t / 60) * 0.2 + 0.8;
    const alpha = (0.25 + intensity * 0.6) * flicker;

    const grd = ctx.createRadialGradient(px, py, 0, px, py, 10 + intensity * 8);
    grd.addColorStop(0, `rgba(255, 120, 30, ${alpha})`);
    grd.addColorStop(1, 'transparent');
    ctx.fillStyle = grd;
    ctx.fillRect(px - 20, py - 20, 40, 40);
  });
}

function drawExplosions() {
  explosions.forEach(exp => {
    exp.cells.forEach(cell => {
      const px = cell.x * CELL_SIZE;
      const py = cell.y * CELL_SIZE;

      const grd = ctx.createRadialGradient(
        px + CELL_SIZE / 2, py + CELL_SIZE / 2, 0,
        px + CELL_SIZE / 2, py + CELL_SIZE / 2, CELL_SIZE * 0.8
      );
      grd.addColorStop(0, 'rgba(255,255,255,0.9)');
      grd.addColorStop(0.3, 'rgba(255,200,0,0.8)');
      grd.addColorStop(0.6, 'rgba(255,80,0,0.7)');
      grd.addColorStop(1, 'rgba(255,0,0,0)');

      ctx.fillStyle = grd;
      ctx.fillRect(px - 4, py - 4, CELL_SIZE + 8, CELL_SIZE + 8);
    });
  });
}

function drawPlayerBody(player, isMe) {
  const cx = player.x * CELL_SIZE + CELL_SIZE / 2;
  const cy = player.y * CELL_SIZE + CELL_SIZE / 2;
  const r = CELL_SIZE * 0.38;

  ctx.save();
  ctx.translate(cx, cy);

  if (isMe && me.shadowForm) {
    ctx.globalAlpha = 0.45;
  }

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(3, r * 0.7, r * 0.7, r * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();

  // Body
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = isMe && me.shadowForm ? '#3a2a5a' : player.color;
  ctx.fill();
  ctx.strokeStyle = isMe && me.shadowForm ? '#b48cff' : 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Face shine
  ctx.beginPath();
  ctx.arc(-r * 0.25, -r * 0.25, r * 0.22, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fill();

  // Eyes
  ctx.fillStyle = isMe && me.shadowForm ? '#b48cff' : '#fff';
  ctx.beginPath();
  ctx.arc(-r * 0.25, -r * 0.1, r * 0.15, 0, Math.PI * 2);
  ctx.arc(r * 0.25, -r * 0.1, r * 0.15, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(-r * 0.22, -r * 0.08, r * 0.08, 0, Math.PI * 2);
  ctx.arc(r * 0.27, -r * 0.08, r * 0.08, 0, Math.PI * 2);
  ctx.fill();

  // Name label
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.font = '11px monospace';
  const nameW = ctx.measureText(player.name).width + 8;
  ctx.fillRect(-nameW / 2, -r - 20, nameW, 16);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(player.name, 0, -r - 12);

  // "ME" indicator
  if (isMe) {
    ctx.strokeStyle = me.shadowForm ? '#b48cff' : '#fff';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(0, 0, r + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
}

function drawPlayers() {
  Object.values(others).forEach(o => drawPlayerBody(o, false));
  if (meSpawned && me.alive) {
    drawPlayerBody({ x: me.x, y: me.y, color: roster[myId] ? roster[myId].color : '#fff', name: roster[myId] ? roster[myId].name : '' }, true);
  }
}

// Darkness layer: black overlay with light holes punched out
function drawDarkness() {
  darkCtx.globalCompositeOperation = 'source-over';
  darkCtx.clearRect(0, 0, darkCanvas.width, darkCanvas.height);
  darkCtx.fillStyle = 'rgba(0, 0, 5, 0.92)';
  darkCtx.fillRect(0, 0, darkCanvas.width, darkCanvas.height);

  darkCtx.globalCompositeOperation = 'destination-out';

  const punch = (x, y, r, softness = 0.5) => {
    const px = x * CELL_SIZE + CELL_SIZE / 2;
    const py = y * CELL_SIZE + CELL_SIZE / 2;
    const pr = r * CELL_SIZE;
    const grd = darkCtx.createRadialGradient(px, py, 0, px, py, pr);
    grd.addColorStop(0, 'rgba(0,0,0,1)');
    grd.addColorStop(softness, 'rgba(0,0,0,0.9)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    darkCtx.fillStyle = grd;
    darkCtx.fillRect(px - pr, py - pr, pr * 2, pr * 2);
  };

  if (meSpawned && me.alive) punch(me.x, me.y, me.lightRadius);
  if (!me.alive) {
    // Spectators see everything dimly — punch a huge hole
    punch(GRID_WIDTH / 2, GRID_HEIGHT / 2, GRID_WIDTH);
  }
  lanterns.forEach(l => { if (l.alive) punch(l.x, l.y, LANTERN_RADIUS, 0.4); });
  flashes.forEach(f => {
    const fade = Math.min(1, Math.max(0, f.remaining / 1500));
    const px = f.x * CELL_SIZE + CELL_SIZE / 2;
    const py = f.y * CELL_SIZE + CELL_SIZE / 2;
    const pr = f.r * CELL_SIZE;
    const grd = darkCtx.createRadialGradient(px, py, 0, px, py, pr);
    grd.addColorStop(0, `rgba(0,0,0,${fade})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    darkCtx.fillStyle = grd;
    darkCtx.fillRect(px - pr, py - pr, pr * 2, pr * 2);
  });
  explosions.forEach(exp => exp.cells.forEach(c => punch(c.x, c.y, 1.5)));
  glows.forEach(g => punch(g.x, g.y, 0.5));

  ctx.drawImage(darkCanvas, 0, 0);
}

// Tiles never seen are pitch black (memory fog)
function drawUnseen() {
  if (!me.alive) return; // spectators see the whole map
  ctx.fillStyle = '#000005';
  for (let y = 0; y < GRID_HEIGHT; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      if (!seen[y][x]) {
        ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
      }
    }
  }
}

// Direction hints for invisible enemies moving nearby
const NOISE_ANGLES = {
  E: 0, SE: Math.PI / 4, S: Math.PI / 2, SW: (3 * Math.PI) / 4,
  W: Math.PI, NW: (5 * Math.PI) / 4, N: (3 * Math.PI) / 2, NE: (7 * Math.PI) / 4,
};

function drawNoiseIndicators() {
  if (!noises.length || !me.alive) return;
  const t = Date.now();
  const pulse = Math.sin(t / 150) * 0.3 + 0.7;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const rx = canvas.width / 2 - 24;
  const ry = canvas.height / 2 - 24;

  noises.forEach(dir => {
    const angle = NOISE_ANGLES[dir];
    if (angle === undefined) return;
    const x = cx + Math.cos(angle) * rx;
    const y = cy + Math.sin(angle) * ry;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.globalAlpha = pulse;
    ctx.fillStyle = '#ff5555';
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-6, -9);
    ctx.lineTo(-6, 9);
    ctx.closePath();
    ctx.fill();
    ctx.font = '14px serif';
    ctx.rotate(-angle);
    ctx.fillText('👂', -20, 5);
    ctx.restore();
  });
}

// ---- UI Updates ----
function updateInfoBar() {
  const bar = document.getElementById('info-bar');
  bar.innerHTML = '';

  Object.values(roster).forEach(p => {
    const div = document.createElement('div');
    div.className = 'player-info' + (p.alive ? '' : ' dead');
    div.innerHTML = `
      <div class="player-dot" style="background:${p.color}"></div>
      <span>${p.name}</span>
      <span title="Bomben">💣${p.maxBombs}</span>
      <span title="Flamme">🔥${p.flameSize}</span>
    `;
    bar.appendChild(div);
  });

  const roomSpan = document.createElement('span');
  roomSpan.style.marginLeft = 'auto';
  roomSpan.style.fontSize = '0.75rem';
  roomSpan.style.color = '#888';
  const roomId = document.getElementById('roomId').value || 'default';
  roomSpan.textContent = `Raum: ${roomId}`;
  bar.appendChild(roomSpan);
}

function updateShadowMeterUI() {
  const fill = document.getElementById('shadow-meter-fill');
  const label = document.getElementById('shadow-meter-label');
  if (!fill) return;

  fill.style.width = `${Math.round(me.shadowMeter * 100)}%`;

  if (me.shadowForm) {
    fill.style.background = '#b48cff';
    label.textContent = '🌑 SCHATTENFORM AKTIV';
  } else if (me.cooldownMs > 0) {
    fill.style.background = '#555';
    label.textContent = `Abklingzeit ${(me.cooldownMs / 1000).toFixed(1)}s`;
  } else if (me.shadowMeter >= 1) {
    fill.style.background = '#9b59d0';
    label.textContent = '🌑 BEREIT — SHIFT/E drücken!';
  } else {
    fill.style.background = '#6a4a9a';
    label.textContent = me.inShadow ? 'Im Schatten... lädt' : 'Im Licht — Schatten suchen zum Laden';
  }
}

function showOverlay(html) {
  const ov = document.getElementById('overlay');
  ov.style.display = 'flex';
  ov.innerHTML = html;
}

function hideOverlay() {
  document.getElementById('overlay').style.display = 'none';
}

// ---- WebSocket ----
function joinGame() {
  const name = document.getElementById('playerName').value.trim() || 'Spieler';
  const roomId = document.getElementById('roomId').value.trim() || 'default';

  document.getElementById('joinBtn').disabled = true;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', name, roomId }));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    showOverlay('<h2>Verbindung getrennt</h2><button onclick="location.reload()">Neu laden</button>');
  };

  ws.onerror = () => {
    document.getElementById('joinBtn').disabled = false;
    alert('Verbindung fehlgeschlagen. Ist der Server gestartet?');
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      myId = msg.playerId;
      map = msg.map;
      gameStarted = msg.gameStarted;
      gameOver = msg.gameOver;
      me.x = msg.spawn.x;
      me.y = msg.spawn.y;
      me.alive = true;
      meSpawned = true;
      resetSeen();

      document.getElementById('lobby').style.display = 'none';
      document.getElementById('game-container').style.display = 'flex';

      const roomId = document.getElementById('roomId').value || 'default';
      document.getElementById('room-link').innerHTML =
        `Raum-ID: <strong style="color:#b48cff">${roomId}</strong> — Teile diese ID mit Freunden!`;

      if (!gameStarted) {
        showOverlay(`
          <h2>Warte auf Spieler...</h2>
          <p style="color:#aaa">Mindestens 2 Spieler benötigt</p>
          <p style="color:#888; font-size:0.85rem">Raum: ${roomId}</p>
          <button onclick="sendAddBot()">🤖 Bot hinzufügen</button>
        `);
      } else {
        hideOverlay();
      }

      // Bots aus der Lobby-Auswahl anfordern
      const botCount = parseInt(document.getElementById('botCount').value, 10) || 0;
      for (let i = 0; i < botCount; i++) sendAddBot();

      if (!animFrame) animFrame = requestAnimationFrame(gameLoop);
      break;

    case 'shadow': {
      // The per-player filtered snapshot: only what we're allowed to see
      roster = msg.roster;
      bombs = msg.bombs;
      glows = msg.glows;
      powerups = msg.powerups;
      footprints = msg.footprints;
      lanterns = msg.lanterns;
      flashes = msg.flashes;
      noises = msg.noises;
      gameStarted = msg.gameStarted;
      gameOver = msg.gameOver;

      me.shadowMeter = msg.you.shadowMeter;
      me.shadowForm = msg.you.shadowForm;
      me.cooldownMs = msg.you.cooldownMs;
      me.lightRadius = msg.you.lightRadius;
      me.inShadow = msg.you.inShadow;
      me.speed = msg.you.speed;
      me.alive = msg.you.alive;

      // Update interpolation targets for visible players (self excluded:
      // our own position is client-side for responsiveness)
      const stillVisible = {};
      Object.values(msg.players).forEach(p => {
        if (p.id === myId) return;
        if (others[p.id]) {
          others[p.id].tx = p.x;
          others[p.id].ty = p.y;
          others[p.id].name = p.name;
        } else {
          others[p.id] = { x: p.x, y: p.y, tx: p.x, ty: p.y, color: p.color, name: p.name, id: p.id };
        }
        stillVisible[p.id] = true;
      });
      Object.keys(others).forEach(id => {
        if (!stillVisible[id]) delete others[id];
      });

      updateInfoBar();
      break;
    }

    case 'moveCorrection':
      me.x = msg.x;
      me.y = msg.y;
      break;

    case 'playerLeft':
      delete roster[msg.playerId];
      delete others[msg.playerId];
      updateInfoBar();
      break;

    case 'gameStarted':
      gameStarted = true;
      hideOverlay();
      break;

    case 'bombPlaced':
      // Own bomb: show immediately without waiting for the next snapshot
      if (!bombs.find(b => b.id === msg.bomb.id)) bombs.push(msg.bomb);
      break;

    case 'explosion':
      map = msg.map;
      bombs = bombs.filter(b =>
        !msg.explosion.cells.some(c => c.x === b.x && c.y === b.y));
      explosions.push(msg.explosion);
      setTimeout(() => {
        explosions = explosions.filter(e => e.id !== msg.explosion.id);
      }, 800);
      break;

    case 'playerDied':
      if (roster[msg.playerId]) roster[msg.playerId].alive = false;
      delete others[msg.playerId];
      if (msg.playerId === myId) {
        me.alive = false;
        showOverlay(`
          <h2 style="color:#e74c3c">Du bist gestorben!</h2>
          <p style="color:#aaa">Zuschauen...</p>
        `);
        setTimeout(hideOverlay, 2000);
      }
      updateInfoBar();
      break;

    case 'powerupCollected': {
      const labels = { bomb: '💣 +1 Bombe', flame: '🔥 Größere Flamme', speed: '👟 Schneller', torch: '🔦 Mehr Licht' };
      showPickupToast(labels[msg.powerupType] || '?');
      me.speed = msg.speed;
      me.lightRadius = msg.lightRadius;
      break;
    }

    case 'gameOver':
      gameOver = true;
      const isWinner = msg.winnerId === myId;
      showOverlay(`
        <h2 style="color:${isWinner ? '#2ecc71' : '#b48cff'}">${
          msg.winnerId === null ? 'Unentschieden!' :
          isWinner ? '🏆 Du gewinnst!' : `${msg.winnerName} gewinnt!`
        }</h2>
        <button onclick="restartGame()">Nochmal spielen</button>
      `);
      break;

    case 'restart':
      map = msg.map;
      gameStarted = msg.gameStarted;
      gameOver = false;
      me.x = msg.spawn.x;
      me.y = msg.spawn.y;
      me.alive = true;
      bombs = [];
      glows = [];
      explosions = [];
      others = {};
      footprints = [];
      resetSeen();
      if (gameStarted) hideOverlay();
      else showOverlay('<h2>Warte auf Spieler...</h2><button onclick="sendAddBot()">🤖 Bot hinzufügen</button>');
      break;

    case 'error':
      alert(msg.message);
      document.getElementById('joinBtn').disabled = false;
      break;
  }
}

let toastTimeout = null;
function showPickupToast(text) {
  const toast = document.getElementById('pickup-toast');
  if (!toast) return;
  toast.textContent = text;
  toast.style.opacity = '1';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.style.opacity = '0'; }, 1500);
}

function restartGame() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'restart' }));
  }
}

// Mobile controls
function addMobileControls() {
  if (!('ontouchstart' in window)) return;

  const style = document.createElement('style');
  style.textContent = `
    #mobile-controls {
      display: grid;
      grid-template-columns: repeat(3, 56px);
      grid-template-rows: repeat(3, 56px);
      gap: 4px;
      margin-top: 8px;
    }
    #mobile-controls button {
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      color: white;
      font-size: 1.4rem;
      padding: 0;
      border-radius: 8px;
    }
    #action-btns { display: flex; gap: 8px; margin-top: 8px; }
    #action-btns button { width: 110px; }
  `;
  document.head.appendChild(style);

  const mc = document.createElement('div');
  mc.id = 'mobile-controls';
  mc.innerHTML = `
    <div></div>
    <button ontouchstart="keys['ArrowUp']=true" ontouchend="keys['ArrowUp']=false">▲</button>
    <div></div>
    <button ontouchstart="keys['ArrowLeft']=true" ontouchend="keys['ArrowLeft']=false">◀</button>
    <div></div>
    <button ontouchstart="keys['ArrowRight']=true" ontouchend="keys['ArrowRight']=false">▶</button>
    <div></div>
    <button ontouchstart="keys['ArrowDown']=true" ontouchend="keys['ArrowDown']=false">▼</button>
    <div></div>
  `;

  const btns = document.createElement('div');
  btns.id = 'action-btns';

  const bombBtn = document.createElement('button');
  bombBtn.textContent = '💣 Bombe';
  bombBtn.addEventListener('touchstart', (e) => { e.preventDefault(); sendBomb(); });

  const shadowBtn = document.createElement('button');
  shadowBtn.textContent = '🌑 Schatten';
  shadowBtn.addEventListener('touchstart', (e) => { e.preventDefault(); sendShadowForm(); });

  btns.appendChild(bombBtn);
  btns.appendChild(shadowBtn);

  document.getElementById('game-container').appendChild(mc);
  document.getElementById('game-container').appendChild(btns);
}

addMobileControls();
