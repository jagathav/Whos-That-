
import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));
const PORT = process.env.PORT || 3000;

// ========== ROOM MANAGEMENT ==========
const rooms = new Map();

// ========== CATEGORY REGISTRY (scalable) ==========
const CATEGORIES = {
  animals: [
    { emoji: "🐶", name: "Dog" }, { emoji: "🐱", name: "Cat" }, { emoji: "🦊", name: "Fox" }, { emoji: "🐻", name: "Bear" },
    { emoji: "🐼", name: "Panda" }, { emoji: "🐨", name: "Koala" }, { emoji: "🐯", name: "Tiger" }, { emoji: "🦁", name: "Lion" },
    { emoji: "🐵", name: "Monkey" }, { emoji: "🦄", name: "Unicorn" }, { emoji: "🐷", name: "Pig" }, { emoji: "🐸", name: "Frog" },
    { emoji: "🐔", name: "Chicken" }, { emoji: "🦆", name: "Duck" }, { emoji: "🦉", name: "Owl" }, { emoji: "🦓", name: "Zebra" },
    { emoji: "🦒", name: "Giraffe" }, { emoji: "🐘", name: "Elephant" }, { emoji: "🐹", name: "Hamster" }, { emoji: "🐰", name: "Rabbit" }
  ],
  players: [
    { emoji: "🧔", name: "Alex" }, { emoji: "👩‍🦱", name: "Mia" }, { emoji: "👨‍🦰", name: "Leo" }, { emoji: "👩‍🦳", name: "Sophia" },
    { emoji: "👨‍🦲", name: "Victor" }, { emoji: "👩‍🦰", name: "Emma" }, { emoji: "🧑‍🦰", name: "Noah" }, { emoji: "🧑‍🦱", name: "Ava" },
    { emoji: "🧑‍🦲", name: "Zane" }, { emoji: "🧔‍♂️", name: "Chris" }, { emoji: "👩", name: "Lara" }, { emoji: "👨", name: "Ryan" },
    { emoji: "👩‍🦰", name: "Ella" }, { emoji: "👩‍🦲", name: "Nina" }, { emoji: "🧔‍♂️", name: "Mark" }, { emoji: "👩‍🦳", name: "Iris" },
    { emoji: "👨‍🦱", name: "Ethan" }, { emoji: "👩‍🦱", name: "Ruby" }, { emoji: "👨‍🦰", name: "Owen" }, { emoji: "👩‍🦰", name: "Maya" }
  ],
  celebrities: [
    { emoji: "🎤", name: "Singer" }, { emoji: "🎬", name: "Actor" }, { emoji: "⚽", name: "Footballer" }, { emoji: "🏀", name: "Hooper" },
    { emoji: "🎧", name: "DJ" }, { emoji: "🎻", name: "Violinist" }, { emoji: "🎸", name: "Guitarist" }, { emoji: "🎹", name: "Pianist" },
    { emoji: "🏎️", name: "Racer" }, { emoji: "🏊", name: "Swimmer" }, { emoji: "🏏", name: "Cricketer" }, { emoji: "🤹", name: "Performer" },
    { emoji: "🎮", name: "Streamer" }, { emoji: "📰", name: "Host" }, { emoji: "📚", name: "Author" }, { emoji: "🧪", name: "Scientist" },
    { emoji: "🏈", name: "Quarterback" }, { emoji: "🎯", name: "Archer" }, { emoji: "🥊", name: "Boxer" }, { emoji: "🤡", name: "Comedian" }
  ]
};

function pickRandomCategory() {
  const keys = Object.keys(CATEGORIES);
  return keys[Math.floor(Math.random() * keys.length)];
}

function buildCharactersFromCategory(category, size = 20) {
  const items = CATEGORIES[category] || [];
  const pool = [...items];
  while (pool.length < size && items.length) pool.push(...items);
  const take = pool.slice(0, size);
  return take.map((c, i) => ({
    id: `${category}-${i + 1}`,
    emoji: c.emoji,
    name: c.name
  }));
}

