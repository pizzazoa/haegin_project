import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { recordMatch, getMatches } from './storage/matchStore.js';
import { createUser, findUserByUsername, findUserById, updateUserDeck, getUserDeck, getUserCards } from './storage/userStore.js';
import { recordUserResult } from './storage/userLogStore.js';
import { storeToken, getTokenRecord } from './storage/userTokenStore.js';
import { upsertSessionRecord } from './storage/sessionStore.js';
import { upsertParticipant, updateParticipantResult } from './storage/sessionParticipantStore.js';
import { replacePlayerCards } from './storage/sessionCardStore.js';
import { upsertTurnState } from './storage/sessionTurnStore.js';
import crypto from 'crypto';

dotenv.config();

const PORT = process.env.PORT || 8080;

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), sessions: sessions.size });
});

app.get('/matches', (_req, res) => {
  res.json({ matches: getMatches() });
});

app.post('/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  const normalized = username.toLowerCase();
  if (findUserByUsername(normalized)) {
    return res.status(409).json({ error: 'username exists' });
  }

  const passwordHash = hashPassword(password);
  const user = createUser(normalized, passwordHash, getDefaultDeckList(), getDefaultCardCollection());
  const token = issueToken(user.id);
  res.json({ token, userId: user.id, deck: user.deck, cards: user.cards });
});

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  const user = findUserByUsername(username.toLowerCase());
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  const token = issueToken(user.id);
  res.json({ token, userId: user.id, deck: user.deck, cards: user.cards });
});

app.get('/user/cards', authenticate, (req, res) => {
  const cards = getUserCards(req.userId);
  res.json({ cards });
});

app.get('/user/deck', authenticate, (req, res) => {
  const deck = getUserDeck(req.userId);
  res.json({ deck });
});

