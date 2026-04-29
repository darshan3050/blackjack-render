const express = require("express");
const http = require("http");
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

io.on("connection", (socket) => {
  socket.emit("server:ready", {
    socketId: socket.id,
  });

  socket.on("room:join", (roomId, ack) => {
    if (!roomId) {
      if (typeof ack === "function") ack({ ok: false, error: "roomId is required" });
      return;
    }

    socket.join(roomId);
    socket.to(roomId).emit("player:joined", { socketId: socket.id });

    if (typeof ack === "function") {
      ack({ ok: true, roomId });
    }
  });

  socket.on("game:event", ({ roomId, event, payload } = {}, ack) => {
    if (!roomId || !event) {
      if (typeof ack === "function") {
        ack({ ok: false, error: "roomId and event are required" });
      }
      return;
    }

    socket.to(roomId).emit("game:event", {
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
      if (roomId !== socket.id) {
        socket.to(roomId).emit("player:left", { socketId: socket.id });
      }
    }
  });
});

server.listen(port, () => {
  console.log(`blackjack-socket listening on ${port}`);
});
