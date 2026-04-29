const express = require("express");
const http = require("http");
const crypto = require("crypto");
const cors = require("cors");
const { Server } = require("socket.io");

const port = process.env.PORT || 3001;
const allowedOrigin = process.env.CORS_ORIGIN || "*";
const defaultBalance = 500;
const emptyRoomTtlMs = 15 * 60 * 1000;

const suits = ["S", "H", "D", "C"];
const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

const app = express();
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    service: "blackjack-socket",
    status: "ok",
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigin,
    methods: ["GET", "POST"],
  },
});

const rooms = new Map();
const emptyRoomTimers = new Map();

function createDeck() {
  const deck = [];
  let id = 0;

  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ suit, rank, id: `${rank}${suit}-${id}` });
      id += 1;
    }
  }

  return deck.sort(() => Math.random() - 0.5);
}

function createHand(cards) {
  let value = 0;
  let aces = 0;

  for (const card of cards) {
    if (card.rank === "A") {
      aces += 1;
      value += 11;
    } else if (["J", "Q", "K"].includes(card.rank)) {
      value += 10;
    } else {
      value += Number(card.rank);
    }
  }

  while (value > 21 && aces > 0) {
    value -= 10;
    aces -= 1;
  }

  return {
    cards,
    value,
    isBust: value > 21,
  };
}

