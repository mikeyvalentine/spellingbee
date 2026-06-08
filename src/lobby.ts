import type { NetClient } from "./net";

export interface GameMode {
  key: string;
  emoji: string;
  name: string;
  desc: string;
  locked: boolean;
}

// Only "basic" is implemented for now; the rest are previewed as "soon".
export const MODES: GameMode[] = [
  { key: "basic", emoji: "📚", name: "Basic", desc: "Round-robin. Miss your word and you're out.", locked: false },
  { key: "knockout", emoji: "💥", name: "Knockout", desc: "Everyone spells at once on a fast timer. Slowest is cooked.", locked: true },
  { key: "jklm", emoji: "🔤", name: "Letter Scramble", desc: "Spell any word using the letters in the center.", locked: true },
  { key: "theme", emoji: "🖼️", name: "Photo / Theme", desc: "“What is this?” — spell the thing you're shown.", locked: true },
];

interface LobbyOpts {
  net: NetClient;
  localId: string;
  getName: (id: string) => string;
  isMock: boolean;
  /** This client's home room (its Discord call, or a dev default) to return to. */
  callRoomKey: string;
}

export interface LobbyController {
  onLobbyState(state: any): void;
  /** Public-room auto-start countdown updates (bee_countdown). */
  onCountdown(m: any): void;
  show(): void;
  hide(): void;
  selectedMode(): string;
}

