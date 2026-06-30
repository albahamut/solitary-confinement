const socket = io();

const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const SUITS = [
  { value: '♥', name: 'Hearts' },
  { value: '♦', name: 'Diamonds' },
  { value: '♣', name: 'Clubs' },
  { value: '♠', name: 'Spades' },
];

let state = null;
let lastAlive = true;
let privateMessages = [];
let currentTab = 'public';

const $ = (id) => document.getElementById(id);

function initSelects() {
  for (const id of ['rankSelect', 'tellRankSelect']) {
    $(id).innerHTML = RANKS.map(r => `<option value="${r}">${r}</option>`).join('');
  }
  for (const id of ['suitSelect', 'tellSuitSelect']) {
    $(id).innerHTML = SUITS.map(s => `<option value="${s.value}">${s.name} ${s.value}</option>`).join('');
  }
}
initSelects();

function savedName() {
  return localStorage.getItem('sc_name') || '';
}
$('playerName').value = savedName();

function playerName() {
  const name = $('playerName').value.trim() || `Player-${Math.floor(Math.random()*999)}`;
  localStorage.setItem('sc_name', name);
  return name;
}

function showToast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('hidden'), 3000);
}

$('createBtn').addEventListener('click', () => socket.emit('createRoom', { name: playerName() }));
$('joinBtn').addEventListener('click', () => {
  const roomCode = $('roomCodeInput').value.trim();
  if (!roomCode) return showToast('Enter a room code.');
  socket.emit('joinRoom', { roomCode, name: playerName() });
});
$('startBtn').addEventListener('click', () => socket.emit('startGame'));
$('nextRoundBtn').addEventListener('click', () => socket.emit('nextRound'));
$('resetBtn').addEventListener('click', () => socket.emit('resetRoom'));

$('publicForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('publicInput').value;
  $('publicInput').value = '';
  if (!state?.you?.alive) return showToast('Eliminated players cannot communicate.');
  socket.emit('publicMessage', text);
});

$('privateSendBtn').addEventListener('click', () => {
  const to = $('privateTarget').value;
  const text = $('privateInput').value;
  if (!state?.you?.alive) return showToast('Eliminated players cannot communicate.');
  if (!to) return showToast('No available prisoners to whisper to.');
  if (!text.trim()) return;
  $('privateInput').value = '';
  socket.emit('privateMessage', { to, text });
});

$('tellCardBtn').addEventListener('click', () => {
  const to = $('privateTarget').value;
  if (!state?.you?.alive) return showToast('Eliminated players cannot communicate.');
  if (!to) return showToast('No available prisoners to tell.');
  const cardLabel = $('tellRankSelect').value + $('tellSuitSelect').value;
  socket.emit('tellCard', { to, cardLabel });
});

$('submitBtn').addEventListener('click', () => {
  const cardLabel = $('rankSelect').value + $('suitSelect').value;
  socket.emit('submitCard', { cardLabel });
});

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    currentTab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tabpane').forEach(p => p.classList.remove('active'));
    $(`${currentTab}Tab`).classList.add('active');
  });
});

socket.on('toast', showToast);
socket.on('privateMessage', (msg) => {
  privateMessages.push(msg);
  renderPrivateLog();
});
socket.on('state', (s) => {
  const wasInGame = state?.phase === 'playing';
  const wasAlive = state?.you?.alive;
  state = s;
  if (wasInGame && wasAlive && state.you && !state.you.alive) {
    showCollarAnimation(state.you.name);
  }
  render();
});

function render() {
  if (!state) return;
  $('welcomeScreen').classList.add('hidden');
  $('gameScreen').classList.remove('hidden');
  $('roomCode').textContent = state.roomCode;
  $('phaseTitle').textContent = phaseTitle();
  $('roundPill').textContent = `Round ${state.round}`;
  
  if (state.phase === 'lobby') {
    $('alivePill').textContent = `${state.players.length} player${state.players.length === 1 ? '' : 's'}`;
  } else {
    $('alivePill').textContent = `${state.aliveCount} alive`;
  }
  const rolePill = $('rolePill');
  rolePill.className = 'pill';
  if (state.phase === 'playing' || state.phase === 'ended') {
    rolePill.textContent = state.you.role === 'jack' ? 'You are the Jack ♥' : 'You are a Prisoner';
    rolePill.classList.add(state.you.role === 'jack' ? 'role-jack' : 'role-citizen');
  } else {
    rolePill.textContent = 'Role hidden';
    rolePill.classList.add('role-hidden');
  }
  renderPlayers();
  renderCards();
  renderChats();
  renderControls();
  renderTargets();
}

function phaseTitle() {
  if (state.winner) return 'Game Ended';
  if (state.phase === 'lobby') return 'Lobby';
  if (state.phase === 'playing') return state.roundResolved ? 'Round Resolved' : 'Solitary Confinement In Progress';
  return 'Ended';
}

function renderPlayers() {
  $('playersList').innerHTML = state.players.map(p => `
    <div class="player-row ${p.alive ? '' : 'dead'}">
      <div class="player-left">
        <div class="avatar">${escapeHtml(p.name[0]?.toUpperCase() || '?')}</div>
        <div>
          <div class="player-name">${escapeHtml(p.name)} ${p.host ? '★' : ''}</div>
          <div class="badge ${p.alive ? 'alive' : 'dead'}">${p.alive ? (p.submitted ? 'locked' : 'alive') : 'eliminated'}</div>
        </div>
      </div>
    </div>
  `).join('');
}