app.post('/user/deck', authenticate, (req, res) => {
  const { deck } = req.body || {};
  if (!Array.isArray(deck) || deck.length !== 20) {
    return res.status(400).json({ error: 'deck must contain exactly 20 card IDs' });
  }

  const collection = getUserCards(req.userId);
  if (!validateDeckList(deck, collection)) {
    return res.status(400).json({ error: 'deck contains cards you do not own or too many copies' });
  }

  updateUserDeck(req.userId, deck);
  res.json({ deck });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const sockets = new Map(); // clientId -> socket
const sessions = new Map(); // sessionId -> session state
const authTokens = new Map(); // token -> userId
const clientUsers = new Map(); // clientId -> { userId, username }
const matchQueue = []; // [{clientId, userId, username}]

const BOARD_RADIUS = 6;
const SPAWN_POSITIONS = [
  { q: 0, r: -6 },
  { q: 0, r: 6 }
];

const MAX_HAND_SIZE = 7;

const CARD_LIBRARY = {
  Slash: { id: 'Slash', cost: 1, type: 'damage', amount: 5, range: 1, target: 'opponent' },
  Arrow: { id: 'Arrow', cost: 1, type: 'damage', amount: 3, range: 3, target: 'opponent' },
  Heal: { id: 'Heal', cost: 1, type: 'heal', amount: 3, range: 0, target: 'self' },
  Fireball: { id: 'Fireball', cost: 3, type: 'damage', amount: 5, range: 3, target: 'opponent' }
};

wss.on('connection', socket => {
  const clientId = uuidv4();
  sockets.set(clientId, socket);
  sendTo(clientId, { type: 'welcome', clientId });

  socket.on('message', data => {
    try {
      const payload = JSON.parse(data);
      handleMessage(clientId, payload);
    } catch (err) {
      console.error('Invalid message', err);
      sendTo(clientId, { type: 'error', message: 'Invalid JSON' });
    }
  });

  socket.on('close', () => {
    sockets.delete(clientId);
    clientUsers.delete(clientId);
    removeFromQueue(clientId);
    leaveSession(clientId);
  });
});

function handleMessage(clientId, payload) {
  switch (payload.type) {
    case 'authenticate':
      handleSocketAuth(clientId, payload.token);
      break;
    case 'create-session':
      createSession(clientId);
      break;
    case 'join-session':
      joinSession(clientId, payload.sessionId);
      break;
    case 'ready':
      markReady(clientId, payload.sessionId, payload.playerName ?? 'Player');
      break;
    case 'player-command':
      handlePlayerCommand(clientId, payload);
      break;
    case 'enqueue-match':
      enqueueMatch(clientId);
      break;
    case 'leave-queue':
      removeFromQueue(clientId);
      break;
    default:
      sendTo(clientId, { type: 'error', message: 'Unknown message type' });
  }
}

function createSession(clientId) {
  const sessionId = uuidv4().slice(0, 8);
  const session = {
    id: sessionId,
    players: new Map([[clientId, { ready: false, name: getPlayerName(clientId) }]]),
    playerMeta: new Map(),
    status: 'waiting',
    turnOrder: [],
    activeIndex: 0,
    state: null,
    lastCommand: null,
    turnNumber: 0
  };
  session.playerMeta.set(clientId, getPlayerMeta(clientId));
  sessions.set(sessionId, session);
  upsertSessionRecord(sessionId, { status: session.status });
  registerParticipantEntry(session, clientId, 'player1');
  sendTo(clientId, { type: 'session-created', sessionId });
}

function joinSession(clientId, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    sendTo(clientId, { type: 'error', message: 'Session not found' });
    return;
  }
  if (session.players.size >= 2) {
    sendTo(clientId, { type: 'error', message: 'Session full' });
    return;
  }

  session.players.set(clientId, { ready: false, name: getPlayerName(clientId) });
  session.playerMeta?.set(clientId, getPlayerMeta(clientId));
  registerParticipantEntry(session, clientId, session.players.size === 1 ? 'player1' : 'player2');
  sendTo(clientId, { type: 'session-joined', sessionId, players: Array.from(session.players.keys()) });

  // notify host a second player arrived
  broadcast(session.players.keys(), { type: 'player-joined', sessionId, clientId });
}

function markReady(clientId, sessionId, playerName) {
  const session = sessions.get(sessionId);
  if (!session) {
    sendTo(clientId, { type: 'error', message: 'Session not found' });
    return;
  }
  const player = session.players.get(clientId);
  if (!player) {
    sendTo(clientId, { type: 'error', message: 'Player not part of session' });
    return;
  }

  player.ready = true;
  player.name = playerName || player.name;
  broadcast(session.players.keys(), { type: 'player-ready', sessionId, clientId, playerName: player.name });

  if (session.players.size === 2 && Array.from(session.players.values()).every(p => p.ready))
  {
    startMatch(session);
  }
}

function startMatch(session) {
  session.status = 'active';
  session.turnOrder = Array.from(session.players.keys());
  session.activeIndex = 0;
  session.phase = 'prep';
  session.turnTimer = null;
  session.turnNumber = 1;
  const players = session.turnOrder.map(id => ({ clientId: id, name: session.players.get(id).name }));
  session.snapshotPlayers = players;
  session.state = {
    players: session.turnOrder.reduce((acc, id) => {
      const meta = session.playerMeta?.get(id);
      acc[id] = createInitialPlayerState(session.players.get(id).name, meta?.userId);
      return acc;
    }, {}),
    board: {
      radius: BOARD_RADIUS,
      obstacles: []
    },
    positions: session.turnOrder.reduce((acc, id, index) => {
      acc[id] = SPAWN_POSITIONS[index] ? { ...SPAWN_POSITIONS[index] } : { q: 0, r: 0 };
      return acc;
    }, {}),
    status: 'active'
  };

  session.turnOrder.forEach(id => {
    const meta = session.playerMeta?.get(id);
    const preferredDeck = meta?.deck;
    initializeDeckForPlayer(session.state.players[id], preferredDeck);
    registerParticipantEntry(session, id, session.turnOrder.indexOf(id) === 0 ? 'player1' : 'player2');
  });
  upsertSessionRecord(session.id, { status: 'active', startedAt: new Date().toISOString() });
  broadcast(session.turnOrder, { type: 'match-ready', sessionId: session.id, players, activePlayer: session.turnOrder[0] });
  runTurnPhase(session);
}

function handlePlayerCommand(clientId, payload) {
  const { sessionId, command } = payload;
  const session = sessions.get(sessionId);
  if (!session) {
    sendTo(clientId, { type: 'error', message: 'Session not found' });
    return;
  }
  if (!session.players.has(clientId)) {
    sendTo(clientId, { type: 'error', message: 'Not part of session' });
    return;
  }

  if (session.status !== 'active') {
    sendTo(clientId, { type: 'error', message: 'Match not ready' });
    return;
  }

  if (requiresTurn(command?.action) && clientId !== session.turnOrder[session.activeIndex]) {
    sendTo(clientId, { type: 'error', message: 'Not your turn' });
    return;
  }

  normalizeCommandPayload(command);

  let handled = false;
  switch (command?.action) {
    case 'play-card':
      handled = processPlayCard(session, clientId, command);
      break;
    case 'use-card':
      handled = processUseCard(session, clientId, command);
      break;
    case 'move':
      handled = processMove(session, clientId, command);
      break;
    case 'surrender':
      handleSurrender(session, clientId);
      return;
    case 'end-turn':
      handled = true;
      endTurn(session);
      break;
    default:
      sendTo(clientId, { type: 'error', message: 'Unknown command action' });
      return;
  }

  if (handled) {
    session.lastCommand = { from: clientId, action: command.action, payload: command.payload ?? null };

    let payloadJson = null;
    if (command.payload !== undefined && command.payload !== null) {
      try {
        payloadJson = JSON.stringify(command.payload);
      } catch (err) {
        console.warn('Failed to serialize command payload for broadcast', err);
      }
    }

    broadcast(session.turnOrder, {
      type: 'command',
      sessionId: session.id,
      from: clientId,
      command: {
        action: command.action,
        payload: payloadJson
      }
    });

    broadcastState(session);
  }
}

function normalizeCommandPayload(command) {
  if (!command)
    return;

  if (command.payload && typeof command.payload === 'string') {
    if (command.payload.length === 0) {
      command.payload = null;
      return;
    }

    try {
      command.payload = JSON.parse(command.payload);
    } catch (err) {
      console.warn('Failed to parse command payload JSON', err);
      command.payload = null;
    }
  }
}

function requiresTurn(action) {
  return action === 'end-turn' || action === 'play-card' || action === 'use-card' || action === 'move';
}

function advanceTurn(session) {
  if (session.turnOrder.length === 0) return;
  session.activeIndex = (session.activeIndex + 1) % session.turnOrder.length;
  session.turnNumber = (session.turnNumber || 0) + 1;
  const activePlayer = session.turnOrder[session.activeIndex];
  broadcast(session.turnOrder, { type: 'turn-changed', sessionId: session.id, activePlayer });
  session.phase = 'prep';
  runTurnPhase(session);
}

function leaveSession(leaverId) {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.players.has(leaverId)) {
      session.players.delete(leaverId);
      broadcast(session.players.keys(), { type: 'player-left', sessionId, clientId: leaverId });
      if (session.players.size === 0) {
        if (session.snapshotPlayers && session.snapshotPlayers.length > 0) {
          recordMatch({ sessionId, players: session.snapshotPlayers, status: session.status });
        }
        sessions.delete(sessionId);
      } else {
        if (session.status === 'active') {
          const remaining = session.turnOrder.find(id => id !== leaverId);
          if (remaining) {
            declareWinner(session, remaining, `${leaverId} left`);
          }
        } else {
          session.status = 'waiting';
          session.turnOrder = Array.from(session.players.keys());
          session.activeIndex = 0;
        }
      }
      break;
    }
  }
}