function prepareNewSet(room) {
  const category = pickRandomCategory();
  const characters = buildCharactersFromCategory(category, 20);
  room.category = category;
  room.characters = characters;
  room.secretCharacterId = null;
  resetRoundTracking(room);
  saveRoom(room);
  // Notify clients that a new set has started (clients may ignore if not in-game)
  io.to(room.code).emit("newSet", { category, characters, room: sanitizeRoom(room) });
}

function resetRoomForPlayAgain(room) {
  stopTimer(room);
  room.status = "waiting";
  room.currentRound = 1;
  room.currentSet = 1;
  room.chooserId = null;
  room.turnId = null;
  room.secretCharacterId = null;
  room.hasChosen = {};
  room.correctGuessOrder = [];
  room.guessedCorrect = new Set();
  room.activeOrder = [];
  room.roundPhase = "awaitingQuestion";
  room.timeLeft = 0;
  room.category = null;
  room.characters = [];
  resetRoundTracking(room);
  room.playerStats = {};
  room.scores = {};
  room.totalRounds = room.players.length;

  room.players.forEach((p) => {
    const stats = ensurePlayerStats(room, p.id);
    stats.score = 0;
    stats.correctGuesses = 0;
    stats.totalTurnCount = 0;
    stats.firstTurnWins = 0;
    stats.chooserBonus = 0;
    room.scores[p.id] = 0;
  });
}

const TURN_POINT_TABLE = [0, 1000, 800, 600, 400, 300, 200];
const TURN_MIN_POINTS = 100;
const CHOOSER_BONUS_RATIO = 0.5;
const CHOOSER_TOO_EASY_PENALTY = 200;
const CHOOSER_PITY_BONUS = 200;

function getPointsForTurn(turnNumber) {
  if (turnNumber <= 0) return TURN_POINT_TABLE[1];
  if (turnNumber < TURN_POINT_TABLE.length) return TURN_POINT_TABLE[turnNumber];
  const additionalTurns = turnNumber - (TURN_POINT_TABLE.length - 1);
  const deduction = additionalTurns * 100;
  return Math.max(TURN_MIN_POINTS, TURN_POINT_TABLE[TURN_POINT_TABLE.length - 1] - deduction);
}

function ensurePlayerStats(room, playerId) {
  if (!room.playerStats) room.playerStats = {};
  if (!room.playerStats[playerId]) {
    room.playerStats[playerId] = {
      score: room.scores?.[playerId] || 0,
      correctGuesses: 0,
      totalTurnCount: 0,
      firstTurnWins: 0,
      chooserBonus: 0,
    };
  } else if (room.scores && room.scores[playerId] == null) {
    room.scores[playerId] = room.playerStats[playerId].score;
  }
  if (!room.scores) room.scores = {};
  if (room.scores[playerId] == null) room.scores[playerId] = room.playerStats[playerId].score;
  return room.playerStats[playerId];
}

function recordJoinOrder(room, playerId) {
  if (!room.joinOrder) room.joinOrder = [];
  if (!room.joinOrder.includes(playerId)) room.joinOrder.push(playerId);
}

function removeFromJoinOrder(room, playerId) {
  if (!room?.joinOrder) return;
  room.joinOrder = room.joinOrder.filter((id) => id !== playerId);
}

function getJoinIndex(room, playerId) {
  if (!room.joinOrder) return Number.MAX_SAFE_INTEGER;
  const idx = room.joinOrder.indexOf(playerId);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

function resetRoundTracking(room) {
  room.roundTurnCounts = {};
  room.roundGuessTurns = {};
  room.lastTurnId = null;
}

function markTurnStart(room, playerId, advanced = false) {
  if (!playerId) return;
  if (!room.roundTurnCounts) room.roundTurnCounts = {};
  if (!room.roundTurnCounts[playerId]) room.roundTurnCounts[playerId] = 0;

  const shouldIncrement =
    advanced || room.lastTurnId !== playerId;

  if (shouldIncrement) {
    room.roundTurnCounts[playerId] += 1;
    room.lastTurnId = playerId;
  }
}

function genRoomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  if (rooms.has(s)) return genRoomCode();
  return s;
}

function getRoom(code) {
  return rooms.get(code);
}

