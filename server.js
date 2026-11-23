'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game } = require('./game');
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
const rooms = new Map(); // code -> room

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

function broadcast(room) {
  room.lastActive = Date.now();
  room.seats.forEach((s, i) => {
    if (!s || !s.ws) return;
    send(s.ws, {
      t: 'state',
      room: {
        code: room.code,
        seat: i,
        names: room.seats.map((x, k) => (x ? x.name : `Joueur ${k + 1}`)),
        connected: room.seats.map((x) => !!x && (x.bot || !!x.ws)),
        started: !!room.game,
        rematch: room.rematch,
        vsBot: room.seats.some((x) => x && x.bot),
      },
      game: room.game ? room.game.view(i) : null,
    });
  });
}

function startGame(room) {
  room.game = new Game(room.seats.map((s) => s.name));
  room.rematch = [false, false];
  broadcast(room);
  scheduleBot(room);
}

function scheduleBot(room) {
  const g = room.game;
  if (!g || room.botTimer || g.phase === 'over') return;
  const seat = room.seats.findIndex((s) => s && s.bot);
  if (seat < 0 || !botNeedsToAct(g, seat)) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (room.game !== g || g.phase === 'over' || !botNeedsToAct(g, seat)) return;
    const mv = botMove(g.view(seat));
    const r = g.act(seat, mv);
    if (r.error) {
      console.error('Erreur du bot :', r.error, JSON.stringify(mv));
      return;
    }
    broadcast(room);
    scheduleBot(room);
  }, g.phase === 'play' ? 1400 : 700);
}

function attach(room, seat, ws) {
  const s = room.seats[seat];
  if (s.ws && s.ws !== ws) {
    s.ws.ctx = null;
    s.ws.close();
  }
  s.ws = ws;
  ws.ctx = { room, seat };
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
        const room = { code: newCode(), seats: [null, null], game: null, rematch: [false, false], botTimer: null, lastActive: Date.now() };
        const token = crypto.randomBytes(12).toString('hex');
        room.seats[0] = { token, name: cleanName(m.name, 'Joueur 1'), ws: null, bot: false };
        rooms.set(room.code, room);
        attach(room, 0, ws);
        send(ws, { t: 'joined', code: room.code, token });
        broadcast(room);
        break;
      }

      case 'vsbot': {
        if (ctx) return;
        const room = { code: newCode(), seats: [null, null], game: null, rematch: [false, false], botTimer: null, lastActive: Date.now() };
        const token = crypto.randomBytes(12).toString('hex');
        room.seats[0] = { token, name: cleanName(m.name, 'Joueur 1'), ws: null, bot: false };
        room.seats[1] = { token: null, name: 'Ordinateur', ws: null, bot: true };
        rooms.set(room.code, room);
        attach(room, 0, ws);
        send(ws, { t: 'joined', code: room.code, token });
        startGame(room);
        break;
      }

      case 'join': {
        if (ctx) return;
        const room = rooms.get(String(m.code || '').trim().toUpperCase());
        if (!room) return send(ws, { t: 'error', msg: 'Salon introuvable. Vérifiez le code.' });
        if (room.seats[1]) return send(ws, { t: 'error', msg: 'Ce salon est déjà complet.' });
        const token = crypto.randomBytes(12).toString('hex');
        room.seats[1] = { token, name: cleanName(m.name, 'Joueur 2'), ws: null, bot: false };
        attach(room, 1, ws);
        send(ws, { t: 'joined', code: room.code, token });
        startGame(room);
        break;
      }

      case 'resume': {
        if (ctx) return;
        const room = rooms.get(String(m.code || '').toUpperCase());
        const seat = room ? room.seats.findIndex((s) => s && !s.bot && s.token === m.token) : -1;
        if (seat < 0) return send(ws, { t: 'resume_failed' });
        attach(room, seat, ws);
        send(ws, { t: 'joined', code: room.code, token: m.token });
        broadcast(room);
        break;
      }

      case 'act': {
        if (!ctx || !ctx.room.game) return;
        const r = ctx.room.game.act(ctx.seat, m.a);
        if (r.error) return send(ws, { t: 'error', msg: r.error });
        broadcast(ctx.room);
        scheduleBot(ctx.room);
        break;
      }

      case 'rematch': {
        if (!ctx || !ctx.room.game || ctx.room.game.phase !== 'over') return;
        const room = ctx.room;
        room.rematch[ctx.seat] = true;
        room.seats.forEach((s, i) => s && s.bot && (room.rematch[i] = true));
        if (room.rematch[0] && room.rematch[1]) startGame(room);
        else broadcast(room);
        break;
      }

      case 'leave': {
        if (!ctx) return;
        const { room, seat } = ctx;
        ws.ctx = null;
        clearTimeout(room.botTimer);
        rooms.delete(room.code);
        room.seats.forEach((s, i) => {
          if (s && i !== seat && s.ws) {
            s.ws.ctx = null;
            send(s.ws, { t: 'closed', msg: `${room.seats[seat].name} a quitté la partie.` });
          }
        });
        send(ws, { t: 'closed' });
        break;
      }
    }
  });

  ws.on('close', () => {
    const ctx = ws.ctx;
    if (!ctx) return;
    const s = ctx.room.seats[ctx.seat];
    if (s && s.ws === ws) {
      s.ws = null;
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
    const anyone = room.seats.some((s) => s && s.ws);
    if (!anyone && now - room.lastActive > 2 * 3600 * 1000) {
      clearTimeout(room.botTimer);
      rooms.delete(code);
    }
  }
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Jeu disponible sur http://localhost:${PORT}`));