function createInitialPlayerState(name, userId = null) {
  return {
    name,
    userId,
    hp: 30,
    maxHP: 30,
    steps: 5,
    maxSteps: 10,
    stepsPerTurn: 5,
    deck: [],
    hand: [],
    discard: []
  };
}

function handleSocketAuth(clientId, token) {
  if (!token || !authTokens.has(token)) {
    sendTo(clientId, { type: 'error', message: 'Invalid token' });
    return;
  }

  const userId = authTokens.get(token);
  const user = findUserById(userId);
  if (!user) {
    sendTo(clientId, { type: 'error', message: 'User not found' });
    return;
  }

  clientUsers.set(clientId, { userId, username: user.username });
  sendTo(clientId, { type: 'authenticated', userId, username: user.username });
}

function enqueueMatch(clientId) {
  if (matchQueue.find(entry => entry.clientId === clientId)) {
    sendTo(clientId, { type: 'queue-status', status: 'already-in-queue' });
    return;
  }

  const userMeta = clientUsers.get(clientId);
  if (!userMeta) {
    sendTo(clientId, { type: 'error', message: 'Authenticate before queueing' });
    return;
  }

  matchQueue.push({ clientId, userId: userMeta.userId, username: userMeta.username });
  sendTo(clientId, { type: 'queue-status', status: 'queued', position: matchQueue.length });
  attemptMatchMaking();
}