function saveRoom(room) {
  rooms.set(room.code, room);
}

function getPlayerName(room, id) {
  const p = room.players.find((pl) => pl.id === id);
  return p ? p.name : "Player";
}

function broadcastRoomUpdate(room) {
  io.to(room.code).emit("roomUpdate", sanitizeRoom(room));
}

function sanitizeRoom(room) {
  return {
    code: room.code,
    status: room.status,
    currentRound: room.currentRound,
    totalRounds: room.totalRounds,
    currentSet: room.currentSet,
    totalSets: room.totalSets,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      ...playerPublicStats(room, p.id),
    })),
    chooserId: room.chooserId,
    turnId: room.turnId,
    roundPhase: room.roundPhase,
    timeLeft: room.timeLeft ?? 0,
    // keep UI unchanged; including category is harmless for clients
    category: room.category
  };
}

function playerPublicStats(room, playerId) {
  const stats = ensurePlayerStats(room, playerId);
  const averageTurn =
    stats.correctGuesses > 0
      ? Number((stats.totalTurnCount / stats.correctGuesses).toFixed(2))
      : null;
  return {
    score: stats.score,
    correctGuesses: stats.correctGuesses,
    avgTurn: averageTurn,
    totalTurnCount: stats.totalTurnCount,
    firstTurnWins: stats.firstTurnWins,
    chooserBonus: stats.chooserBonus,
    joinIndex: getJoinIndex(room, playerId),
  };
}

// ========== TIMER ==========
function startRoundTimer(room) {
  stopTimer(room);
  room.timeLeft = 60;
  io.to(room.code).emit("roundTimer", { timeLeft: room.timeLeft });

  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(room.code).emit("roundTimer", { timeLeft: room.timeLeft });

    if (room.timeLeft <= 0) {
      io.to(room.code).emit("systemMsg", "⏱️ Time’s up! Auto-pass.");
      stopTimer(room);
      handlePass(room);
    }
  }, 1000);
}

function stopTimer(room) {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
}

// ========== PLAYER LEAVE HANDLING ==========
function handlePlayerLeave(room, playerId) {
  const player = room.players.find((p) => p.id === playerId);
  const playerName = player ? player.name : "Player";
  
  // Remove from players array
  const idx = room.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return null;
  room.players.splice(idx, 1);
  
  // Remove from scores and stats
  delete room.scores[playerId];
  if (room.playerStats) delete room.playerStats[playerId];
  if (room.roundTurnCounts) delete room.roundTurnCounts[playerId];
  if (room.roundGuessTurns) delete room.roundGuessTurns[playerId];
  removeFromJoinOrder(room, playerId);
  
  // Remove from activeOrder and guessedCorrect sets
  if (room.activeOrder) {
    room.activeOrder = room.activeOrder.filter((id) => id !== playerId);
  }
  if (room.guessedCorrect && room.guessedCorrect.has) {
    room.guessedCorrect.delete(playerId);
  }
  
  return playerName;
}

