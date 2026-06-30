const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

const rooms = new Map();
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const SUITS = [
  { value: '♥', label: 'Hearts' },
  { value: '♦', label: 'Diamonds' },
  { value: '♣', label: 'Clubs' },
  { value: '♠', label: 'Spades' },
];

function code() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function createDeck() {
  const deck = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      deck.push({ rank, suit: suit.value, suitName: suit.label, label: `${rank}${suit.value}` });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  const copy = deck.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, alive: p.alive, host: p.host, submitted: !!p.submission, eliminatedThisRound: !!p.eliminatedThisRound };
}

function getRoom(roomCode) {
  return rooms.get(String(roomCode || '').trim().toUpperCase());
}

function alivePlayers(room) {
  return Array.from(room.players.values()).filter(p => p.alive);
}

function aliveJack(room) {
  return alivePlayers(room).find(p => p.role === 'jack');
}

function buildPlayerState(room, playerId) {
  const me = room.players.get(playerId);
  const players = Array.from(room.players.values()).map(publicPlayer);
  const alive = alivePlayers(room);
  const visibleCards = {};

  for (const p of room.players.values()) {
    if (room.phase !== 'playing' || !p.alive || !p.card) {
      visibleCards[p.id] = null;
    } else if (p.id === playerId) {
      visibleCards[p.id] = { hidden: true };
    } else {
      visibleCards[p.id] = p.card;
    }
  }

  return {
    roomCode: room.code,
    phase: room.phase,
    round: room.round,
    players,
    aliveCount: alive.length,
    you: me ? { id: me.id, name: me.name, alive: me.alive, host: me.host, role: me.role, submitted: !!me.submission } : null,
    visibleCards,
    publicLog: room.publicLog.slice(-50),
    systemLog: room.systemLog.slice(-20),
    roundResolved: room.roundResolved,
    winner: room.winner,
    settings: room.settings,
  };
}

function emitRoom(room) {
  for (const p of room.players.values()) {
    io.to(p.id).emit('state', buildPlayerState(room, p.id));
  }
}

function logSystem(room, text) {
  room.systemLog.push({ at: Date.now(), text });
}

function createRoom(hostSocketId, hostName) {
  let roomCode = code();
  while (rooms.has(roomCode)) roomCode = code();
  const room = {
    code: roomCode,
    phase: 'lobby',
    round: 0,
    players: new Map(),
    publicLog: [],
    systemLog: [],
    roundResolved: false,
    winner: null,
    settings: {
      minPlayers: 3,
      maxPlayers: 12,
      declareMode: 'full-card',
      jackWinsAt: 2,
    }
  };
  rooms.set(roomCode, room);
  addPlayer(room, hostSocketId, hostName, true);
  logSystem(room, `${hostName} created the room.`);
  return room;
}

function addPlayer(room, socketId, name, host = false) {
  const cleanName = String(name || 'Player').trim().slice(0, 24) || 'Player';
  room.players.set(socketId, {
    id: socketId,
    name: cleanName,
    host,
    alive: true,
    role: null,
    card: null,
    submission: null,
    eliminatedThisRound: false,
  });
}

function startGame(room) {
  const players = Array.from(room.players.values());
  if (players.length < room.settings.minPlayers) {
    return { ok: false, error: `You need at least ${room.settings.minPlayers} players.` };
  }
  room.phase = 'playing';
  room.round = 0;
  room.winner = null;
  room.roundResolved = false;
  room.publicLog = [];
  room.systemLog = [];
  for (const p of players) {
    p.alive = true;
    p.role = 'citizen';
    p.card = null;
    p.submission = null;
    p.eliminatedThisRound = false;
  }
  const jack = players[Math.floor(Math.random() * players.length)];
  jack.role = 'jack';
  logSystem(room, 'Solitary Confinement has started. One prisoner is the Jack of Hearts.');
  newRound(room);
  return { ok: true };
}

function newRound(room) {
  room.round += 1;
  room.roundResolved = false;
  for (const p of room.players.values()) {
    p.eliminatedThisRound = false;
    p.submission = null;
    p.card = null;
  }
  const deck = shuffleDeck(createDeck());
  for (const p of alivePlayers(room)) {
    p.card = deck.pop();
  }
  logSystem(room, `Round ${room.round} began. A real shuffled deck was dealt: no duplicate cards this round.`);
}

function endIfFinished(room) {
  const jack = aliveJack(room);
  const alive = alivePlayers(room);
  if (!jack) {
    room.phase = 'ended';
    room.winner = 'Prisoners win. The Jack of Hearts was eliminated.';
    logSystem(room, room.winner);
    return true;
  }
  if (alive.length <= room.settings.jackWinsAt) {
    room.phase = 'ended';
    room.winner = `Jack wins. The final shadow survived until ${alive.length} players remained in solitary confinement.`;
    logSystem(room, room.winner);
    return true;
  }
  return false;
}

function resolveRound(room) {
  if (room.phase !== 'playing' || room.roundResolved) return;
  const alive = alivePlayers(room);
  if (!alive.every(p => p.submission)) return;

  const eliminated = [];
  for (const p of alive) {
    const correct = p.submission === p.card.label;
    if (!correct) {
      p.alive = false;
      p.eliminatedThisRound = true;
      eliminated.push(p.name);
    }
  }
  room.roundResolved = true;
  if (eliminated.length) {
    logSystem(room, `Game over for: ${eliminated.join(', ')}.`);
  } else {
    logSystem(room, 'Everyone survived this round.');
  }
  endIfFinished(room);
}