function removeFromQueue(clientId) {
  const index = matchQueue.findIndex(entry => entry.clientId === clientId);
  if (index >= 0) {
    matchQueue.splice(index, 1);
    sendTo(clientId, { type: 'queue-status', status: 'removed' });
  }
}

function attemptMatchMaking() {
  while (matchQueue.length >= 2) {
    const playerA = matchQueue.shift();
    const playerB = matchQueue.shift();
    createAutoSession(playerA, playerB);
  }
}

function createAutoSession(entryA, entryB) {
  const sessionId = uuidv4().slice(0, 8);
  const session = {
    id: sessionId,
    players: new Map(),
    playerMeta: new Map(),
    status: 'waiting',
    turnOrder: [],
    activeIndex: 0,
    state: null,
    lastCommand: null,
    turnNumber: 0
  };

  const playerAName = entryA.username || `Player-${entryA.clientId.slice(0, 4)}`;
  const playerBName = entryB.username || `Player-${entryB.clientId.slice(0, 4)}`;

  session.players.set(entryA.clientId, { ready: true, name: playerAName });
  session.players.set(entryB.clientId, { ready: true, name: playerBName });
  session.playerMeta.set(entryA.clientId, { userId: entryA.userId, deck: getUserDeck(entryA.userId) || getDefaultDeckList() });
  session.playerMeta.set(entryB.clientId, { userId: entryB.userId, deck: getUserDeck(entryB.userId) || getDefaultDeckList() });

  sessions.set(sessionId, session);
  upsertSessionRecord(sessionId, { status: session.status });
  registerParticipantEntry(session, entryA.clientId, 'player1');
  registerParticipantEntry(session, entryB.clientId, 'player2');
  sendTo(entryA.clientId, { type: 'match-found', sessionId, role: 'player1' });
  sendTo(entryB.clientId, { type: 'match-found', sessionId, role: 'player2' });
  startMatch(session);
}

function processPlayCard(session, clientId, command) {
  if (!session.state) return false;
  const playerState = session.state.players[clientId];
  if (!playerState) return false;

  const cardId = command.payload?.cardId;
  if (!cardId) {
    sendTo(clientId, { type: 'error', message: 'Missing cardId' });
    return false;
  }

  const cardIndex = playerState.hand.indexOf(cardId);
  if (cardIndex === -1) {
    sendTo(clientId, { type: 'error', message: 'Card not in hand' });
    return false;
  }

  const cardData = CARD_LIBRARY[cardId];
  if (!cardData) {
    sendTo(clientId, { type: 'error', message: 'Unknown card' });
    return false;
  }

  if (playerState.steps < cardData.cost) {
    sendTo(clientId, { type: 'error', message: 'Not enough steps' });
    return false;
  }

  const targetId = command.payload?.targetPlayerId || getTargetByCard(session, clientId, cardData);
  const targetState = targetId ? session.state.players[targetId] : null;
  if ((cardData.target === 'opponent' || cardData.target === 'ally') && !targetState) {
    sendTo(clientId, { type: 'error', message: 'Invalid target' });
    return false;
  }

  if (!validateCardRange(session, clientId, targetId, cardData)) {
    sendTo(clientId, { type: 'error', message: 'Target out of range' });
    return false;
  }

  const applied = applyCardEffect(session, clientId, targetId, cardData);
  if (!applied) {
    sendTo(clientId, { type: 'error', message: 'Failed to apply card effect' });
    return false;
  }

  playerState.steps -= cardData.cost;
  playerState.hand.splice(cardIndex, 1);
  playerState.discard.push(cardId);
  return true;
}

