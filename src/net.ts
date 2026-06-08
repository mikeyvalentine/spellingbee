type ModelCb = (id: string, model: number) => void;

export interface NetClient {
  sendBee(msg: Record<string, unknown>): void;
  onModel(cb: ModelCb): void;
  onBee(cb: (msg: any) => void): void;
  onLeave(cb: (id: string) => void): void;
  /** Fires every time the socket (re)connects and has sent its hello. */
  onReady(cb: () => void): void;
  /** Reconnect to a different game room (private call <-> public matchmaking). */
  setRoom(roomKey: string): void;
  /** The room currently connected to. */
  currentRoom(): string;
}

/**
 * WebSocket transport. Carries the server-assigned character model for each
 * player plus all Spelling Bee game messages (lobby + match). Auto-reconnects,
 * and can hop between rooms (per-call vs public matchmaking) via setRoom().
 */
export function connectNet(
  baseUrl: string,
  localId: string,
  modelCount: number,
  initialRoom: string
): NetClient {
  let ws: WebSocket | null = null;
  let room = initialRoom;
  let modelCb: ModelCb = () => {};
  let beeCb: (msg: any) => void = () => {};
  let leaveCb: (id: string) => void = () => {};
  let readyCb: () => void = () => {};

  const url = () => `${baseUrl}?room=${encodeURIComponent(room)}`;

  const connect = () => {
    const sock = new WebSocket(url());
    ws = sock;
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: "hello", id: localId, count: modelCount }));
      readyCb();
    };
    sock.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data as string);
        switch (m.type) {
          case "assign":
            modelCb(localId, m.model); // server's unique model for us
            break;
          case "join":
            if (m.id !== localId) modelCb(m.id, m.model);
            break;
          case "roster":
            for (const p of m.players ?? []) {
              if (p.id !== localId) modelCb(p.id, p.model);
            }
            break;
          case "leave":
            leaveCb(m.id);
            break;
          default:
            if (typeof m.type === "string" && m.type.startsWith("bee_")) beeCb(m);
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    // Only auto-reconnect if this socket is still the active one (a room switch
    // detaches it first, so its close must NOT trigger a reconnect to the old room).
    sock.onclose = () => {
      if (ws === sock) setTimeout(connect, 1500);
    };
    sock.onerror = () => sock.close();
  };
  connect();

  return {
    sendBee(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ ...msg, id: localId }));
      }
    },
    onModel(cb) {
      modelCb = cb;
    },
    onBee(cb) {
      beeCb = cb;
    },
    onLeave(cb) {
      leaveCb = cb;
    },
    onReady(cb) {
      readyCb = cb;
    },
    setRoom(newRoom) {
      if (newRoom === room) return;
      room = newRoom;
      const old = ws;
      ws = null; // detach so old.onclose won't reconnect to the previous room
      try {
        old?.close();
      } catch {
        /* ignore */
      }
      connect();
    },
    currentRoom: () => room,
  };
}
