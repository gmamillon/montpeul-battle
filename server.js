'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game, MODES } = require('./game');
const { botMove, botNeedsToAct } = require('./bot');

const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end('Interdit');
    return;
  }
  fs.readFile(file, (e, data) => {
    if (e) return res.writeHead(404).end('Introuvable');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
// code -> room. room.seats : un élément par joueur, dans l'ordre des tours.
const rooms = new Map();

const send = (ws, obj) => ws && ws.readyState === 1 && ws.send(JSON.stringify(obj));
const cleanName = (n, fallback) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || fallback;

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(c)) return c;
  }
}

const newHuman = (name) => ({ token: crypto.randomBytes(12).toString('hex'), name, ws: null, bot: false, left: false, rematch: false });

function newBot(room) {
  let name = 'Ordinateur';
  if (room.mode !== 'duel') {
    let k = 1;
    while (room.seats.some((s) => s.name === `Ordi ${k}`)) k++;
    name = `Ordi ${k}`;
  }
  return { token: null, name, ws: null, bot: true, left: false, rematch: false };
}

// L'hôte est le premier humain encore présent.
const hostOf = (room) => room.seats.find((s) => !s.bot && !s.left);

function broadcast(room) {
  room.lastActive = Date.now();
  const host = hostOf(room);
  room.seats.forEach((s, i) => {
    if (!s.ws) return;
    send(s.ws, {
      t: 'state',
      room: {
        code: room.code,
        mode: room.mode,
        seat: i,
        isHost: s === host,
        minPlayers: MODES[room.mode].minPlayers,
        maxPlayers: MODES[room.mode].maxPlayers,
        names: room.seats.map((x) => x.name),
        bots: room.seats.map((x) => x.bot),
        left: room.seats.map((x) => x.left),
        connected: room.seats.map((x) => x.bot || !!x.ws),
        rematch: room.seats.map((x) => x.rematch),
      },
      game: room.game ? room.game.view(i) : null,
    });
  });
}

function startGame(room) {
  clearTimeout(room.botTimer);
  room.botTimer = null;
  room.seats = room.seats.filter((s) => !s.left);
  room.seats.forEach((s) => (s.rematch = false));
  // Plus assez de joueurs : retour au salon d'attente.
  room.game =
    room.seats.length >= MODES[room.mode].minPlayers
      ? new Game(room.seats.map((s) => s.name), { mode: room.mode })
      : null;
  broadcast(room);
  scheduleBot(room);
}

function scheduleBot(room) {
  const g = room.game;
  if (!g || room.botTimer || g.phase === 'over') return;
  const seat = room.seats.findIndex((s, i) => s.bot && botNeedsToAct(g, i));
  if (seat < 0) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (room.game !== g) return;
    if (!botNeedsToAct(g, seat)) return scheduleBot(room);
    const mv = botMove(g.view(seat));
    const r = g.act(seat, mv);
    if (r.error) {
      console.error('Erreur du bot :', r.error, JSON.stringify(mv));
      return;
    }
    broadcast(room);
    scheduleBot(room);
  }, g.phase === 'play' ? 1400 : 400);
}

function closeRoom(room, leaver) {
  clearTimeout(room.botTimer);
  rooms.delete(room.code);
  for (const s of room.seats) {
    if (s !== leaver && s.ws) {
      s.ws.ctx = null;
      send(s.ws, { t: 'closed', msg: `${leaver.name} a quitté la partie.` });
    }
  }
}

// Relance la partie quand tous les humains présents l'ont demandé.
function maybeRematch(room) {
  const humans = room.seats.filter((s) => !s.bot && !s.left);
  if (humans.every((s) => s.rematch)) startGame(room);
  else broadcast(room);
}

function leaveRoom(room, player) {
  // Duel : la partie n'a plus de sens sans l'un des deux joueurs.
  if (room.mode === 'duel') return closeRoom(room, player);
  if (!room.game) {
    if (player === hostOf(room)) return closeRoom(room, player);
    room.seats.splice(room.seats.indexOf(player), 1);
    return broadcast(room);
  }
  // Mêlée en cours : le joueur abandonne et les autres continuent.
  const seat = room.seats.indexOf(player);
  Object.assign(player, { left: true, token: null, ws: null, rematch: false });
  if (!room.seats.some((s) => !s.bot && !s.left)) {
    clearTimeout(room.botTimer);
    rooms.delete(room.code);
    return;
  }
  if (room.game.phase === 'over') return maybeRematch(room);
  room.game.forfeit(seat);
  broadcast(room);
  scheduleBot(room);
}