function processUseCard(session, clientId, command) {
  if (!session.state) return false;
  const playerState = session.state.players[clientId];
  if (!playerState) return false;

  const { cardId, targetQ, targetR, effectValue, isAoE } = command.payload || {};
  if (!cardId) {
    sendTo(clientId, { type: 'error', message: 'Missing cardId' });
    return false;
  }

  const cardIndex = playerState.hand.indexOf(cardId);
  if (cardIndex === -1) {
    sendTo(clientId, { type: 'error', message: 'Card not in hand' });
    return false;
  }

  const cardData = CARD_LIBRARY[cardId];
  if (!cardData) {
    sendTo(clientId, { type: 'error', message: 'Unknown card' });
    return false;
  }

  if (playerState.steps < cardData.cost) {
    sendTo(clientId, { type: 'error', message: 'Not enough steps' });
    return false;
  }

  // Handle AoE cards - apply damage to all enemies in adjacent tiles
  if (isAoE && cardData.type === 'damage') {
    const centerPos = { q: targetQ, r: targetR };
    const neighbors = getHexNeighbors(centerPos);
    let hitAny = false;

    for (const neighborPos of neighbors) {
      for (const [playerId, pos] of Object.entries(session.state.positions)) {
        if (playerId === clientId) continue; // Don't damage self
        if (pos && pos.q === neighborPos.q && pos.r === neighborPos.r) {
          const targetState = session.state.players[playerId];
          if (targetState) {
            targetState.hp = Math.max(0, targetState.hp - cardData.amount);
            hitAny = true;
            if (targetState.hp <= 0) {
              declareWinner(session, clientId, `${cardData.id}-kill`);
            }
          }
        }
      }
    }

    playerState.steps -= cardData.cost;
    playerState.hand.splice(cardIndex, 1);
    playerState.discard.push(cardId);
    return true;
  }

  // Find target player by position (for non-AoE cards)
  let targetId = null;
  const hasExplicitTarget = targetQ !== undefined && targetR !== undefined;

  if (hasExplicitTarget) {
    const targetPos = { q: targetQ, r: targetR };
    for (const [playerId, pos] of Object.entries(session.state.positions)) {
      // Skip self for damage cards
      if (playerId === clientId && cardData.type === 'damage') continue;
      if (pos && pos.q === targetPos.q && pos.r === targetPos.r) {
        targetId = playerId;
        break;
      }
    }

    // If explicit target position was given but no valid target found, fail for damage cards
    if (!targetId && cardData.type === 'damage') {
      sendTo(clientId, { type: 'error', message: 'No valid target at position' });
      return false;
    }
  }

  // Only use fallback target logic if no explicit target position was provided
  if (!targetId && !hasExplicitTarget) {
    targetId = getTargetByCard(session, clientId, cardData);
  }

  const targetState = targetId ? session.state.players[targetId] : null;
  if ((cardData.target === 'opponent' || cardData.target === 'ally') && !targetState) {
    sendTo(clientId, { type: 'error', message: 'Invalid target' });
    return false;
  }

  if (!validateCardRange(session, clientId, targetId, cardData)) {
    sendTo(clientId, { type: 'error', message: 'Target out of range' });
    return false;
  }

  const applied = applyCardEffect(session, clientId, targetId, cardData);
  if (!applied) {
    sendTo(clientId, { type: 'error', message: 'Failed to apply card effect' });
    return false;
  }

  playerState.steps -= cardData.cost;
  playerState.hand.splice(cardIndex, 1);
  playerState.discard.push(cardId);
  return true;
}

function processMove(session, clientId, command) {
  if (!session.state) return false;
  const playerState = session.state.players[clientId];
  const positions = session.state.positions;
  if (!playerState) return false;

  // Support both {target: {q, r}} and {targetQ, targetR} formats
  let target = command.payload?.target;
  if (!target) {
    const { targetQ, targetR } = command.payload || {};
    if (typeof targetQ === 'number' && typeof targetR === 'number') {
      target = { q: targetQ, r: targetR };
    }
  }

  if (!target || typeof target.q !== 'number' || typeof target.r !== 'number')
  {
    sendTo(clientId, { type: 'error', message: 'Invalid move target' });
    return false;
  }

  if (!isWithinBoard(target, session.state.board.radius))
  {
    sendTo(clientId, { type: 'error', message: 'Target outside board' });
    return false;
  }

  if (isTileOccupied(positions, clientId, target))
  {
    sendTo(clientId, { type: 'error', message: 'Tile occupied' });
    return false;
  }

  const currentPos = positions[clientId];
  const distance = hexDistance(currentPos, target);

  const baseCost = command.payload?.cost ?? 1;
  const totalCost = Math.max(baseCost, distance);
  if (playerState.steps < totalCost) {
    sendTo(clientId, { type: 'error', message: 'Not enough steps' });
    return false;
  }
  playerState.steps -= totalCost;
  positions[clientId] = { q: target.q, r: target.r };
  return true;
}

