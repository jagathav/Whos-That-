// Client for Guess Who — Cartoon light style (UI only; server controls logic)
const socket = io();

// Deep link ?room=CODE
window.addEventListener('load', () => {
  const params = new URLSearchParams(window.location.search);
  const roomCode = params.get('room');
  if (roomCode) {
    showScreen('screen-home');
    document.querySelector('#roomCodeInput').value = roomCode.toUpperCase();
  }
});

const state = {
  you: { id: null, name: '' },
  room: null,
  category: null,
  characters: [],
  pendingFinalId: null,
};

// ===== Helpers / DOM =====
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
function showScreen(id){ $$('#app .screen').forEach(el => el.classList.remove('active')); document.getElementById(id).classList.add('active'); }
function showTopBar(show){ document.getElementById('topBar').classList.toggle('hidden', !show); }
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.remove('hidden'); setTimeout(()=>t.classList.add('hidden'), 1400); }

function sortPlayersByRanking(players = []) {
  return [...players].sort((a, b) => {
    const scoreA = a?.score ?? 0;
    const scoreB = b?.score ?? 0;
    if (scoreB !== scoreA) return scoreB - scoreA;

    const turnsA = (a?.correctGuesses ?? 0) > 0 ? (a?.totalTurnCount ?? 0) : Number.MAX_SAFE_INTEGER;
    const turnsB = (b?.correctGuesses ?? 0) > 0 ? (b?.totalTurnCount ?? 0) : Number.MAX_SAFE_INTEGER;
    if (turnsA !== turnsB) return turnsA - turnsB;

    const firstWinsA = a?.firstTurnWins ?? 0;
    const firstWinsB = b?.firstTurnWins ?? 0;
    if (firstWinsB !== firstWinsA) return firstWinsB - firstWinsA;

    const bonusA = a?.chooserBonus ?? 0;
    const bonusB = b?.chooserBonus ?? 0;
    if (bonusB !== bonusA) return bonusB - bonusA;

    const joinA = a?.joinIndex ?? Number.MAX_SAFE_INTEGER;
    const joinB = b?.joinIndex ?? Number.MAX_SAFE_INTEGER;
    return joinA - joinB;
  });
}

// Top bar refs
const roomGameLabel = $('#roomGameLabel');
const chooserName = $('#chooserName');
const turnName = $('#turnName');
const roundTimer = $('#roundTimer');
const youName = $('#youName');

// Home / Waiting
const nameInput = $('#nameInput');
const roomCodeInput = $('#roomCodeInput');
const setsInput = $('#setsInput');
const btnJoin = $('#btn-join');
const btnCreate = $('#btn-create');
const btnStart = $('#btn-start');
const btnLeaveWaiting = $('#btn-leave-waiting');
const roomCodeLabel = $('#roomCodeLabel');
const playersList = $('#playersList');
const copyLink = $('#copyLink');

// Chooser
const chooserGrid = $('#chooserGrid');
const btnConfirmCharacter = $('#btn-confirm-character');

// Game
const boardGrid = $('#boardGrid');
const scoreList = $('#scoreList');
const selectedName = $('#selectedName');

const chatLog = $('#chatLog');
const chatInput = $('#chatInput');
const askBtn = $('#askBtn');
const yesnoPanel = $('#yesnoPanel');
const btnYes = $('#btnYes');
const btnNo = $('#btnNo');
const decisionPanel = $('#decisionPanel');
const btnChooseGuess = $('#btnChooseGuess');
const btnPass = $('#btnPass');
const btnFinalGuess = $('#btnFinalGuess');
const answerBadge = $('#answerBadge');

const btnInviteGame = $('#btnInviteGame');
const btnExitGame = $('#btn-exit-game');
const btnPlayAgain = $('#btn-play-again');
const btnCloseOver = $('#btn-close-over');
const winnerName = $('#winnerName');

