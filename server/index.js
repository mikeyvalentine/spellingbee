// Minimal token-exchange server for the Discord Activity OAuth flow.
// Only needed when running inside Discord (not for `npm run dev` mock mode).
//
//   1. Copy .env.example to .env and fill in your Client ID + Secret.
//   2. Run:  npm run server
//
import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { createBee } from "./bee.js";
import { previewMp3, setVoice } from "./tts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const PORT = process.env.PORT || 3001;

app.post("/api/token", async (req, res) => {
  try {
    const { code } = req.body;
    const r = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("Token exchange failed:", data);
      return res.status(500).json({ error: "token_exchange_failed" });
    }
    res.json({ access_token: data.access_token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));

// Debug voice preview: synthesize a sample in a given voice (and optionally make
// it the active game voice with ?set=1). Returns MP3 audio.
app.get("/api/voice-preview", async (req, res) => {
  const voice = String(req.query.voice || "");
  if (!voice) return res.status(400).send("missing voice");
  try {
    const b64 = await previewMp3("Your word is, lagoon.", voice);
    if (req.query.set === "1") setVoice(voice);
    res.set("Content-Type", "audio/mpeg");
    res.send(Buffer.from(b64, "base64"));
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

// --- Serve the built client (production / Railway) ---
// In dev, Vite serves the client on :5173 and proxies /api + /ws here, so dist/
// doesn't exist and this is skipped. In production the Node process serves the
// built client too, keeping client + /api + /ws same-origin on one port (which
// is what Discord's /.proxy mapping and Railway's single port both want).
const distDir = path.resolve(__dirname, "../dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // SPA fallback: any other GET (not /api, /ws, /healthz) returns index.html.
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api") || req.path.startsWith("/ws") || req.path === "/healthz") {
      return next();
    }
    res.sendFile(path.join(distDir, "index.html"));
  });
  console.log(`Serving built client from ${distDir}`);
} else {
  console.log("No dist/ found — dev mode (Vite serves the client on :5173).");
}

const server = app.listen(PORT, () => {
  console.log(`Token + room server listening on http://localhost:${PORT}`);
});

// --- Multiplayer room: relay positions + sync model assignments ---
const wss = new WebSocketServer({ server, path: "/ws" });
const players = new Map(); // socket -> { id, model }

const broadcast = (obj, except) => {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client !== except && client.readyState === 1) client.send(data);
  }
};

// Send a message to a single player by id (used to catch a spectator up).
const sendTo = (id, obj) => {
  const data = JSON.stringify(obj);
  for (const [sock, p] of players) {
    if (p.id === id && sock.readyState === 1) {
      sock.send(data);
      return;
    }
  }
};

// Pick a model not currently in use; once all are taken, the least-used one.
const pickModel = (count) => {
  const used = new Set([...players.values()].map((p) => p.model));
  for (let i = 0; i < count; i++) if (!used.has(i)) return i;
  const counts = new Array(count).fill(0);
  for (const p of players.values()) counts[p.model]++;
  let best = 0;
  for (let i = 1; i < count; i++) if (counts[i] < counts[best]) best = i;
  return best;
};

const bee = createBee(broadcast, sendTo, () => [...players.values()].map((p) => p.id));

wss.on("connection", (socket) => {
  socket.on("message", (buf) => {
    let m;
    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (m.type === "hello") {
      // Server assigns a unique model (kept distinct until all are used up).
      const model = pickModel(m.count || 1);
      players.set(socket, { id: m.id, model });
      // Tell the newcomer their assigned model + who's already here.
      socket.send(JSON.stringify({ type: "assign", model }));
      const roster = [...players.values()].filter((p) => p.id !== m.id);
      socket.send(JSON.stringify({ type: "roster", players: roster }));
      // Tell everyone else about the newcomer.
      broadcast({ type: "join", id: m.id, model }, socket);
      return;
    }
    if (m.type === "pos" || m.type === "say" || m.type === "emote") {
      broadcast(m, socket);
      return;
    }
    if (typeof m.type === "string" && m.type.startsWith("bee_")) {
      const pid = players.get(socket)?.id;
      if (pid) bee.handle(pid, m);
    }
  });

  socket.on("close", () => {
    const p = players.get(socket);
    players.delete(socket);
    if (p) {
      broadcast({ type: "leave", id: p.id });
      bee.removePlayer(p.id);
    }
  });
});