function handlePlayerDisconnect(room, playerId) {
  const playerName = handlePlayerLeave(room, playerId);
  if (!playerName) return; // Player not found
  
  const wasChooser = room.chooserId === playerId;
  const wasTurnPlayer = room.turnId === playerId;
  const wasPlaying = room.status === "playing";
  const remainingPlayers = room.players.length;
  
  // Case 5: All players leave (empty room)
  if (remainingPlayers === 0) {
    stopTimer(room);
    rooms.delete(room.code);
    console.log(`Room ${room.code} closed (no players left).`);
    return;
  }
  
  // Case 1: Chooser leaves mid-round
  if (wasChooser && wasPlaying) {
    stopTimer(room);
    io.to(room.code).emit("systemMsg", `⚠️ The chooser left the game. This round has been cancelled.`);
    
    // Clear round state
    room.secretCharacterId = null;
    if (room.guessedCorrect) room.guessedCorrect.clear();
    room.correctGuessOrder = [];
    room.roundTurnCounts = {};
    room.roundGuessTurns = {};
    room.turnId = null;
    room.roundPhase = "awaitingQuestion";
    
    // Mark chooser as having left (remove from hasChosen)
    if (room.hasChosen) delete room.hasChosen[playerId];
    
    // Move to next chooser
    nextChooser(room);
    return;
  }
  
  // Case 4: Everyone except chooser leaves
  if (remainingPlayers === 1 && room.chooserId === room.players[0]?.id && wasPlaying) {
    stopTimer(room);
    io.to(room.code).emit("systemMsg", `❗ All players left — ending the current round.`);
    
    // Clear round state
    room.secretCharacterId = null;
    if (room.guessedCorrect) room.guessedCorrect.clear();
    room.correctGuessOrder = [];
    room.roundTurnCounts = {};
    room.roundGuessTurns = {};
    room.turnId = null;
    room.roundPhase = "awaitingQuestion";
    
    // Move to next chooser (will likely end set/game)
    nextChooser(room);
    return;
  }
  
  // Case 2: Current turn player leaves
  if (wasTurnPlayer && wasPlaying) {
    io.to(room.code).emit("systemMsg", `⏩ ${playerName} left during their turn — skipping to the next player.`);
    nextTurn(room, true);
    return;
  }
  
  // Case 3: Other guesser leaves
  if (wasPlaying && !wasChooser && !wasTurnPlayer) {
    io.to(room.code).emit("systemMsg", `🚪 ${playerName} left the game.`);
    
    // Check if all remaining guessers have already guessed correctly
    const totalGuessers = room.players.filter((p) => p.id !== room.chooserId).length;
    if (totalGuessers > 0 && room.guessedCorrect && room.guessedCorrect.size >= totalGuessers) {
      // All remaining guessers have guessed correctly, end round early
      finishRound(room);
      return;
    }
  }
  
  // Update room and broadcast
  saveRoom(room);
  broadcastRoomUpdate(room);
}

// ========== ROUND + SET SYSTEM ==========
// A SET = everyone becomes chooser once.
// A ROUND = one chooser session (continues until ALL other players guess correctly).

function nextChooser(room) {
  const remaining = room.players.filter((p) => !room.hasChosen[p.id]);
  if (remaining.length === 0) {
    // Completed a full set
    return endSet(room);
  }

  const next = remaining[0];
  room.chooserId = next.id;
  room.status = "choosing";
  room.correctGuessOrder = [];
  room.guessedCorrect = new Set();
  resetRoundTracking(room);
  room.activeOrder = room.players
    .filter((p) => p.id !== room.chooserId)
    .map((p) => p.id); // fixed order among guessers for the round

  saveRoom(room);
  broadcastRoomUpdate(room);
  io.to(room.code).emit("systemMsg", `${next.name} is choosing a secret character...`);
  io.to(next.id).emit("chooserAssigned", {
    roomCode: room.code,
    category: room.category,
    characters: room.characters
  });
}

function endSet(room) {
  room.hasChosen = {};
  room.currentRound = 1; // will be used for display
  const justFinishedSet = room.currentSet;
  room.currentSet++;

  const leaderboard = makeLeaderboard(room);
  io.to(room.code).emit("roundOver", {
    leaderboard,
    currentRound: room.totalRounds,
    totalRounds: room.totalRounds,
    currentSet: justFinishedSet,
    totalSets: room.totalSets,
  });

  if (room.currentSet > room.totalSets) {
    endGame(room);
    return;
  }

  io.to(room.code).emit("systemMsg", `📦 Starting Set ${room.currentSet}/${room.totalSets}...`);
  // Prepare next set before choosing the next chooser
  prepareNewSet(room);
  setTimeout(() => nextChooser(room), 3000);
}

function endGame(room) {
  stopTimer(room);
  room.status = "over";
  const leaderboard = makeLeaderboard(room);
  io.to(room.code).emit("gameOver", { leaderboard });
}