// ===== Navigation =====
btnCreate.addEventListener('click', () => {
  const name = (nameInput.value || 'Host').trim();
  const totalSets = Math.max(1, Number(setsInput?.value || 1));
  state.you.name = name;
  socket.emit('createRoom', { name, totalSets });
});

btnJoin.addEventListener('click', () => {
  const name = (nameInput.value || 'Player').trim();
  const code = (roomCodeInput.value || '').trim().toUpperCase();
  if (!code) return alert('Enter a room code.');
  state.you.name = name;
  socket.emit('joinRoom', { name, roomCode: code });
});

btnStart.addEventListener('click', () => {
  if (!state.room) return;
  socket.emit('startGame', { roomCode: state.room.code });
});

btnLeaveWaiting.addEventListener('click', () => {
  if (!state.room) { showScreen('screen-home'); return; }
  socket.emit('leaveRoom', { roomCode: state.room.code });
  showScreen('screen-home');
  showTopBar(false);
});

copyLink.addEventListener('click', () => {
  if (!state.room) return;
  const link = `${location.origin}/?room=${state.room.code}`;
  navigator.clipboard.writeText(link).then(()=> toast('Invite link copied ✅'), ()=>alert('Copy failed'));
});

btnInviteGame.addEventListener('click', () => {
  if (!state.room) return;
  const link = `${location.origin}/?room=${state.room.code}`;
  navigator.clipboard.writeText(link).then(()=> toast('Invite link copied ✅'), ()=>alert('Copy failed'));
});

btnExitGame.addEventListener('click', () => {
  if (!state.room) { showScreen('screen-home'); return; }
  socket.emit('leaveRoom', { roomCode: state.room.code });
  showScreen('screen-home');
  showTopBar(false);
});

btnPlayAgain?.addEventListener('click', () => {
  if (!state.room?.code) return;
  const isHost = !!state.room?.players?.find(p => p.id === state.you.id && p.isHost);
  if (!isHost) {
    toast('Only the host can restart the game.');
    return;
  }
  btnPlayAgain.disabled = true;
  socket.emit('playAgain', { roomCode: state.room.code });
});

btnCloseOver?.addEventListener('click', () => {
  if (state.room?.code) {
    socket.emit('leaveRoom', { roomCode: state.room.code });
  }
  state.room = null;
  state.category = null;
  state.characters = [];
  state.pendingFinalId = null;
  showScreen('screen-home');
  showTopBar(false);
  scoreList.innerHTML = '';
  playersList.innerHTML = '';
  boardGrid.innerHTML = '';
  selectedName.textContent = '—';
});

// ===== Chooser selection =====
let chooserPick = null;
btnConfirmCharacter.addEventListener('click', () => {
  if (!chooserPick || !state.room) return;
  socket.emit('characterChosen', { roomCode: state.room.code, characterId: chooserPick });
});

// ===== Ask / Answer / Guess flow (UI only) =====
askBtn.addEventListener('click', () => {
  if (!state.room) return;
  const q = chatInput.value.trim();
  if (!q) return;
  socket.emit('makeQuestion', { roomCode: state.room.code, question: q });
  chatInput.value = '';
});

btnYes.addEventListener('click', () => {
  if (!state.room) return;
  socket.emit('answerQuestion', { roomCode: state.room.code, answer: 'yes' });
});
btnNo.addEventListener('click', () => {
  if (!state.room) return;
  socket.emit('answerQuestion', { roomCode: state.room.code, answer: 'no' });
});

btnChooseGuess.addEventListener('click', () => {
  decisionPanel.classList.add('hidden');
  btnFinalGuess.disabled = !state.pendingFinalId;
});

btnPass.addEventListener('click', () => {
  decisionPanel.classList.add('hidden');
  socket.emit('passTurn', { roomCode: state.room.code });
});

btnFinalGuess.addEventListener('click', () => {
  if (!state.pendingFinalId) return;
  socket.emit('makeGuess', { roomCode: state.room.code, characterId: state.pendingFinalId });
});