function attach(room, player, ws) {
  if (player.ws && player.ws !== ws) {
    player.ws.ctx = null;
    player.ws.close();
  }
  player.ws = ws;
  ws.ctx = { room, player };
}

function createRoom(ws, m) {
  const mode = Object.hasOwn(MODES, m.mode) ? m.mode : 'duel';
  const room = { code: newCode(), mode, seats: [], game: null, botTimer: null, lastActive: Date.now() };
  const player = newHuman(cleanName(m.name, 'Joueur 1'));
  room.seats.push(player);
  rooms.set(room.code, room);
  attach(room, player, ws);
  send(ws, { t: 'joined', code: room.code, token: player.token });
  return room;
}

wss.on('connection', (ws) => {
  ws.ctx = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    const ctx = ws.ctx;

    switch (m.t) {
      case 'create': {
        if (ctx) return;
        broadcast(createRoom(ws, m));
        break;
      }

      case 'vsbot': {
        if (ctx) return;
        const room = createRoom(ws, m);
        room.seats.push(newBot(room));
        // En duel on joue tout de suite ; en mêlée on peut d'abord ajouter d'autres ordinateurs.
        if (room.mode === 'duel') startGame(room);
        else broadcast(room);
        break;
      }

      case 'join': {
        if (ctx) return;
        const room = rooms.get(String(m.code || '').trim().toUpperCase());
        if (!room) return send(ws, { t: 'error', msg: 'Salon introuvable. Vérifiez le code.' });
        if (room.seats.length >= MODES[room.mode].maxPlayers) return send(ws, { t: 'error', msg: 'Ce salon est déjà complet.' });
        if (room.game) return send(ws, { t: 'error', msg: 'La partie a déjà commencé.' });
        const player = newHuman(cleanName(m.name, `Joueur ${room.seats.length + 1}`));
        room.seats.push(player);
        attach(room, player, ws);
        send(ws, { t: 'joined', code: room.code, token: player.token });
        if (room.mode === 'duel') startGame(room);
        else broadcast(room);
        break;
      }

      // Salon d'attente de la mêlée (réservé à l'hôte).
      case 'addbot':
      case 'removebot':
      case 'start': {
        if (!ctx || ctx.room.game || ctx.room.mode === 'duel') return;
        const { room, player } = ctx;
        if (player !== hostOf(room)) return;
        const { minPlayers, maxPlayers } = MODES[room.mode];
        if (m.t === 'start') {
          if (room.seats.length >= minPlayers) startGame(room);
          return;
        }
        if (m.t === 'addbot' && room.seats.length < maxPlayers) room.seats.push(newBot(room));
        if (m.t === 'removebot' && room.seats[m.seat]?.bot) room.seats.splice(m.seat, 1);
        broadcast(room);
        break;
      }

      case 'resume': {
        if (ctx) return;
        const room = rooms.get(String(m.code || '').toUpperCase());
        const player = room && typeof m.token === 'string' ? room.seats.find((s) => !s.bot && s.token === m.token) : null;
        if (!player) return send(ws, { t: 'resume_failed' });
        attach(room, player, ws);
        send(ws, { t: 'joined', code: room.code, token: m.token });
        broadcast(room);
        break;
      }

      case 'act': {
        if (!ctx || !ctx.room.game) return;
        const { room, player } = ctx;
        const r = room.game.act(room.seats.indexOf(player), m.a);
        if (r.error) return send(ws, { t: 'error', msg: r.error });
        broadcast(room);
        scheduleBot(room);
        break;
      }

      case 'rematch': {
        if (!ctx || !ctx.room.game || ctx.room.game.phase !== 'over') return;
        ctx.player.rematch = true;
        maybeRematch(ctx.room);
        break;
      }

      case 'leave': {
        if (!ctx) return;
        ws.ctx = null;
        leaveRoom(ctx.room, ctx.player);
        send(ws, { t: 'closed' });
        break;
      }
    }
  });

  ws.on('close', () => {
    const ctx = ws.ctx;
    if (!ctx) return;
    if (ctx.player.ws === ws) {
      ctx.player.ws = null;
      broadcast(ctx.room);
    }
  });
});

// Heartbeat + nettoyage des salons abandonnés.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = room.seats.some((s) => s.ws);
    if (!anyone && now - room.lastActive > 2 * 3600 * 1000) {
      clearTimeout(room.botTimer);
      rooms.delete(code);
    }
  }
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Jeu disponible sur http://localhost:${PORT}`));