function makeLeaderboard(room) {
  const entries = room.players.map((p) => {
    const stats = ensurePlayerStats(room, p.id);
    const avgTurn =
      stats.correctGuesses > 0
        ? Number((stats.totalTurnCount / stats.correctGuesses).toFixed(2))
        : null;
    return {
      id: p.id,
      name: p.name,
      score: stats.score,
      correctGuesses: stats.correctGuesses,
      avgTurn,
      totalTurnCount: stats.correctGuesses > 0 ? stats.totalTurnCount : Number.MAX_SAFE_INTEGER,
      firstTurnWins: stats.firstTurnWins,
      chooserBonus: stats.chooserBonus,
      joinIndex: getJoinIndex(room, p.id),
    };
  });

  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.totalTurnCount !== b.totalTurnCount) return a.totalTurnCount - b.totalTurnCount;
    if (b.firstTurnWins !== a.firstTurnWins) return b.firstTurnWins - a.firstTurnWins;
    if (b.chooserBonus !== a.chooserBonus) return b.chooserBonus - a.chooserBonus;
    return a.joinIndex - b.joinIndex;
  });

  return entries.map(({ totalTurnCount, joinIndex, ...rest }) => rest);
}

// ========== SCORING ==========
function awardPoints(room, playerId) {
  if (room.guessedCorrect.has(playerId)) return; // already correct in this round

  room.guessedCorrect.add(playerId);

  const turnNumber = room.roundTurnCounts?.[playerId] || 1;
  room.roundGuessTurns[playerId] = turnNumber;

  const points = getPointsForTurn(turnNumber);
  room.correctGuessOrder.push(playerId);

  const playerStats = ensurePlayerStats(room, playerId);
  playerStats.score += points;
  playerStats.correctGuesses += 1;
  playerStats.totalTurnCount += turnNumber;
  if (turnNumber === 1) playerStats.firstTurnWins += 1;
  room.scores[playerId] = playerStats.score;

  const chooserStats = ensurePlayerStats(room, room.chooserId);
  const chooserBonus = Math.round(points * CHOOSER_BONUS_RATIO);
  chooserStats.score += chooserBonus;
  chooserStats.chooserBonus += chooserBonus;
  room.scores[room.chooserId] = chooserStats.score;

  io.to(room.code).emit(
    "systemMsg",
    `✅ ${getPlayerName(room, playerId)} guessed correctly on turn ${turnNumber} and earned ${points} pts!`
  );
  if (chooserBonus > 0) {
    io.to(room.code).emit(
      "systemMsg",
      `🎯 ${getPlayerName(room, room.chooserId)} gains ${chooserBonus} bonus pts as chooser.`
    );
  }

  // If everyone guessed, finish the round
  const totalGuessers = room.players.filter((p) => p.id !== room.chooserId).length;
  if (room.guessedCorrect.size >= totalGuessers || totalGuessers === 0) {
    io.to(room.code).emit("systemMsg", "🏁 Everyone guessed correctly!");
    finishRound(room);
  } else {
    // Keep the turn order cycling only among *not-yet-correct* players
    nextTurn(room, /*advance=*/true);
  }
}

function finishRound(room) {
  stopTimer(room);
  room.turnId = null;
  room.roundPhase = "betweenRounds";

  room.hasChosen[room.chooserId] = true;
  const totalGuessers = room.players.filter((p) => p.id !== room.chooserId).length;
  const guessedCount = room.guessedCorrect.size;

  applyChooserRoundAdjustments(room, totalGuessers, guessedCount);

  // Update round counter for display
  room.currentRound = Object.keys(room.hasChosen).length;
  const leaderboard = makeLeaderboard(room);

  saveRoom(room);
  broadcastRoomUpdate(room);
  io.to(room.code).emit("roundOver", {
    leaderboard,
    currentRound: room.currentRound,
    totalRounds: room.totalRounds,
    currentSet: room.currentSet,
    totalSets: room.totalSets,
  });

  setTimeout(() => nextChooser(room), 3000);
}