// ===== Socket events =====
socket.on('connect', () => { state.you.id = socket.id; });

socket.on('errorMsg', (msg) => {
  pushSystem(msg);
  if (document.getElementById('screen-over')?.classList.contains('active')) {
    const isHost = !!state.room?.players?.find(p => p.id === state.you.id && p.isHost);
    if (isHost) {
      btnPlayAgain?.removeAttribute('disabled');
    }
  }
});

socket.on('roomJoined', ({ room }) => {
  state.room = room;
  roomCodeLabel.textContent = room.code;
  renderPlayers(room);
  updateTopbar(room);
  showScreen('screen-waiting');
  showTopBar(false);
});

socket.on('roomUpdate', (room) => {
  state.room = room;
  renderPlayers(room);
  renderScores(room);
  updateTopbar(room);
  updatePermissions();
  updateTimer(room.timeLeft || 0);
});

socket.on('systemMsg', (text) => pushSystem(text));

socket.on('chooserAssigned', (payload = {}) => {
  if (payload.category) state.category = payload.category;
  if (Array.isArray(payload.characters)) state.characters = payload.characters;
  renderChooserGrid();
  showScreen('screen-chooser');
  showTopBar(false);
  // Re-enable Play Again button if we're coming from game over
  if (btnPlayAgain) btnPlayAgain.removeAttribute('disabled');
});

socket.on('gameStarted', ({ room, category, characters }) => {
  state.room = room;
  if (category) state.category = category;
  if (Array.isArray(characters)) state.characters = characters;
  renderScores(room);
  renderBoard();
  updateTopbar(room);
  updatePermissions();
  showScreen('screen-game');
  showTopBar(true);
  // Re-enable Play Again button if we're coming from game over
  if (btnPlayAgain) btnPlayAgain.removeAttribute('disabled');
});

socket.on('chatMsg', ({ from, text }) => {
  const me = (from === state.you.id);
  const div = document.createElement('div');
  div.className = 'msg ' + (me ? 'you' : 'opp');
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;

  if (/^Yes|^No/.test(text)) {
    answerBadge.classList.remove('hidden');
    answerBadge.textContent = 'Answer: ' + text;
  }
});

socket.on('awaitAnswer', () => {
  if (state.room?.chooserId === state.you.id) yesnoPanel.classList.remove('hidden');
});

socket.on('decisionPhase', () => {
  yesnoPanel.classList.add('hidden');
  decisionPanel.classList.remove('hidden');
});

socket.on('roundTimer', ({ timeLeft }) => updateTimer(timeLeft));

// Optional: server may signal a new set before chooser picks
socket.on('newSet', ({ category, characters, room }) => {
  if (room) state.room = room;
  if (category) state.category = category;
  if (Array.isArray(characters)) state.characters = characters;
  // Only refresh if already in-game; waiting/chooser screens will render as flow continues
  const inGame = document.getElementById('screen-game')?.classList.contains('active');
  if (inGame) {
    renderBoard();
    renderScores(state.room);
    updateTopbar(state.room);
    updatePermissions();
  }
});

