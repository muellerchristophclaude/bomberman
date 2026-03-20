// Game constants (must match server.js)
const GRID_WIDTH = 15;
const GRID_HEIGHT = 13;
const CELL_SIZE = 40;

const TILE_EMPTY = 0;
const TILE_WALL = 1;
const TILE_BLOCK = 2;

// Color palette
const COLORS = {
  bg: '#1a1a2e',
  empty: '#2d2d4e',
  wall: '#0f3460',
  block: '#8B6914',
  blockHighlight: '#c49a1e',
  blockShadow: '#5a4208',
  explosion: '#ff6b35',
  explosionCenter: '#ffffff',
  flame: '#ff4500',
};

// State
let ws = null;
let myId = null;
let gameState = {
  players: {},
  bombs: [],
  explosions: [],
  powerups: [],
  map: [],
  gameStarted: false,
  gameOver: false,
};
let myPlayer = null;
let animFrame = null;
let keys = {};

// Input
const moveKeys = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
  W: [0, -1], S: [0, 1], A: [-1, 0], D: [1, 0],
};

document.addEventListener('keydown', (e) => {
  if (keys[e.key]) return;
  keys[e.key] = true;
  if (e.key === ' ') {
    e.preventDefault();
    sendBomb();
  }
});
document.addEventListener('keyup', (e) => { keys[e.key] = false; });

let lastMoveTime = 0;
const MOVE_INTERVAL = 50; // ms between move updates

function gameLoop(ts) {
  animFrame = requestAnimationFrame(gameLoop);

  if (ts - lastMoveTime > MOVE_INTERVAL && myId !== null) {
    handleMovement();
    lastMoveTime = ts;
  }

  render();
}

function handleMovement() {
  const player = gameState.players[myId];
  if (!player || !player.alive || !gameState.gameStarted) return;

  const speed = player.speed || 0.08;
  let dx = 0, dy = 0;

  for (const [key, [kx, ky]] of Object.entries(moveKeys)) {
    if (keys[key]) { dx += kx; dy += ky; }
  }

  if (dx === 0 && dy === 0) return;

  // Normalize diagonal
  if (dx !== 0 && dy !== 0) {
    dx *= 0.707;
    dy *= 0.707;
  }

  let nx = player.x + dx * speed * 12;
  let ny = player.y + dy * speed * 12;
  nx = Math.max(0.5, Math.min(GRID_WIDTH - 1.5, nx));
  ny = Math.max(0.5, Math.min(GRID_HEIGHT - 1.5, ny));

  if (!checkLocalCollision(nx, ny)) {
    player.x = nx;
    player.y = ny;
    ws.send(JSON.stringify({ type: 'move', x: nx, y: ny }));
  } else {
    // Try sliding along walls
    const nx2 = player.x + dx * speed * 12;
    if (!checkLocalCollision(nx2, player.y)) {
      player.x = nx2;
      player.y = player.y;
      ws.send(JSON.stringify({ type: 'move', x: nx2, y: player.y }));
    } else {
      const ny2 = player.y + dy * speed * 12;
      if (!checkLocalCollision(player.x, ny2)) {
        player.x = player.x;
        player.y = ny2;
        ws.send(JSON.stringify({ type: 'move', x: player.x, y: ny2 }));
      }
    }
  }
}

function checkLocalCollision(x, y) {
  const tileX = Math.round(x);
  const tileY = Math.round(y);
  if (tileX < 0 || tileX >= GRID_WIDTH || tileY < 0 || tileY >= GRID_HEIGHT) return true;
  if (!gameState.map[tileY]) return true;
  return gameState.map[tileY][tileX] !== TILE_EMPTY;
}

function sendBomb() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'placeBomb' }));
  }
}

// ---- Rendering ----
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
canvas.width = GRID_WIDTH * CELL_SIZE;
canvas.height = GRID_HEIGHT * CELL_SIZE;

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!gameState.map.length) return;

  drawMap();
  drawPowerups();
  drawBombs();
  drawExplosions();
  drawPlayers();
}