export function setupLobby(opts: LobbyOpts): LobbyController {
  const { net, localId, getName, isMock, callRoomKey } = opts;
  const lobbyEl = document.getElementById("lobby")!;
  const modesEl = document.getElementById("modes")!;
  const rosterEl = document.getElementById("roster")!;
  const actionsEl = document.getElementById("lobby-actions")!;
  const hintEl = document.getElementById("lobby-hint")!;
  const subEl = document.getElementById("lobby-sub")!;
  const cdEl = document.getElementById("lobby-countdown")!;

  // Matchmaking overlay
  const mmOverlay = document.getElementById("mm-overlay")!;
  const mmList = document.getElementById("mm-list")!;
  const mmQuick = document.getElementById("mm-quick")!;
  const mmCreate = document.getElementById("mm-create")!;
  const mmRefresh = document.getElementById("mm-refresh")!;
  const mmClose = document.getElementById("mm-close")!;

  let selected = "basic";
  let lastState: any = null;
  let inPublic = false; // true while connected to a pub:<id> room
  let publicRoomId: string | null = null;
  let cdRaf = 0;

  // Bottom-center "[host]'s Class" / "Public Match" label.
  const classTitle = document.createElement("div");
  classTitle.id = "class-title";
  Object.assign(classTitle.style, {
    position: "fixed", left: "50%", bottom: "20px", transform: "translateX(-50%)",
    zIndex: "20", display: "none", color: "#f4f1e8",
    font: "600 22px system-ui, sans-serif", textShadow: "0 2px 6px rgba(0,0,0,0.6)",
    pointerEvents: "none", userSelect: "none",
  } as any);
  document.body.appendChild(classTitle);

  // ---- matchmaking ----
  const api = (path: string) => fetch(path).then((r) => r.json());

  const goToRoom = (roomKey: string, isPub: boolean, roomId: string | null) => {
    inPublic = isPub;
    publicRoomId = roomId;
    cdEl.classList.remove("on"); // clear any stale countdown from the old room
    cancelAnimationFrame(cdRaf);
    net.setRoom(roomKey);
    closeMM();
  };

  const quickMatch = async () => {
    try {
      const { roomId } = await api("/api/mm/quick");
      if (roomId) goToRoom(`pub:${roomId}`, true, roomId);
    } catch { /* ignore */ }
  };
  const createRoom = async () => {
    try {
      const { roomId } = await api("/api/mm/create");
      if (roomId) goToRoom(`pub:${roomId}`, true, roomId);
    } catch { /* ignore */ }
  };
  const joinRoom = (roomId: string) => goToRoom(`pub:${roomId}`, true, roomId);
  const leavePublic = () => goToRoom(callRoomKey, false, null);

  const refreshList = async () => {
    mmList.innerHTML = '<div class="mm-empty">Loading…</div>';
    try {
      const { rooms } = await api("/api/mm/list");
      if (!rooms?.length) {
        mmList.innerHTML = '<div class="mm-empty">No open rooms — quick match or create one!</div>';
        return;
      }
      mmList.innerHTML = rooms
        .map((r: any) => {
          const full = r.players >= 6;
          const playing = r.phase === "match";
          const disabled = full || playing;
          const status = playing ? "in match" : full ? "full" : "waiting";
          return `<div class="mm-room">
            <div>
              <div class="mm-room-code">${r.roomId}</div>
              <div class="mm-room-meta">${r.players}/6 · ${status}</div>
            </div>
            <button class="mm-join" data-room="${r.roomId}" ${disabled ? "disabled" : ""}>Join</button>
          </div>`;
        })
        .join("");
      for (const b of Array.from(mmList.querySelectorAll<HTMLElement>(".mm-join"))) {
        b.addEventListener("click", () => joinRoom(b.dataset.room!));
      }
    } catch {
      mmList.innerHTML = '<div class="mm-empty">Couldn’t load rooms.</div>';
    }
  };

  const openMM = () => {
    mmOverlay.classList.add("on");
    refreshList();
  };
  const closeMM = () => mmOverlay.classList.remove("on");

  mmQuick.addEventListener("click", quickMatch);
  mmCreate.addEventListener("click", createRoom);
  mmRefresh.addEventListener("click", refreshList);
  mmClose.addEventListener("click", closeMM);
  mmOverlay.addEventListener("click", (e) => {
    if (e.target === mmOverlay) closeMM(); // click backdrop to dismiss
  });

  // ---- auto-start countdown (public rooms) ----
  const onCountdown = (m: any) => {
    cancelAnimationFrame(cdRaf);
    if (m.cancelled || !m.ms) {
      cdEl.classList.remove("on");
      return;
    }
    const end = Date.now() + m.ms;
    cdEl.classList.add("on");
    const tick = () => {
      const left = Math.max(0, end - Date.now());
      cdEl.innerHTML = `<div class="cd-num">${Math.ceil(left / 1000)}</div><div class="cd-label">match starting…</div>`;
      if (left > 0) cdRaf = requestAnimationFrame(tick);
      else cdEl.classList.remove("on");
    };
    tick();
  };

  // ---- mode cards ----
  const visibleModes = MODES.filter((m) => !m.locked);
  const renderModes = () => {
    modesEl.innerHTML = visibleModes
      .map(
        (m) => `
      <div class="mode ${m.locked ? "locked" : ""} ${m.key === selected ? "selected" : ""}" data-mode="${m.key}">
        ${m.locked ? '<div class="m-soon">SOON</div>' : ""}
        <div class="m-name">${m.emoji} ${m.name}</div>
        <div class="m-desc">${m.desc}</div>
      </div>`
      ).join("");
    for (const el of Array.from(modesEl.querySelectorAll<HTMLElement>(".mode"))) {
      el.addEventListener("click", () => {
        const key = el.dataset.mode!;
        const mode = MODES.find((m) => m.key === key);
        if (!mode || mode.locked) return;
        selected = key;
        renderModes();
      });
    }
  };

  // ---- roster + actions ----
  const render = (s: any) => {
    lastState = s;
    const queue: string[] = s.queue ?? [];
    const ready: string[] = s.ready ?? [];
    const isHost = s.hostId === localId;
    const inQueue = queue.includes(localId);
    const amReady = ready.includes(localId);

    if (inPublic) {
      subEl.innerHTML = `Public room <span class="code">${publicRoomId ?? ""}</span> · ${queue.length} player${queue.length === 1 ? "" : "s"}`;
      classTitle.textContent = "Public Match";
    } else {
      subEl.textContent = "";
      classTitle.textContent = s.hostId ? `${getName(s.hostId)}'s Class` : "";
    }

    // Public rooms have no ready/host system — show a neutral marker instead of ticks.
    rosterEl.innerHTML =
      queue.length === 0
        ? '<div class="roster-empty">Waiting for players…</div>'
        : queue
            .map((id) => {
              const tick = inPublic ? "•" : ready.includes(id) ? "✅" : "⬜";
              const you = id === localId ? " (you)" : "";
              const isHostRow = !inPublic && id === s.hostId;
              const name = `${getName(id)}${you}`;
              return `<div class="roster-row"><span class="tick">${tick}</span><span class="roster-name${isHostRow ? " host" : ""}">${name}</span></div>`;
            })
            .join("");

    const btns: string[] = [];
    if (inPublic) {
      btns.push(`<button class="btn secondary" id="lb-leave">← Leave room</button>`);
    } else {
      if (inQueue) {
        btns.push(`<button class="btn secondary" id="lb-ready">${amReady ? "Unready" : "Ready"}</button>`);
      } else {
        btns.push(`<button class="btn" id="lb-join">Join</button>`);
      }
      if (isHost) btns.push(`<button class="btn" id="lb-start">Start match</button>`);
      if (inQueue && !isHost) btns.push(`<button class="btn secondary" id="lb-host">Become host</button>`);
      if (isMock || isHost) btns.push(`<button class="btn secondary" id="lb-bots">+ Add bots</button>`);
      btns.push(`<button class="btn" id="lb-public">🌐 Play public</button>`);
    }
    actionsEl.innerHTML = btns.join("");

    document.getElementById("lb-public")?.addEventListener("click", openMM);
    document.getElementById("lb-leave")?.addEventListener("click", leavePublic);
    document.getElementById("lb-host")?.addEventListener("click", () => net.sendBee({ type: "bee_claimhost" }));
    document.getElementById("lb-ready")?.addEventListener("click", () => net.sendBee({ type: "bee_ready", ready: !amReady }));
    document.getElementById("lb-join")?.addEventListener("click", () => net.sendBee({ type: "bee_join" }));
    document.getElementById("lb-start")?.addEventListener("click", () => net.sendBee({ type: "bee_begin", mode: selected }));
    document.getElementById("lb-bots")?.addEventListener("click", () => net.sendBee({ type: "bee_addbots", n: 4 }));

    // Modes only matter for the host-started private flow.
    modesEl.style.display = inPublic ? "none" : "";

    if (inPublic) {
      hintEl.textContent = queue.length < 2 ? "Waiting for another player to join…" : "";
    } else {
      hintEl.textContent = isHost ? "" : "Waiting for the host to start the match.";
    }
  };

  renderModes();

  return {
    onLobbyState(state) {
      render(state);
    },
    onCountdown(m) {
      onCountdown(m);
    },
    show() {
      lobbyEl.style.display = "flex";
      classTitle.style.display = "block";
      if (lastState) render(lastState);
    },
    hide() {
      lobbyEl.style.display = "none";
      classTitle.style.display = "none";
      cdEl.classList.remove("on");
      cancelAnimationFrame(cdRaf);
    },
    selectedMode: () => selected,
  };
}