socket.on('gameOver', ({ leaderboard }) => {
  const players = leaderboard || [];
  const top3 = players.slice(0, 3);
  const rest = players.slice(3);

  let html = '<div class="podium-container">';
  
  // Podium for top 3
  if (top3.length > 0) {
    html += '<div class="podium-row">';
    
    // 2nd place (left)
    if (top3[1]) {
      html += `
        <div class="podium podium-silver">
          <div class="podium-avatar">🥈</div>
          <div class="podium-name">${top3[1].name}</div>
          <div class="podium-score">${top3[1].score ?? 0}</div>
        </div>`;
    } else {
      html += '<div class="podium-placeholder"></div>';
    }
    
    // 1st place (center, tallest)
    html += `
      <div class="podium podium-gold">
        <div class="podium-avatar">🥇</div>
        <div class="podium-name">${top3[0].name}</div>
        <div class="podium-score">${top3[0].score ?? 0}</div>
      </div>`;
    
    // 3rd place (right)
    if (top3[2]) {
      html += `
        <div class="podium podium-bronze">
          <div class="podium-avatar">🥉</div>
          <div class="podium-name">${top3[2].name}</div>
          <div class="podium-score">${top3[2].score ?? 0}</div>
        </div>`;
    } else {
      html += '<div class="podium-placeholder"></div>';
    }
    
    html += '</div>';
  }
  
  // Rest of players below podium
  if (rest.length > 0) {
    html += '<div class="podium-rest">';
    html += '<h3>Ranks 4+</h3>';
    html += '<div class="podium-rest-list">';
    rest.forEach((p, i) => {
      html += `
        <div class="podium-rest-item">
          <span class="podium-rest-rank">#${i + 4}</span>
          <span class="podium-rest-name">${p.name}</span>
          <span class="podium-rest-score">${p.score ?? 0}</span>
        </div>`;
    });
    html += '</div></div>';
  }
  
  html += '</div>';
  
  // Add confetti/sparkles
  html += '<div class="confetti-container"></div>';
  
  winnerName.innerHTML = html;
  showScreen('screen-over');
  showTopBar(false);
  const isHost = !!state.room?.players?.find(p => p.id === state.you.id && p.isHost);
  if (btnPlayAgain) {
    if (isHost) {
      btnPlayAgain.removeAttribute('disabled');
    } else {
      btnPlayAgain.setAttribute('disabled', 'disabled');
    }
  }
  
  // Trigger animation
  setTimeout(() => {
    const podiums = document.querySelectorAll('.podium');
    podiums.forEach((p, i) => {
      setTimeout(() => {
        p.style.animation = 'podiumRise 0.6s ease-out forwards';
      }, i * 100);
    });
  }, 100);
  
  // Create confetti effect
  createConfetti();
});

socket.on('playAgainReady', ({ room }) => {
  if (room) {
    state.room = room;
    roomCodeLabel.textContent = room.code;
    renderPlayers(room);
    renderScores(room);
    updateTopbar(room);
  }
  winnerName.innerHTML = '';
  btnPlayAgain?.setAttribute('disabled', 'disabled');
  showScreen('screen-waiting');
  showTopBar(false);
  toast('New game starting!');
});

// ===== Renders =====
function renderPlayers(room){
  playersList.innerHTML = '';
  room.players.forEach(p => {
    const div = document.createElement('div');
    div.className = 'player';
    div.innerHTML = `
      <div class="avatar">${p.id === room.chooserId ? '🎯' : '🧑'}</div>
      <div>
        <div class="name">${p.name}${p.isHost ? ' (Host)' : ''}</div>
        <div class="score">Score: ${p.score ?? room.scores?.[p.id] ?? 0}</div>
      </div>`;
    playersList.appendChild(div);
  });
  const isHost = !!room.players.find(p => p.id === state.you.id && p.isHost);
  btnStart.style.display = isHost ? 'inline-flex' : 'none';
}

function renderScores(room){
  scoreList.innerHTML = '';
  if (!room?.players) return;
  const sorted = sortPlayersByRanking(room.players);
  if (!sorted.length) return;

  sorted.forEach((p, idx) => {
    const item = document.createElement('div');
    item.className = 'score-item';
    const tag = (p.id === room.chooserId) ? '<span class="tag">Chooser</span>' : `<span class="tag">#${idx+1}</span>`;
    item.innerHTML = `
      <div class="who">${tag} <span>${p.name}</span></div>
      <b>${p.score ?? 0}</b>`;
    scoreList.appendChild(item);
  });
}