function applyChooserRoundAdjustments(room, totalGuessers, guessedCount) {
  if (!room.chooserId) return;
  if (totalGuessers <= 0) return;

  const chooserStats = ensurePlayerStats(room, room.chooserId);
  let adjustment = 0;
  if (guessedCount === 0) {
    adjustment = CHOOSER_PITY_BONUS;
  } else if (guessedCount === totalGuessers) {
    adjustment = -CHOOSER_TOO_EASY_PENALTY;
  }

  if (adjustment === 0) return;

  chooserStats.score += adjustment;
  room.scores[room.chooserId] = chooserStats.score;

  if (adjustment > 0) {
    io.to(room.code).emit(
      "systemMsg",
      `🎁 ${getPlayerName(room, room.chooserId)} receives a ${adjustment} pt pity bonus.`
    );
  } else {
    io.to(room.code).emit(
      "systemMsg",
      `⚖️ ${getPlayerName(room, room.chooserId)} loses ${Math.abs(adjustment)} pts (too easy!).`
    );
  }
}

// ========== TURN HANDLING ==========
function handlePass(room) {
  io.to(room.code).emit(
    "systemMsg",
    `⏩ ${getPlayerName(room, room.turnId)} passed their turn.`
  );
  nextTurn(room, /*advance=*/true);
}

function nextTurn(room, advance=false) {
  const activeIds = room.activeOrder.filter((id) => !room.guessedCorrect.has(id));
  if (activeIds.length === 0) return; // all done

  const prevTurnId = room.turnId;
  // If current turn is not among active (e.g., that player just guessed right),
  // jump to the first active player. Otherwise advance to next active.
  if (!activeIds.includes(room.turnId)) {
    room.turnId = activeIds[0];
  } else if (advance) {
    const idx = activeIds.indexOf(room.turnId);
    room.turnId = activeIds[(idx + 1) % activeIds.length];
  }

  const shouldIncrement = advance || prevTurnId !== room.turnId;
  markTurnStart(room, room.turnId, shouldIncrement);

  room.roundPhase = "awaitingQuestion";
  startRoundTimer(room);
  saveRoom(room);
  broadcastRoomUpdate(room);
  io.to(room.code).emit("systemMsg", `👉 ${getPlayerName(room, room.turnId)}'s turn!`);
}