function handleSurrender(session, clientId) {
  const opponentId = getOpponentId(session, clientId);
  if (opponentId)
  {
    declareWinner(session, opponentId, 'surrender');
  }
  else
  {
    declareWinner(session, null, 'surrender');
  }
}

function declareWinner(session, winnerId, reason) {
  if (session.status === 'finished')
    return;

  session.status = 'finished';

  const winnerMeta = winnerId ? session.playerMeta?.get(winnerId) : null;
  if (winnerMeta && winnerMeta.userId)
  {
    recordUserResult(winnerMeta.userId, 'win');
  }

  session.turnOrder.forEach(clientId => {
    if (clientId === winnerId)
      return;

    const meta = session.playerMeta?.get(clientId);
    if (!meta || !meta.userId)
      return;

    recordUserResult(meta.userId, winnerId ? 'lose' : 'draw');
  });

  const finishedAt = new Date().toISOString();
  upsertSessionRecord(session.id, { status: 'finished', finishedAt, winner: winnerId ?? null, reason });
  session.playerMeta?.forEach((meta, clientId) => {
    if (!meta?.userId)
      return;
    let result = 'draw';
    if (winnerId) {
      result = clientId === winnerId ? 'win' : 'lose';
    }
    updateParticipantResult(session.id, meta.userId, result);
  });

  const finalState = serializeState(session);
  broadcast(session.turnOrder, {
    type: 'match-ended',
    sessionId: session.id,
    winner: winnerId ?? null,
    reason,
    state: finalState
  });

  recordMatch({
    sessionId: session.id,
    players: session.snapshotPlayers || [],
    status: session.status,
    winner: winnerId ?? null,
    reason
  });
}

function getOpponentId(session, playerId) {
  return session.turnOrder.find(id => id !== playerId);
}

function serializeState(session) {
  if (!session.state)
    return null;

  return {
    status: session.status,
    activePlayer: session.turnOrder[session.activeIndex],
    phase: session.phase,
    players: session.turnOrder.map(id => ({
      clientId: id,
      ...session.state.players[id],
      position: session.state.positions ? session.state.positions[id] : undefined
    })),
    board: session.state.board,
    lastCommand: session.lastCommand
  };
}

function broadcastState(session) {
  const state = serializeState(session);
  if (!state) return;
  persistSessionCards(session);
  recordTurnState(session);
  broadcast(session.turnOrder, { type: 'state-update', sessionId: session.id, state });
}

function broadcast(playerIterable, message) {
  const json = JSON.stringify(message);
  for (const clientId of playerIterable) {
    const socket = sockets.get(clientId);
    if (socket && socket.readyState === 1) {
      socket.send(json);
    }
  }
}