function renderChooserGrid() {
  chooserGrid.innerHTML = '';
  state.characters.forEach(ch => {
    const card = document.createElement('div');
    card.className = 'card-char';
    card.innerHTML = `
      <button class="rotate-btn" tabindex="-1" aria-label="flip">🔄</button>
      <div class="flip">
        <div class="face">
          <div style="font-size:36px">${ch.emoji}</div>
          <div class="nameTag">${ch.name}</div>
        </div>
        <div class="back">❌</div>
      </div>`;
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('rotate-btn')) return;
      chooserPick = ch.id;
      $$('#chooserGrid .card-char').forEach(n => n.classList.remove('selected'));
      card.classList.add('selected');
      btnConfirmCharacter.disabled = false;
    });
    // 🔄 button flips card
    const rotateBtn = card.querySelector('.rotate-btn');
    const flipEl = card.querySelector('.flip');
    rotateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      flipEl.classList.toggle('flipped');
    });
    
    chooserGrid.appendChild(card);
  });
}

function renderBoard() {
  boardGrid.innerHTML = '';
  state.pendingFinalId = null;
  selectedName.textContent = '—';
  answerBadge.classList.add('hidden');

  state.characters.forEach(ch => {
    const card = document.createElement('div');
    card.className = 'card-char';
    card.dataset.id = ch.id;
    card.innerHTML = `
      <button class="rotate-btn" tabindex="-1" aria-label="flip">🔄</button>
      <div class="flip">
        <div class="face">
          <div style="font-size:36px">${ch.emoji}</div>
          <div class="nameTag">${ch.name}</div>
        </div>
        <div class="back">❌</div>
      </div>`;

    // Click card = select final guess target
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('rotate-btn')) return;
      $$('#boardGrid .card-char').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      state.pendingFinalId = ch.id;
      selectedName.textContent = ch.name;
      updatePermissions();
    });

    // 🔄 button flips card (only the button, not clicking the card)
    const rotateBtn = card.querySelector('.rotate-btn');
    const flipEl = card.querySelector('.flip');
    rotateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      flipEl.classList.toggle('flipped');
    });

    boardGrid.appendChild(card);
  });
}

function updateTopbar(room){
  roomGameLabel.textContent = room.code || '—';
  chooserName.textContent = getPlayerName(room.chooserId);
  turnName.textContent = getPlayerName(room.turnId);
  youName.textContent = getPlayerName(state.you.id);
}

// Permissions: chat only during awaitingQuestion on your turn; guess any time during your turn once selected
function updatePermissions(){
  const room = state.room || {};
  const yourTurn = room.turnId === state.you.id;
  const youAreChooser = room.chooserId === state.you.id;

  const canAsk = yourTurn && !youAreChooser && room.roundPhase === 'awaitingQuestion';
  chatInput.disabled = !canAsk;
  askBtn.disabled = !canAsk;

  const showYN = youAreChooser && room.roundPhase === 'awaitingAnswer';
  yesnoPanel.classList.toggle('hidden', !showYN);

  decisionPanel.classList.add('hidden');

  btnFinalGuess.disabled = !(yourTurn && !youAreChooser && state.pendingFinalId);
  btnChooseGuess.disabled = btnFinalGuess.disabled;
}

function updateTimer(t){
  roundTimer.textContent = `⏱️ ${Math.max(0,t)}s`;
  if (t <= 10) roundTimer.classList.add('warn'); else roundTimer.classList.remove('warn');
}

function pushSystem(text){
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function getPlayerName(id){
  const p = state.room?.players?.find(pl => pl.id === id);
  return p ? p.name : '—';
}

function createConfetti() {
  const container = document.querySelector('.confetti-container');
  if (!container) return;
  
  const colors = ['#ff7ac6', '#7acbff', '#77e0a2', '#ffd166', '#ff9b9b'];
  const count = 50;
  
  for (let i = 0; i < count; i++) {
    const confetti = document.createElement('div');
    confetti.className = 'confetti';
    confetti.style.left = Math.random() * 100 + '%';
    confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    confetti.style.animationDelay = Math.random() * 2 + 's';
    confetti.style.animationDuration = (Math.random() * 2 + 2) + 's';
    container.appendChild(confetti);
    
    setTimeout(() => confetti.remove(), 4000);
  }
}
