type ModelCb = (id: string, model: number) => void;

export interface NetClient {
  sendBee(msg: Record<string, unknown>): void;
  onModel(cb: ModelCb): void;
  onBee(cb: (msg: any) => void): void;
  onLeave(cb: (id: string) => void): void;
  /** Fires every time the socket (re)connects and has sent its hello. */
  onReady(cb: () => void): void;
}

/**
 * WebSocket transport. Carries the server-assigned character model for each
 * player plus all Spelling Bee game messages (lobby + match). Auto-reconnects.
 */
export function connectNet(
  url: string,
  localId: string,
  modelCount: number
): NetClient {
  let ws: WebSocket | null = null;
  let modelCb: ModelCb = () => {};
  let beeCb: (msg: any) => void = () => {};
  let leaveCb: (id: string) => void = () => {};
  let readyCb: () => void = () => {};

  const connect = () => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      ws?.send(JSON.stringify({ type: "hello", id: localId, count: modelCount }));
      readyCb();
    };
    ws.onmessage = (ev) => {
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
    ws.onclose = () => setTimeout(connect, 1500); // auto-reconnect
    ws.onerror = () => ws?.close();
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
  };
}