function renderCards() {
  const grid = $('cardsGrid');
  const cards = state.players.map(p => {
    const card = state.visibleCards[p.id];
    const me = state.you.id === p.id;
    let cardHtml = '';
    if (state.phase === 'lobby') {
      cardHtml = `<div class="playing-card hidden-card"><span class="big">?</span></div>`;
    } else if (!p.alive && !p.eliminatedThisRound) {
      cardHtml = `<div class="playing-card hidden-card"><span class="big">✕</span></div>`;
    } else if (card?.hidden) {
      cardHtml = `<div class="playing-card hidden-card"><span class="big">?</span></div>`;
    } else if (card) {
      const red = card.suit === '♥' || card.suit === '♦';
      cardHtml = `<div class="playing-card ${red ? 'red' : ''}"><span class="corner">${card.label}</span><span class="big">${card.suit}</span><span class="corner br">${card.label}</span></div>`;
    } else {
      cardHtml = `<div class="playing-card hidden-card"><span class="big">—</span></div>`;
    }
    return `
      <div class="card-holder ${me ? 'me' : ''} ${p.alive ? '' : 'dead'}">
        ${cardHtml}
        <div class="holder-name">${escapeHtml(p.name)}${me ? ' · you' : ''}</div>
        ${p.submitted ? `<div class="submitted">declaration locked</div>` : ''}
      </div>
    `;
  }).join('');
  grid.innerHTML = cards || `<p>No players yet.</p>`;
  $('winnerBanner').classList.toggle('hidden', !state.winner);
  $('winnerBanner').textContent = state.winner || '';
}

function renderControls() {
  const isHost = state.you?.host;
  const canCommunicate = !!state.you?.alive;
  const playerCount = state.players.length;
  const minPlayers = state.settings?.minPlayers || 3;

  $('startBtn').classList.toggle('hidden', !(isHost && state.phase === 'lobby'));
  $('startBtn').disabled = state.phase === 'lobby' && playerCount < minPlayers;
  $('startBtn').textContent = playerCount < minPlayers ? `Need ${minPlayers} Players` : 'Start Game';

  $('nextRoundBtn').classList.toggle('hidden', !(isHost && state.phase === 'playing' && state.roundResolved && !state.winner));
  $('resetBtn').classList.toggle('hidden', !isHost);

  const canDeclare = state.phase === 'playing' && state.you.alive && !state.roundResolved && !state.you.submitted;
  $('declarePanel').classList.toggle('hidden', !canDeclare);

  const hasTargets = state.players.some(p => p.id !== state.you.id && p.alive);

  $('publicInput').disabled = !canCommunicate;
  $('publicForm').querySelector('button').disabled = !canCommunicate;
  $('privateInput').disabled = !canCommunicate || !hasTargets;
  $('privateSendBtn').disabled = !canCommunicate || !hasTargets;
  $('tellCardBtn').disabled = !canCommunicate || !hasTargets || state.phase !== 'playing' || state.roundResolved;
  $('privateTarget').disabled = !canCommunicate || !hasTargets;

  document.querySelector('.private-controls')?.classList.toggle('no-target', !hasTargets);
  document.querySelector('.tell-card-box')?.classList.toggle('no-target', !hasTargets);
}

function renderTargets() {
  const targets = state.players.filter(p => p.id !== state.you.id && p.alive);
  if (!targets.length) {
    $('privateTarget').innerHTML = `<option value="">No available prisoners</option>`;
    return;
  }
  $('privateTarget').innerHTML = targets.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
}

function renderChats() {
  $('publicLog').innerHTML = state.publicLog.map(m => `
    <div class="msg">
      <span class="meta">${time(m.at)} · ${escapeHtml(m.from)}${m.dead ? ' · eliminated' : ''}</span>
      ${escapeHtml(m.text)}
    </div>
  `).join('') || `<div class="msg system">No public messages yet.</div>`;
  $('systemLog').innerHTML = state.systemLog.map(m => `
    <div class="msg system"><span class="meta">${time(m.at)}</span>${escapeHtml(m.text)}</div>
  `).join('') || `<div class="msg system">Waiting...</div>`;
  renderPrivateLog();
  scrollLogs();
}

function renderPrivateLog() {
  const me = state?.you?.id;
  $('privateLog').innerHTML = privateMessages.map(m => `
    <div class="msg private">
      <span class="meta">${time(m.at)} · ${m.fromId === me ? 'You' : escapeHtml(m.from)} → ${m.toId === me ? 'You' : escapeHtml(m.to)}</span>
      ${escapeHtml(m.text)}
    </div>
  `).join('') || `<div class="msg system">No secret cell whispers yet.</div>`;
}

function scrollLogs() {
  for (const id of ['publicLog', 'systemLog', 'privateLog']) {
    const el = $(id);
    if (el) el.scrollTop = el.scrollHeight;
  }
}

function showCollarAnimation(name) {
  $('collarName').textContent = `${name} · Game Over`;
  const overlay = $('collarOverlay');
  overlay.classList.remove('hidden');
  setTimeout(() => overlay.classList.add('hidden'), 1800);
}

function time(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}