function drawMap() {
  for (let y = 0; y < GRID_HEIGHT; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      const px = x * CELL_SIZE;
      const py = y * CELL_SIZE;
      const tile = gameState.map[y] ? gameState.map[y][x] : 0;

      if (tile === TILE_WALL) {
        // Stone wall
        ctx.fillStyle = '#1c3a6b';
        ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
        ctx.fillStyle = '#0d2445';
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        // Highlight
        ctx.fillStyle = '#2a5299';
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, 3);
        ctx.fillRect(px + 2, py + 2, 3, CELL_SIZE - 4);
      } else if (tile === TILE_BLOCK) {
        // Destructible block
        ctx.fillStyle = COLORS.block;
        ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
        ctx.fillStyle = COLORS.blockHighlight;
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, 4);
        ctx.fillRect(px + 2, py + 2, 4, CELL_SIZE - 4);
        ctx.fillStyle = COLORS.blockShadow;
        ctx.fillRect(px + 2, py + CELL_SIZE - 6, CELL_SIZE - 4, 4);
        ctx.fillRect(px + CELL_SIZE - 6, py + 2, 4, CELL_SIZE - 4);
      } else {
        // Floor
        ctx.fillStyle = COLORS.empty;
        ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
        // Grid lines
        ctx.strokeStyle = '#252545';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(px, py, CELL_SIZE, CELL_SIZE);
      }
    }
  }
}

