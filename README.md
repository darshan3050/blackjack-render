# Deploying this Blackjack Socket Server on Render + Vercel

Use **Render Web Service** for the long-running Node + Socket.IO process.

## 1) Create Render service

In Render, choose:

- **New Web Service** (not Static Site, Worker, or Private Service)

Then connect this GitHub repository.

## 2) Render service settings

Use these values:

- **Environment:** `Node`
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`
- **Instance Type:** free/starter to begin (upgrade later if needed)

Render automatically provides the `PORT` variable.

## 3) Render environment variables

Set:

- `NODE_ENV=production`

Usually you do **not** need to set `PORT` manually on Render.

## 4) Deploy

- Click **Deploy**
- Wait until the service is live
- Copy your Render URL (example: `https://blackjack-socket.onrender.com`)

## 5) Wire Vercel frontend to Render Socket.IO backend

In your Vercel project settings, add environment variable:

- `NEXT_PUBLIC_SOCKET_URL=https://blackjack-socket.onrender.com`

Then redeploy Vercel.

## 6) Verify websocket connectivity

From your Vercel site, open browser DevTools and verify requests to:

- `https://blackjack-socket.onrender.com/socket.io/...`

Expected result:

- WebSocket upgrade `101 Switching Protocols`, or
- Successful polling fallback

Not expected:

- `404` errors on Socket.IO endpoint.

## Architecture note

If this repository is deployed in both places, a practical setup is:

- **Vercel:** frontend
- **Render:** realtime Socket.IO server

You can split frontend/backend into separate services later for a cleaner architecture.

## Socket.IO room flow

Create a room from the host client:

```js
socket.emit("room:create", { password: "1234", playerName: "Host" }, (res) => {
  console.log(res.room.roomId);
});
```

Share the returned `roomId` with other players. They can join with:

```js
socket.emit("room:join", {
  roomId: "ABC123",
  password: "1234",
  playerName: "Player 2",
}, (res) => {
  console.log(res);
});
```

After joining, send gameplay events to everyone else in the room:

```js
socket.emit("game:event", {
  roomId: "ABC123",
  event: "player:hit",
  payload: { seat: 1 },
});
```

## 7) Optional: deploy with `render.yaml`

This repository includes a Render Blueprint file (`render.yaml`) that preconfigures a **Web Service** for the Socket.IO process.

Included defaults:

- `type: web`
- `runtime: node`
- `buildCommand: npm install && npm run build`
- `startCommand: npm start`
- `NODE_ENV=production`

To use it:

1. In Render, click **New +** → **Blueprint**.
2. Select this repository.
3. Confirm the generated service (`blackjack-socket`) and deploy.
