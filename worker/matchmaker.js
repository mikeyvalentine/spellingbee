// Singleton Durable Object that coordinates PUBLIC rooms. Each public BeeRoom
// reports its player-count + phase here (on change and via a heartbeat); this DO
// answers quick-match ("give me an open room") and list ("show open rooms").
//
// The registry lives in DO storage (SQLite-backed) so it survives eviction —
// rooms also heartbeat, so a stale entry self-heals within HEARTBEAT seconds.
export const ROOM_CAP = 6; // max players matched into one public room
const STALE_MS = 45_000; // drop rooms that haven't reported in this long
const KEY = (roomId) => `room:${roomId}`;

// Joinable = in the lobby (not mid-match) with a free seat.
const isJoinable = (r) => (r.phase === "lobby" || r.phase === "idle") && r.players < ROOM_CAP;

export class Matchmaker {
  constructor(state) {
    this.state = state;
    this.storage = state.storage;
  }

  async all(now) {
    const map = await this.storage.list({ prefix: "room:" });
    const out = [];
    const stale = [];
    for (const [key, r] of map) {
      if (now - r.updatedAt > STALE_MS) stale.push(key);
      else out.push(r);
    }
    if (stale.length) await this.storage.delete(stale);
    return out;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();

    // A room reports its status: { roomId, players, phase }.
    if (url.pathname === "/report" && request.method === "POST") {
      const { roomId, players, phase } = await request.json();
      if (!roomId) return new Response("bad", { status: 400 });
      if (!players || players <= 0) await this.storage.delete(KEY(roomId));
      else await this.storage.put(KEY(roomId), { roomId, players, phase, updatedAt: now });
      return Response.json({ ok: true });
    }

    // Browse: list of open public rooms with at least one player (hide empty
    // reserved placeholders); joinable + fullest first.
    if (url.pathname === "/list") {
      const rooms = (await this.all(now)).filter((r) => r.players > 0);
      rooms.sort((a, b) => Number(isJoinable(b)) - Number(isJoinable(a)) || b.players - a.players);
      return Response.json({ rooms });
    }

    // Create: always a brand-new reserved room (the user wants their own).
    if (url.pathname === "/create") {
      const roomId = this.newRoomId();
      await this.storage.put(KEY(roomId), { roomId, players: 0, phase: "idle", updatedAt: now });
      return Response.json({ roomId });
    }

    // Quick match: the joinable room with the MOST players (fill rooms before
    // spreading thin); if none, mint a new id AND reserve it so a simultaneous
    // quick-match converges on the same room instead of minting its own.
    if (url.pathname === "/quick") {
      const rooms = (await this.all(now)).filter(isJoinable);
      rooms.sort((a, b) => b.players - a.players);
      let roomId = rooms[0]?.roomId;
      if (!roomId) {
        roomId = this.newRoomId();
        await this.storage.put(KEY(roomId), { roomId, players: 0, phase: "idle", updatedAt: now });
      }
      return Response.json({ roomId });
    }

    return new Response("not found", { status: 404 });
  }

  newRoomId() {
    // Short, readable, unambiguous (no 0/O/1/I) room code.
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const buf = new Uint8Array(5);
    crypto.getRandomValues(buf);
    let id = "";
    for (const b of buf) id += abc[b % abc.length];
    return id;
  }
}