function sendTo(clientId, message) {
  const socket = sockets.get(clientId);
  if (socket && socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}

function getPlayerName(clientId) {
  const meta = clientUsers.get(clientId);
  if (meta && meta.username)
    return meta.username;
  return `Player-${clientId.slice(0, 4)}`;
}

function getPlayerMeta(clientId) {
  const meta = clientUsers.get(clientId);
  if (!meta)
    return { userId: null, deck: getDefaultDeckList() };

  const deck = getUserDeck(meta.userId) || getDefaultDeckList();
  return { userId: meta.userId, deck };
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function getSessionUserId(session, clientId) {
  if (!session?.playerMeta)
    return null;
  const meta = session.playerMeta.get(clientId);
  return meta?.userId || null;
}

function registerParticipantEntry(session, clientId, team) {
  const userId = getSessionUserId(session, clientId);
  if (!userId)
    return;

  upsertParticipant(session.id, userId, team);
}

function issueToken(userId) {
  const token = uuidv4();
  authTokens.set(token, userId);
  storeToken(token, userId);
  return token;
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [, token] = header.split(' ');
  if (!token) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  let userId = authTokens.get(token);
  if (!userId) {
    const record = getTokenRecord(token);
    if (record && record.userId) {
      userId = record.userId;
      authTokens.set(token, userId);
    }
  }

  if (!userId) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!findUserById(userId)) {
    authTokens.delete(token);
    return res.status(401).json({ error: 'unauthorized' });
  }

  req.userId = userId;
  next();
}

function getDefaultDeckList() {
  return [
    ...Array(6).fill('Slash'),
    ...Array(6).fill('Arrow'),
    ...Array(4).fill('Heal'),
    ...Array(4).fill('Fireball')
  ];
}

function getDefaultCardCollection() {
  return [
    { id: 'Slash', copies: 6 },
    { id: 'Arrow', copies: 6 },
    { id: 'Heal', copies: 6 },
    { id: 'Fireball', copies: 6 }
  ];
}

function persistSessionCards(session) {
  if (!session?.state?.players)
    return;

  session.turnOrder.forEach(clientId => {
    const playerState = session.state.players[clientId];
    const userId = getSessionUserId(session, clientId);
    if (!playerState || !userId)
      return;

    const records = [];
    (playerState.deck || []).forEach((cardId, index) => {
      records.push({ cardId, location: 'deck', position: index });
    });
    (playerState.hand || []).forEach((cardId, index) => {
      records.push({ cardId, location: 'hand', position: index });
    });
    (playerState.discard || []).forEach((cardId, index) => {
      records.push({ cardId, location: 'discard', position: index });
    });

    replacePlayerCards(session.id, userId, records);
  });
}

function recordTurnState(session) {
  if (!session)
    return;

  const activePlayer = session.turnOrder[session.activeIndex];
  const turnNumber = session.turnNumber ?? 0;
  const phase = session.phase ?? 'unknown';
  upsertTurnState(session.id, turnNumber, activePlayer, phase);
}

function validateDeckList(deck, collection) {
  const counts = {};
  deck.forEach(cardId => {
    if (!CARD_LIBRARY[cardId]) {
      counts.invalid = true;
      return;
    }
    counts[cardId] = (counts[cardId] || 0) + 1;
  });
  if (counts.invalid) return false;

  const collectionMap = collection.reduce((map, entry) => {
    map[entry.id] = entry.copies;
    return map;
  }, {});

  return Object.entries(counts).every(([cardId, qty]) => {
    if (cardId === 'invalid') return false;
    return qty <= (collectionMap[cardId] || 0);
  });
}

function initializeDeckForPlayer(playerState, preferredDeck) {
  const baseDeck = validateDeckList(preferredDeck || [], getDefaultCardCollection()) ? preferredDeck : getDefaultDeckList();
  playerState.deck = shuffle(baseDeck);
  playerState.hand = [];
  playerState.discard = [];
  drawCardsFromDeck(playerState, 5);
}

function createStarterDeck() {
  const deck = [];
  const entries = [
    { card: CARD_LIBRARY.Slash, copies: 6 },
    { card: CARD_LIBRARY.Arrow, copies: 6 },
    { card: CARD_LIBRARY.Heal, copies: 4 },
    { card: CARD_LIBRARY.Fireball, copies: 4 }
  ];
  entries.forEach(entry => {
    for (let i = 0; i < entry.copies; i++) {
      deck.push(entry.card.id);
    }
  });
  return deck;
}

function shuffle(array) {
  const cloned = [...array];
  for (let i = cloned.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cloned[i], cloned[j]] = [cloned[j], cloned[i]];
  }
  return cloned;
}

function drawCardsFromDeck(playerState, count) {
  for (let i = 0; i < count; i++) {
    if (playerState.hand.length >= MAX_HAND_SIZE) break;
    if (playerState.deck.length === 0) {
      reshuffleDiscard(playerState);
      if (playerState.deck.length === 0) break;
    }
    const cardId = playerState.deck.pop();
    playerState.hand.push(cardId);
  }
}

function reshuffleDiscard(playerState) {
  if (!playerState.discard || playerState.discard.length === 0) return;
  playerState.deck = shuffle(playerState.discard);
  playerState.discard = [];
}