function drawPowerups() {
  gameState.powerups.forEach(pu => {
    const px = pu.x * CELL_SIZE + CELL_SIZE / 2;
    const py = pu.y * CELL_SIZE + CELL_SIZE / 2;
    const r = CELL_SIZE * 0.3;

    ctx.save();
    ctx.translate(px, py);

    // Glow
    const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, r + 6);
    if (pu.type === 'bomb') {
      grd.addColorStop(0, 'rgba(255,100,50,0.4)');
      grd.addColorStop(1, 'transparent');
    } else if (pu.type === 'flame') {
      grd.addColorStop(0, 'rgba(255,200,0,0.4)');
      grd.addColorStop(1, 'transparent');
    } else {
      grd.addColorStop(0, 'rgba(100,255,100,0.4)');
      grd.addColorStop(1, 'transparent');
    }
    ctx.fillStyle = grd;
    ctx.fillRect(-r - 6, -r - 6, (r + 6) * 2, (r + 6) * 2);

    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = pu.type === 'bomb' ? '#ff6432' : pu.type === 'flame' ? '#ffc800' : '#64ff64';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = `bold ${r * 1.1}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pu.type === 'bomb' ? '💣' : pu.type === 'flame' ? '🔥' : '👟', 0, 0);

    ctx.restore();
  });
}

function drawBombs() {
  const t = Date.now();
  gameState.bombs.forEach(bomb => {
    const px = bomb.x * CELL_SIZE + CELL_SIZE / 2;
    const py = bomb.y * CELL_SIZE + CELL_SIZE / 2;
    const pulse = Math.sin(t / 200) * 0.15 + 0.85;
    const r = CELL_SIZE * 0.38 * pulse;

    ctx.save();
    ctx.translate(px, py);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(3, 6, r * 0.8, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = '#111';
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Shine
    ctx.beginPath();
    ctx.arc(-r * 0.3, -r * 0.3, r * 0.25, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fill();

    // Fuse
    ctx.strokeStyle = '#8B6914';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(r * 0.4, -r * 0.6);
    ctx.quadraticCurveTo(r * 0.8, -r * 1.2, r * 0.3, -r * 1.5);
    ctx.stroke();

    // Spark
    ctx.fillStyle = '#ff0';
    ctx.beginPath();
    ctx.arc(r * 0.3, -r * 1.5, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  });
}

function drawExplosions() {
  gameState.explosions.forEach(exp => {
    exp.cells.forEach(cell => {
      const px = cell.x * CELL_SIZE;
      const py = cell.y * CELL_SIZE;

      // Outer glow
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

function drawPlayers() {
  Object.values(gameState.players).forEach(player => {
    if (!player.alive) return;

    const px = player.x * CELL_SIZE;
    const py = player.y * CELL_SIZE;
    const cx = px + CELL_SIZE / 2;
    const cy = py + CELL_SIZE / 2;
    const r = CELL_SIZE * 0.38;

    ctx.save();
    ctx.translate(cx, cy);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(3, r * 0.7, r * 0.7, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = player.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Face shine
    ctx.beginPath();
    ctx.arc(-r * 0.25, -r * 0.25, r * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fill();

    // Eyes
    ctx.fillStyle = '#fff';
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
    const nameW = ctx.measureText(player.name).width + 8;
    ctx.fillRect(-nameW / 2, -r - 20, nameW, 16);
    ctx.fillStyle = '#fff';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(player.name, 0, -r - 12);

    // "ME" indicator
    if (player.id === myId) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(0, 0, r + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  });
}

// ---- UI Updates ----
function updateInfoBar() {
  const bar = document.getElementById('info-bar');
  bar.innerHTML = '';

  Object.values(gameState.players).forEach(p => {
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
      gameState.players = msg.players;
      gameState.map = msg.map;
      gameState.bombs = msg.bombs;
      gameState.explosions = msg.explosions;
      gameState.powerups = msg.powerups;
      gameState.gameStarted = msg.gameStarted;
      gameState.gameOver = msg.gameOver;

      document.getElementById('lobby').style.display = 'none';
      document.getElementById('game-container').style.display = 'flex';

      const roomId = document.getElementById('roomId').value || 'default';
      document.getElementById('room-link').innerHTML =
        `Raum-ID: <strong style="color:#f39c12">${roomId}</strong> — Teile diese ID mit Freunden!`;

      if (!gameState.gameStarted) {
        showOverlay(`
          <h2>Warte auf Spieler...</h2>
          <p style="color:#aaa">Mindestens 2 Spieler benötigt</p>
          <p style="color:#888; font-size:0.85rem">Raum: ${roomId}</p>
        `);
      } else {
        hideOverlay();
      }

      updateInfoBar();
      if (!animFrame) animFrame = requestAnimationFrame(gameLoop);
      break;

    case 'playerJoined':
      gameState.players[msg.player.id] = msg.player;
      updateInfoBar();
      break;

    case 'playerLeft':
      delete gameState.players[msg.playerId];
      updateInfoBar();
      break;

    case 'gameStarted':
      gameState.gameStarted = true;
      hideOverlay();
      updateInfoBar();
      break;

    case 'playerMoved':
      if (gameState.players[msg.playerId]) {
        gameState.players[msg.playerId].x = msg.x;
        gameState.players[msg.playerId].y = msg.y;
      }
      break;

    case 'bombPlaced':
      gameState.bombs.push(msg.bomb);
      break;

    case 'explosion':
      gameState.bombs = gameState.bombs.filter(b =>
        !msg.explosion.cells.some(c => c.x === b.x && c.y === b.y));
      gameState.explosions.push(msg.explosion);
      gameState.map = msg.map;
      gameState.powerups = msg.powerups;
      setTimeout(() => {
        gameState.explosions = gameState.explosions.filter(e => e.id !== msg.explosion.id);
      }, 800);
      break;

    case 'playerDied':
      if (gameState.players[msg.playerId]) {
        gameState.players[msg.playerId].alive = false;
        if (msg.playerId === myId) {
          // Show "you died" but keep watching
          showOverlay(`
            <h2 style="color:#e74c3c">Du bist gestorben!</h2>
            <p style="color:#aaa">Zuschauen...</p>
          `);
          setTimeout(hideOverlay, 2000);
        }
      }
      updateInfoBar();
      break;

    case 'powerupCollected':
      gameState.powerups = gameState.powerups.filter(p => p.id !== msg.powerupId);
      if (gameState.players[msg.playerId]) {
        gameState.players[msg.playerId].maxBombs = msg.maxBombs;
        gameState.players[msg.playerId].flameSize = msg.flameSize;
        gameState.players[msg.playerId].speed = msg.speed;
      }
      updateInfoBar();
      break;

    case 'gameState':
      gameState.players = msg.players;
      gameState.map = msg.map;
      gameState.bombs = msg.bombs;
      gameState.explosions = msg.explosions;
      gameState.powerups = msg.powerups;
      gameState.gameStarted = msg.gameStarted;
      gameState.gameOver = msg.gameOver;
      updateInfoBar();
      if (gameState.gameStarted && !gameState.gameOver) hideOverlay();
      break;

    case 'gameOver':
      gameState.gameOver = true;
      const isWinner = msg.winnerId === myId;
      showOverlay(`
        <h2 style="color:${isWinner ? '#2ecc71' : '#f39c12'}">${
          msg.winnerId === null ? 'Unentschieden!' :
          isWinner ? '🏆 Du gewinnst!' : `${msg.winnerName} gewinnt!`
        }</h2>
        <button onclick="restartGame()">Nochmal spielen</button>
      `);
      break;

    case 'error':
      alert(msg.message);
      document.getElementById('joinBtn').disabled = false;
      break;
  }
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
    #bomb-btn {
      margin-top: 8px;
      width: 120px;
    }
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

  const bombBtn = document.createElement('button');
  bombBtn.id = 'bomb-btn';
  bombBtn.textContent = '💣 Bombe';
  bombBtn.addEventListener('touchstart', (e) => { e.preventDefault(); sendBomb(); });

  document.getElementById('game-container').appendChild(mc);
  document.getElementById('game-container').appendChild(bombBtn);
}

addMobileControls();