// ========== SOCKETS ==========
io.on("connection", (socket) => {
  // CREATE
  socket.on("createRoom", ({ name, totalSets }) => {
    const code = genRoomCode();
    const room = {
      code,
      status: "waiting",
      currentRound: 1,
      totalRounds: 0, // defined at start
      currentSet: 1,
      totalSets: Math.max(1, Number(totalSets || 1)),
      players: [{ id: socket.id, name: name || "Host", isHost: true }],
      chooserId: null,
      turnId: null,
      secretCharacterId: null,
      hasChosen: {},
      scores: {},
      correctGuessOrder: [],
      guessedCorrect: new Set(),
      timeLeft: 0,
      roundPhase: "awaitingQuestion",
      activeOrder: [],
      category: null,
      characters: [],
      playerStats: {},
      joinOrder: [],
      roundTurnCounts: {},
      roundGuessTurns: {},
      lastTurnId: null,
    };
    recordJoinOrder(room, socket.id);
    ensurePlayerStats(room, socket.id);
    room.scores[socket.id] = 0;
    socket.join(code);
    saveRoom(room);
    socket.emit("roomJoined", { room: sanitizeRoom(room) });
    broadcastRoomUpdate(room);
  });

  // JOIN
  socket.on("joinRoom", ({ name, roomCode }) => {
    const room = getRoom(roomCode?.toUpperCase());
    if (!room) return socket.emit("errorMsg", "Room not found.");
    if (room.status !== "waiting")
      return socket.emit("errorMsg", "Game already started.");
    const player = { id: socket.id, name: name || "Player", isHost: false };
    room.players.push(player);
    recordJoinOrder(room, socket.id);
    const stats = ensurePlayerStats(room, socket.id);
    stats.score = 0;
    stats.correctGuesses = 0;
    stats.totalTurnCount = 0;
    stats.firstTurnWins = 0;
    stats.chooserBonus = 0;
    room.scores[socket.id] = 0;
    socket.join(room.code);
    saveRoom(room);
    socket.emit("roomJoined", { room: sanitizeRoom(room) });
    broadcastRoomUpdate(room);
  });

  // LEAVE (explicit)
  socket.on("leaveRoom", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    socket.leave(room.code);
    handlePlayerDisconnect(room, socket.id);
  });

  // START
  socket.on("startGame", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.players.length < 2)
      return socket.emit("errorMsg", "Need at least 2 players.");
    room.totalRounds = room.players.length; // one chooser per player per set
    io.to(room.code).emit("systemMsg", "🚀 Game starting!");
    // Prepare the first set
    prepareNewSet(room);
    nextChooser(room);
  });

  // CHARACTER CHOSEN
  socket.on("characterChosen", ({ roomCode, characterId }) => {
    const room = getRoom(roomCode);
    if (!room || room.chooserId !== socket.id) return;
    room.secretCharacterId = characterId;
    room.status = "playing";
    room.roundPhase = "awaitingQuestion";

    // first turn is first in activeOrder
    const firstId = room.activeOrder[0];
    room.turnId = firstId || null;

    room.guessedCorrect = new Set();
    room.correctGuessOrder = [];
    if (firstId) {
      markTurnStart(room, firstId, true);
    }
    saveRoom(room);

    io.to(room.code).emit("gameStarted", {
      room: sanitizeRoom(room),
      category: room.category,
      characters: room.characters
    });
    io.to(room.code).emit(
      "systemMsg",
      `${getPlayerName(room, room.chooserId)} has picked a secret character!`
    );
    startRoundTimer(room);
  });

  // QUESTION
  socket.on("makeQuestion", ({ roomCode, question }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.turnId !== socket.id) return;
    if (room.roundPhase !== "awaitingQuestion") return;
    io.to(room.code).emit("chatMsg", { from: socket.id, text: question });
    room.roundPhase = "awaitingAnswer";
    saveRoom(room);
    io.to(room.chooserId).emit("awaitAnswer", { from: socket.id, question });
  });

  // ANSWER
  socket.on("answerQuestion", ({ roomCode, answer }) => {
    const room = getRoom(roomCode);
    if (!room || room.chooserId !== socket.id) return;
    if (room.roundPhase !== "awaitingAnswer") return;
    const ans = (String(answer).toLowerCase() === "yes" || answer === true) ? "Yes ✅" : "No ❌";
    io.to(room.code).emit("chatMsg", { from: socket.id, text: ans });
    room.roundPhase = "awaitingDecision";
    saveRoom(room);
    io.to(room.turnId).emit("decisionPhase", { answer: ans });
  });

  // GUESS (allowed ANYTIME during your turn)
  socket.on("makeGuess", ({ roomCode, characterId }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.turnId !== socket.id) return;  // only active player can guess
    if (!room.secretCharacterId) return;

    if (characterId === room.secretCharacterId) {
      awardPoints(room, socket.id);
    } else {
      io.to(socket.id).emit("systemMsg", "❌ Wrong guess!");
      nextTurn(room, true);
    }
  });

  // PASS (allowed anytime during your turn)
  socket.on("passTurn", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.turnId !== socket.id) return;
    handlePass(room);
  });

  socket.on("playAgain", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    if (!player.isHost) {
      socket.emit("errorMsg", "Only the host can start a new game.");
      return;
    }
    if (room.status !== "over") {
      socket.emit("errorMsg", "Game is still in progress.");
      return;
    }
    if (room.players.length < 2) {
      socket.emit("errorMsg", "Need at least 2 players to start a new game.");
      return;
    }

    resetRoomForPlayAgain(room);
    saveRoom(room);
    io.to(room.code).emit("playAgainReady", { room: sanitizeRoom(room) });
    io.to(room.code).emit("systemMsg", "🔁 A new game is starting!");
    prepareNewSet(room);
    nextChooser(room);
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    for (const [code, room] of rooms.entries()) {
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        handlePlayerDisconnect(room, socket.id);
        // Note: handlePlayerDisconnect may delete the room, so check if it still exists
        if (rooms.has(code)) {
          socket.leave(room.code);
        }
        break; // Player can only be in one room
      }
    }
  });
});

server.listen(PORT, () =>
  console.log(`✅ Guess Who (Sets + Auto Rounds + Scoring) at http://localhost:${PORT}`)
);