function findPlayerRoom(socketId) {
  for (const room of rooms.values()) {
    if (room.players.has(socketId)) return room;
  }
  return null;
}

io.on('connection', socket => {
  socket.on('createRoom', ({ name }) => {
    const existing = findPlayerRoom(socket.id);
    if (existing) existing.players.delete(socket.id);
    const room = createRoom(socket.id, name);
    socket.join(room.code);
    emitRoom(room);
  });

  socket.on('joinRoom', ({ roomCode, name }) => {
    const room = getRoom(roomCode);
    if (!room) return socket.emit('toast', 'Room not found.');
    if (room.phase !== 'lobby') return socket.emit('toast', 'This room is already in game.');
    if (room.players.size >= room.settings.maxPlayers) return socket.emit('toast', 'Room is full.');
    const existing = findPlayerRoom(socket.id);
    if (existing) existing.players.delete(socket.id);
    addPlayer(room, socket.id, name, false);
    socket.join(room.code);
    logSystem(room, `${name || 'A player'} joined.`);
    emitRoom(room);
  });

  socket.on('startGame', () => {
    const room = findPlayerRoom(socket.id);
    if (!room) return;
    const me = room.players.get(socket.id);
    if (!me.host) return socket.emit('toast', 'Only the host can start.');
    const res = startGame(room);
    if (!res.ok) socket.emit('toast', res.error);
    emitRoom(room);
  });

  socket.on('publicMessage', (text) => {
    const room = findPlayerRoom(socket.id);
    if (!room) return;
    const p = room.players.get(socket.id);
    const clean = String(text || '').trim().slice(0, 500);
    if (!clean) return;
    if (!p.alive) return socket.emit('toast', 'Eliminated players cannot communicate.');
    room.publicLog.push({ at: Date.now(), from: p.name, text: clean, dead: false });
    emitRoom(room);
  });

  socket.on('privateMessage', ({ to, text }) => {
    const room = findPlayerRoom(socket.id);
    if (!room) return;
    const from = room.players.get(socket.id);
    const target = room.players.get(to);
    const clean = String(text || '').trim().slice(0, 500);
    if (!target || !clean) return;
    if (!from.alive) return socket.emit('toast', 'Eliminated players cannot communicate.');
    if (!target.alive) return socket.emit('toast', 'You cannot whisper to an eliminated player.');
    const payload = { at: Date.now(), from: from.name, fromId: from.id, to: target.name, toId: target.id, text: clean };
    io.to(target.id).emit('privateMessage', payload);
    io.to(from.id).emit('privateMessage', payload);
  });

  socket.on('tellCard', ({ to, cardLabel }) => {
    const room = findPlayerRoom(socket.id);
    if (!room) return;
    const from = room.players.get(socket.id);
    const target = room.players.get(to);
    const label = String(cardLabel || '').trim().slice(0, 4);
    if (!target || !label) return;
    if (room.phase !== 'playing' || room.roundResolved) return socket.emit('toast', 'Card claims are only allowed during a live round.');
    if (!from.alive) return socket.emit('toast', 'Eliminated players cannot communicate.');
    if (!target.alive) return socket.emit('toast', 'You cannot tell cards to an eliminated player.');
    const payload = {
      at: Date.now(),
      from: from.name,
      fromId: from.id,
      to: target.name,
      toId: target.id,
      text: `I tell you: your card is ${label}.`,
      cardTell: true,
    };
    io.to(target.id).emit('privateMessage', payload);
    io.to(from.id).emit('privateMessage', payload);
  });

  socket.on('submitCard', ({ cardLabel }) => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.phase !== 'playing' || room.roundResolved) return;
    const p = room.players.get(socket.id);
    if (!p.alive) return;
    p.submission = String(cardLabel || '').trim();
    logSystem(room, `${p.name} locked a declaration.`);
    resolveRound(room);
    emitRoom(room);
  });

  socket.on('nextRound', () => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.phase !== 'playing') return;
    const me = room.players.get(socket.id);
    if (!me.host) return socket.emit('toast', 'Only the host can advance the round.');
    if (!room.roundResolved) return socket.emit('toast', 'Resolve the current round first.');
    if (endIfFinished(room)) return emitRoom(room);
    newRound(room);
    emitRoom(room);
  });

  socket.on('resetRoom', () => {
    const room = findPlayerRoom(socket.id);
    if (!room) return;
    const me = room.players.get(socket.id);
    if (!me.host) return;
    room.phase = 'lobby';
    room.round = 0;
    room.winner = null;
    room.roundResolved = false;
    for (const p of room.players.values()) {
      p.alive = true;
      p.role = null;
      p.card = null;
      p.submission = null;
      p.eliminatedThisRound = false;
    }
    logSystem(room, 'Room reset to lobby.');
    emitRoom(room);
  });

  socket.on('disconnect', () => {
    const room = findPlayerRoom(socket.id);
    if (!room) return;
    const p = room.players.get(socket.id);
    room.players.delete(socket.id);
    logSystem(room, `${p.name} disconnected.`);
    if (p.host && room.players.size) {
      const next = room.players.values().next().value;
      next.host = true;
      logSystem(room, `${next.name} is now host.`);
    }
    if (!room.players.size) rooms.delete(room.code);
    else emitRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Solitary Confinement app running on http://localhost:${PORT}`));
