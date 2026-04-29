const express = require("express");
const http = require("http");
const crypto = require("crypto");
const cors = require("cors");
const { Server } = require("socket.io");

const port = process.env.PORT || 3001;
const allowedOrigin = process.env.CORS_ORIGIN || "*";

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

function createRoomId() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function createUniqueRoomId() {
  let roomId = createRoomId();

  while (rooms.has(roomId)) {
    roomId = createRoomId();
  }

  return roomId;
}

function getPublicRoom(roomId) {
  const room = rooms.get(roomId);

  if (!room) {
    return null;
  }

  return {
    roomId,
    ownerId: room.ownerId,
    players: Array.from(room.players.values()),
  };
}

io.on("connection", (socket) => {
  socket.emit("server:ready", {
    socketId: socket.id,
  });

  socket.on("room:create", ({ password, playerName } = {}, ack) => {
    if (!password || String(password).trim().length < 4) {
      if (typeof ack === "function") {
        ack({ ok: false, error: "Password must be at least 4 characters" });
      }
      return;
    }

    const roomId = createUniqueRoomId();
    const player = {
      socketId: socket.id,
      name: playerName || "Host",
      host: true,
    };

    rooms.set(roomId, {
      ownerId: socket.id,
      passwordHash: hashPassword(String(password)),
      players: new Map([[socket.id, player]]),
    });

    socket.join(roomId);

    if (typeof ack === "function") {
      ack({ ok: true, room: getPublicRoom(roomId) });
    }
  });

  socket.on("room:join", ({ roomId, password, playerName } = {}, ack) => {
    if (!roomId || !password) {
      if (typeof ack === "function") {
        ack({ ok: false, error: "roomId and password are required" });
      }
      return;
    }

    const normalizedRoomId = String(roomId).trim().toUpperCase();
    const room = rooms.get(normalizedRoomId);

    if (!room) {
      if (typeof ack === "function") {
        ack({ ok: false, error: "Room not found" });
      }
      return;
    }

    if (room.passwordHash !== hashPassword(String(password))) {
      if (typeof ack === "function") {
        ack({ ok: false, error: "Incorrect room password" });
      }
      return;
    }

    const player = {
      socketId: socket.id,
      name: playerName || "Player",
      host: room.ownerId === socket.id,
    };

    room.players.set(socket.id, player);
    socket.join(normalizedRoomId);
    socket.to(normalizedRoomId).emit("player:joined", { player });

    if (typeof ack === "function") {
      ack({ ok: true, room: getPublicRoom(normalizedRoomId) });
    }
  });

  socket.on("game:event", ({ roomId, event, payload } = {}, ack) => {
    if (!roomId || !event) {
      if (typeof ack === "function") {
        ack({ ok: false, error: "roomId and event are required" });
      }
      return;
    }

    const normalizedRoomId = String(roomId).trim().toUpperCase();
    const room = rooms.get(normalizedRoomId);

    if (!room || !room.players.has(socket.id)) {
      if (typeof ack === "function") {
        ack({ ok: false, error: "Join the room before sending game events" });
      }
      return;
    }

    socket.to(normalizedRoomId).emit("game:event", {
      event,
      payload,
      from: socket.id,
    });

    if (typeof ack === "function") {
      ack({ ok: true });
    }
  });

  socket.on("disconnecting", () => {
    for (const roomId of socket.rooms) {
      const room = rooms.get(roomId);

      if (room) {
        room.players.delete(socket.id);
        socket.to(roomId).emit("player:left", { socketId: socket.id });

        if (room.players.size === 0) {
          rooms.delete(roomId);
        }
      }
    }
  });
});

server.listen(port, () => {
  console.log(`blackjack-socket listening on ${port}`);
});