function runTurnPhase(session) {
  if (!session.state || session.status !== 'active') return;

  switch (session.phase) {
    case 'prep':
      handlePrepPhase(session);
      break;
    case 'main':
      broadcastState(session);
      break;
    case 'end':
      handleEndPhase(session);
      break;
  }
}

function handlePrepPhase(session) {
  const activePlayerId = session.turnOrder[session.activeIndex];
  const playerState = session.state.players[activePlayerId];
  if (!playerState) return;

  playerState.steps = Math.min(playerState.steps + playerState.stepsPerTurn, playerState.maxSteps);
  drawCards(session, activePlayerId, 1);
  session.phase = 'main';
  runTurnPhase(session);
}

function handleEndPhase(session) {
  applyStatusEffects(session);
  advanceTurn(session);
}

function endTurn(session) {
  if (session.status !== 'active') return;
  session.phase = 'end';
  runTurnPhase(session);
}

function applyStatusEffects(session) {
  if (!session.state.statusEffects) return;
  const effects = session.state.statusEffects;
  for (const [playerId, statusList] of Object.entries(effects))
  {
    const playerState = session.state.players[playerId];
    if (!playerState || !statusList) continue;
    statusList.forEach(effect => {
      if (effect.type === 'burn')
      {
        playerState.hp = Math.max(0, playerState.hp - effect.amount);
      }
      effect.duration -= 1;
    });
    session.state.statusEffects[playerId] = statusList.filter(effect => effect.duration > 0);
    if (playerState.hp <= 0)
    {
      declareWinner(session, getOpponentId(session, playerId), 'hp-zero');
    }
  }
}

function drawCards(session, playerId, count) {
  const playerState = session.state.players[playerId];
  if (!playerState)
    return;

  drawCardsFromDeck(playerState, count);
}

function hexDistance(a, b) {
  const dq = (b.q ?? 0) - (a.q ?? 0);
  const dr = (b.r ?? 0) - (a.r ?? 0);
  const ds = -dq - dr;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
}

function getHexNeighbors(center) {
  const directions = [
    { q: 1, r: 0 },
    { q: 1, r: -1 },
    { q: 0, r: -1 },
    { q: -1, r: 0 },
    { q: -1, r: 1 },
    { q: 0, r: 1 }
  ];
  return directions.map(dir => ({
    q: (center.q ?? 0) + dir.q,
    r: (center.r ?? 0) + dir.r
  }));
}

function isWithinBoard(target, radius) {
  return hexDistance({ q: 0, r: 0 }, target) <= radius;
}

function isTileOccupied(positions, movingPlayerId, target) {
  if (!positions)
    return false;

  for (const [playerId, pos] of Object.entries(positions))
  {
    if (playerId === movingPlayerId) continue;
    if (pos && pos.q === target.q && pos.r === target.r)
    {
      return true;
    }
  }
  return false;
}

function getTargetByCard(session, casterId, cardData) {
  if (cardData.target === 'self')
    return casterId;
  if (cardData.target === 'opponent')
    return getOpponentId(session, casterId);
  return null;
}

function validateCardRange(session, casterId, targetId, cardData) {
  if (!cardData.range || cardData.range <= 0 || !targetId)
    return true;

  const positions = session.state.positions;
  if (!positions)
    return true;

  const casterPos = positions[casterId];
  const targetPos = positions[targetId];
  if (!casterPos || !targetPos)
    return true;

  const distance = hexDistance(casterPos, targetPos);
  return distance <= cardData.range;
}

function applyCardEffect(session, casterId, targetId, cardData)
{
  const casterState = session.state.players[casterId];
  if (!casterState)
    return false;

  switch (cardData.type)
  {
    case 'damage':
      if (!targetId) return false;
      const targetState = session.state.players[targetId];
      if (!targetState) return false;
      targetState.hp = Math.max(0, targetState.hp - cardData.amount);
      if (targetState.hp <= 0)
      {
        declareWinner(session, casterId, `${cardData.id}-kill`);
      }
      return true;
    case 'heal':
      casterState.hp = Math.min(casterState.maxHP, casterState.hp + cardData.amount);
      return true;
    default:
      return false;
  }
}

server.listen(PORT, () => {
  console.log(`Game server listening on ${PORT}`);
});