function createRoomId() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function createUniqueRoomId() {
  let roomId = createRoomId();

  while (rooms.has(roomId)) {
    roomId = createRoomId();
  }

  return roomId;
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function createPlayer(socket, playerName, host = false, previousPlayer) {
  return {
    socketId: socket.id,
    name: playerName || (host ? "Host" : "Player"),
    host,
    balance: previousPlayer?.balance ?? defaultBalance,
    connected: true,
  };
}

function createRoom(roomId, socket, password, playerName) {
  const player = createPlayer(socket, playerName, true);

  return {
    roomId,
    ownerId: socket.id,
    passwordHash: hashPassword(String(password)),
    players: new Map([[socket.id, player]]),
    deck: createDeck(),
    gameState: "betting",
    playerHand: createHand([]),
    dealerHand: createHand([]),
    dealerUpCard: null,
    currentBet: 0,
    message: "Place a bet to start the round.",
    playerWon: null,
    isDraw: false,
    activePlayerId: socket.id,
    roundNumber: 0,
    finished: false,
  };
}

function serializeRoom(room) {
  return {
    roomId: room.roomId,
    ownerId: room.ownerId,
    players: Array.from(room.players.values()),
    gameState: room.gameState,
    playerHand: room.playerHand,
    dealerHand: room.dealerHand,
    dealerUpCard: room.dealerUpCard,
    currentBet: room.currentBet,
    message: room.message,
    playerWon: room.playerWon,
    isDraw: room.isDraw,
    activePlayerId: room.activePlayerId,
    roundNumber: room.roundNumber,
    finished: room.finished,
  };
}

function ackSuccess(ack, room, socket) {
  if (typeof ack === "function") {
    ack({
      ok: true,
      playerId: socket.id,
      room: serializeRoom(room),
    });
  }
}

function ackError(ack, error) {
  if (typeof ack === "function") {
    ack({ ok: false, error });
  }
}

function emitRoom(roomId) {
  const room = rooms.get(roomId);

  if (!room) {
    return;
  }

  io.to(roomId).emit("room:update", serializeRoom(room));
}

function ensureDeck(room) {
  if (room.deck.length < 12) {
    room.deck = createDeck();
  }
}

function clearRoomCleanup(roomId) {
  const timer = emptyRoomTimers.get(roomId);

  if (timer) {
    clearTimeout(timer);
    emptyRoomTimers.delete(roomId);
  }
}

function scheduleRoomCleanup(roomId) {
  clearRoomCleanup(roomId);

  const timer = setTimeout(() => {
    const room = rooms.get(roomId);
    const hasConnectedPlayers = room && Array.from(room.players.values()).some((player) => player.connected);

    if (!hasConnectedPlayers) {
      rooms.delete(roomId);
      emptyRoomTimers.delete(roomId);
    }
  }, emptyRoomTtlMs);

  emptyRoomTimers.set(roomId, timer);
}

function getJoinedRoom(roomId, socket, ack) {
  const normalizedRoomId = String(roomId || "").trim().toUpperCase();
  const room = rooms.get(normalizedRoomId);

  if (!room || !room.players.has(socket.id)) {
    ackError(ack, "Join the room before playing");
    return null;
  }

  return room;
}

function startRound(room, socket, betAmount, ack) {
  const bet = Number(betAmount);
  const player = room.players.get(socket.id);

  if (!player) {
    ackError(ack, "Join the room before betting");
    return;
  }

  if (!Number.isFinite(bet) || bet <= 0) {
    ackError(ack, "Enter a valid bet");
    return;
  }

  if (room.gameState === "playing" || room.gameState === "dealerTurn") {
    ackError(ack, "A round is already in progress");
    return;
  }

  if (player.balance < bet) {
    ackError(ack, "Insufficient balance");
    return;
  }

  ensureDeck(room);

  const playerCards = [room.deck[0], room.deck[1]];
  const dealerCards = [room.deck[2], room.deck[3]];

  room.deck = room.deck.slice(4);
  room.playerHand = createHand(playerCards);
  room.dealerHand = createHand(dealerCards);
  room.dealerUpCard = dealerCards[0];
  room.currentBet = bet;
  room.gameState = "playing";
  room.playerWon = null;
  room.isDraw = false;
  room.finished = false;
  room.activePlayerId = socket.id;
  room.message = `${player.name}'s turn.`;
  room.roundNumber += 1;
  player.balance -= bet;

  ackSuccess(ack, room, socket);
  emitRoom(room.roomId);
}

function finishRound(room, resultMessage, playerWon, isDraw = false) {
  room.gameState = "finished";
  room.finished = true;
  room.playerWon = playerWon;
  room.isDraw = isDraw;
  room.message = resultMessage;

  const activePlayer = room.players.get(room.activePlayerId);

  if (activePlayer && playerWon) {
    activePlayer.balance += room.currentBet * 2;
  } else if (activePlayer && isDraw) {
    activePlayer.balance += room.currentBet;
  }
}

function dealerTurn(room) {
  ensureDeck(room);
  room.gameState = "dealerTurn";
  room.message = "Dealer is playing.";

  while (room.dealerHand.value < 17 && !room.dealerHand.isBust) {
    const newCard = room.deck[0];
    room.deck = room.deck.slice(1);
    room.dealerHand = createHand([...room.dealerHand.cards, newCard]);
  }

  if (room.dealerHand.isBust) {
    finishRound(room, "Dealer busted. You win.", true);
    return;
  }

  if (room.playerHand.value > room.dealerHand.value) {
    finishRound(room, "You win.", true);
    return;
  }

  if (room.dealerHand.value > room.playerHand.value) {
    finishRound(room, "Dealer wins.", false);
    return;
  }

  finishRound(room, "Push. Your bet is returned.", false, true);
}

io.on("connection", (socket) => {
  socket.emit("server:ready", {
    socketId: socket.id,
  });

  socket.on("room:create", ({ password, playerName } = {}, ack) => {
    if (!password || String(password).trim().length < 4) {
      ackError(ack, "Password must be at least 4 characters");
      return;
    }

    const roomId = createUniqueRoomId();
    const room = createRoom(roomId, socket, password, playerName);

    rooms.set(roomId, room);
    clearRoomCleanup(roomId);
    socket.join(roomId);
    ackSuccess(ack, room, socket);
    emitRoom(roomId);
  });

  socket.on("room:join", ({ roomId, password, playerName } = {}, ack) => {
    if (!roomId || !password) {
      ackError(ack, "roomId and password are required");
      return;
    }

    const normalizedRoomId = String(roomId).trim().toUpperCase();
    const room = rooms.get(normalizedRoomId);

    if (!room) {
      ackError(ack, "Room not found");
      return;
    }

    if (room.passwordHash !== hashPassword(String(password))) {
      ackError(ack, "Incorrect room password");
      return;
    }

    const previousPlayer = room.players.get(socket.id);
    const player = createPlayer(
      socket,
      playerName || previousPlayer?.name,
      room.ownerId === socket.id,
      previousPlayer
    );

    room.players.set(socket.id, player);
    clearRoomCleanup(normalizedRoomId);
    socket.join(normalizedRoomId);
    socket.to(normalizedRoomId).emit("player:joined", { player });
    ackSuccess(ack, room, socket);
    emitRoom(normalizedRoomId);
  });

  socket.on("room:startRound", ({ roomId, betAmount } = {}, ack) => {
    const room = getJoinedRoom(roomId, socket, ack);

    if (room) {
      startRound(room, socket, betAmount, ack);
    }
  });

  socket.on("room:hit", ({ roomId } = {}, ack) => {
    const room = getJoinedRoom(roomId, socket, ack);

    if (!room) {
      return;
    }

    if (room.activePlayerId !== socket.id || room.gameState !== "playing") {
      ackError(ack, "It is not your turn");
      return;
    }

    ensureDeck(room);
    const newCard = room.deck[0];
    room.deck = room.deck.slice(1);
    room.playerHand = createHand([...room.playerHand.cards, newCard]);

    if (room.playerHand.isBust) {
      finishRound(room, "Bust. Dealer wins.", false);
    }

    ackSuccess(ack, room, socket);
    emitRoom(room.roomId);
  });

  socket.on("room:stand", ({ roomId } = {}, ack) => {
    const room = getJoinedRoom(roomId, socket, ack);

    if (!room) {
      return;
    }

    if (room.activePlayerId !== socket.id || room.gameState !== "playing") {
      ackError(ack, "It is not your turn");
      return;
    }

    dealerTurn(room);
    ackSuccess(ack, room, socket);
    emitRoom(room.roomId);
  });

  socket.on("room:double", ({ roomId } = {}, ack) => {
    const room = getJoinedRoom(roomId, socket, ack);
    const player = room?.players.get(socket.id);

    if (!room || !player) {
      return;
    }

    if (room.activePlayerId !== socket.id || room.gameState !== "playing") {
      ackError(ack, "It is not your turn");
      return;
    }

    if (room.playerHand.cards.length !== 2) {
      ackError(ack, "Double is only available on the first move");
      return;
    }

    if (player.balance < room.currentBet) {
      ackError(ack, "Insufficient balance");
      return;
    }

    player.balance -= room.currentBet;
    room.currentBet *= 2;

    ensureDeck(room);
    const newCard = room.deck[0];
    room.deck = room.deck.slice(1);
    room.playerHand = createHand([...room.playerHand.cards, newCard]);

    if (room.playerHand.isBust) {
      finishRound(room, "Bust. Dealer wins.", false);
    } else {
      dealerTurn(room);
    }

    ackSuccess(ack, room, socket);
    emitRoom(room.roomId);
  });

  socket.on("room:playAgain", ({ roomId } = {}, ack) => {
    const room = getJoinedRoom(roomId, socket, ack);

    if (room) {
      startRound(room, socket, room.currentBet, ack);
    }
  });

  socket.on("game:event", ({ roomId, event, payload } = {}, ack) => {
    const room = getJoinedRoom(roomId, socket, ack);

    if (!room || !event) {
      return;
    }

    socket.to(room.roomId).emit("game:event", {
      event,
      payload,
      from: socket.id,
    });

    ackSuccess(ack, room, socket);
  });

  socket.on("disconnecting", () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) {
        continue;
      }

      const room = rooms.get(roomId);

      if (!room) {
        continue;
      }

      const player = room.players.get(socket.id);

      if (player) {
        player.connected = false;
        emitRoom(roomId);
      }

      const hasConnectedPlayers = Array.from(room.players.values()).some((roomPlayer) => roomPlayer.connected);

      if (!hasConnectedPlayers) {
        scheduleRoomCleanup(roomId);
      }
    }
  });
});

server.listen(port, () => {
  console.log(`blackjack-socket listening on ${port}`);
});
