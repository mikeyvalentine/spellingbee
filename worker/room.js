// Durable Object that owns one game room: all live WebSocket connections plus
// the in-memory game state. This is the Cloudflare equivalent of the WebSocket
// half of server/index.js — the same game logic (server/bee.js) runs here,
// unchanged, because it only talks to the outside via broadcast/sendTo/getIds.
//
// We use the standard WebSocket API (server.accept()), NOT hibernation, so the
// DO stays resident while sockets are open and bee.js's setTimeout-driven turn
// timers fire exactly like under Node.
import { createBee } from "../server/bee.js";
import { configureTts } from "../server/tts.js";

export class BeeRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // The game logic calls Google TTS; hand it the Worker's secret/voice bindings.
    configureTts({
      apiKey: env.GOOGLE_TTS_API_KEY,
      voice: env.GOOGLE_TTS_VOICE,
      rate: env.GOOGLE_TTS_RATE,
    });

    this.players = new Map(); // ws -> { id, model }

    this.bee = createBee(
      (obj, except) => this.broadcast(obj, except),
      (id, obj) => this.sendTo(id, obj),
      () => [...this.players.values()].map((p) => p.id)
    );
  }

  broadcast(obj, except) {
    const data = JSON.stringify(obj);
    for (const ws of this.players.keys()) {
      if (ws !== except && ws.readyState === 1) {
        try { ws.send(data); } catch { /* socket going away */ }
      }
    }
  }

  sendTo(id, obj) {
    const data = JSON.stringify(obj);
    for (const [ws, p] of this.players) {
      if (p.id === id && ws.readyState === 1) {
        try { ws.send(data); } catch { /* ignore */ }
        return;
      }
    }
  }

  // Pick a model not currently in use; once all are taken, the least-used one.
  pickModel(count) {
    const used = new Set([...this.players.values()].map((p) => p.model));
    for (let i = 0; i < count; i++) if (!used.has(i)) return i;
    const counts = new Array(count).fill(0);
    for (const p of this.players.values()) counts[p.model]++;
    let best = 0;
    for (let i = 1; i < count; i++) if (counts[i] < counts[best]) best = i;
    return best;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.players.set(server, { id: null, model: 0 });

    server.addEventListener("message", (ev) => this.onMessage(server, ev.data));
    const drop = () => this.onClose(server);
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(socket, raw) {
    let m;
    try {
      m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    if (m.type === "hello") {
      const model = this.pickModel(m.count || 1);
      this.players.set(socket, { id: m.id, model });
      socket.send(JSON.stringify({ type: "assign", model }));
      const roster = [...this.players.values()].filter((p) => p.id && p.id !== m.id);
      socket.send(JSON.stringify({ type: "roster", players: roster }));
      this.broadcast({ type: "join", id: m.id, model }, socket);
      return;
    }

    if (m.type === "pos" || m.type === "say" || m.type === "emote") {
      this.broadcast(m, socket);
      return;
    }

    if (typeof m.type === "string" && m.type.startsWith("bee_")) {
      const pid = this.players.get(socket)?.id;
      if (pid) this.bee.handle(pid, m);
    }
  }

  onClose(socket) {
    const p = this.players.get(socket);
    this.players.delete(socket);
    if (p && p.id) {
      this.broadcast({ type: "leave", id: p.id });
      this.bee.removePlayer(p.id);
    }
  }
}
