import type { NetClient } from "./net";
import type { ClipboardView } from "./clipboard";

export interface GameMode {
  key: string;
  emoji: string;
  name: string;
  locked: boolean;
}

export const MODES: GameMode[] = [
  { key: "basic", emoji: "📚", name: "Basic", locked: false },
  { key: "knockout", emoji: "💥", name: "Knockout", locked: true },
  { key: "jklm", emoji: "🔤", name: "Letter Scramble", locked: true },
  { key: "theme", emoji: "🖼️", name: "Photo / Theme", locked: true },
];

interface LobbyOpts {
  net: NetClient;
  localId: string;
  getName: (id: string) => string;
  isMock: boolean;
  callRoomKey: string;
  clipboard: ClipboardView;
}

export interface LobbyController {
  onLobbyState(state: any): void;
  onCountdown(m: any): void;
  show(): void;
  hide(): void;
  frame(): void; // per render frame: position the paper panel over the 3D clipboard
  selectedMode(): string;
}

const $ = (id: string) => document.getElementById(id)!;

export function setupLobby(opts: LobbyOpts): LobbyController {
  const { net, localId, getName, isMock, callRoomKey, clipboard } = opts;

  const peekEl = $("clip-peek"), peekTextEl = $("clip-peek-text");
  const panelEl = $("clip-panel"), closeBtn = $("clip-close");
  const tapzoneEl = $("clip-tapzone"), backdropEl = $("clip-backdrop");
  const roomEl = $("cp-room"), countEl = $("cp-count"), cdEl = $("cp-cd");
  const settingsEl = $("cp-settings"), modeSel = $("cp-mode") as HTMLSelectElement;
  const maxEl = $("cp-max"), maxDec = $("cp-max-dec") as HTMLButtonElement, maxInc = $("cp-max-inc") as HTMLButtonElement;
  const visEl = $("cp-vis"), rosterEl = $("cp-roster"), actionsEl = $("cp-actions");
  const findEl = $("cp-find"), listEl = $("cp-list");
  const quickBtn = $("cp-quick"), createBtn = $("cp-create"), refreshBtn = $("cp-refresh");

  let lastState: any = null;
  let shown = false;
  let inPublic = false;
  let publicRoomId: string | null = null;
  let selected = "basic";
  let maxPlayers = 8;
  let cdEnd = 0;

  const isHost = () => !!lastState && lastState.hostId === localId;

  // ---- matchmaking (folded into the "Find a public game" section) ----
  const api = (p: string) => fetch(p).then((r) => r.json());
  const goToRoom = (roomKey: string, isPub: boolean, roomId: string | null) => {
    inPublic = isPub;
    publicRoomId = roomId;
    cdEnd = 0;
    net.setRoom(roomKey);
  };
  const quickMatch = async () => { try { const { roomId } = await api("/api/mm/quick"); if (roomId) goToRoom(`pub:${roomId}`, true, roomId); } catch {} };
  const createRoom = async () => { try { const { roomId } = await api("/api/mm/create"); if (roomId) goToRoom(`pub:${roomId}`, true, roomId); } catch {} };
  const joinRoom = (roomId: string) => goToRoom(`pub:${roomId}`, true, roomId);
  const leavePublic = () => goToRoom(callRoomKey, false, null);

  const refreshList = async () => {
    listEl.innerHTML = '<div class="cp-empty">Loading…</div>';
    try {
      const { rooms } = await api("/api/mm/list");
      if (!rooms?.length) { listEl.innerHTML = '<div class="cp-empty">No open rooms — quick match or create one!</div>'; return; }
      listEl.innerHTML = rooms.map((r: any) => {
        const full = r.players >= 6, playing = r.phase === "match", disabled = full || playing;
        const status = playing ? "in match" : full ? "full" : "waiting";
        return `<div class="cp-room"><div><div class="cp-room-code">${r.roomId}</div><div class="cp-room-meta">${r.players}/6 · ${status}</div></div>
          <button class="cp-join" data-room="${r.roomId}" ${disabled ? "disabled" : ""}>Join</button></div>`;
      }).join("");
      for (const b of Array.from(listEl.querySelectorAll<HTMLElement>(".cp-join"))) b.addEventListener("click", () => joinRoom(b.dataset.room!));
    } catch { listEl.innerHTML = '<div class="cp-empty">Couldn’t load rooms.</div>'; }
  };

  // ---- mode dropdown (Basic playable; others shown as "soon") ----
  modeSel.innerHTML = MODES.map((m) => `<option value="${m.key}" ${m.locked ? "disabled" : ""}>${m.emoji} ${m.name}${m.locked ? " — soon" : ""}</option>`).join("");
  modeSel.addEventListener("change", () => {
    selected = modeSel.value;
    if (isHost()) net.sendBee({ type: "bee_settings", mode: selected });
  });
  maxDec.addEventListener("click", () => { if (isHost()) net.sendBee({ type: "bee_settings", maxPlayers: Math.max(2, maxPlayers - 1) }); });
  maxInc.addEventListener("click", () => { if (isHost()) net.sendBee({ type: "bee_settings", maxPlayers: Math.min(12, maxPlayers + 1) }); });
  for (const b of Array.from(visEl.querySelectorAll<HTMLElement>("button"))) {
    b.addEventListener("click", () => {
      const v = b.dataset.v;
      if (v === "public" && !inPublic) createRoom(); // go public: spin up a matchmade room you host
      else if (v === "private" && inPublic) leavePublic(); // back to your call's private room
    });
  }
  quickBtn.addEventListener("click", quickMatch);
  createBtn.addEventListener("click", createRoom);
  refreshBtn.addEventListener("click", refreshList);

  // ---- open / close the clipboard ----
  // NDC relative to the canvas rect (mobile/Discord can offset it — window coords miss).
  const sceneCanvas = document.getElementById("app") as HTMLCanvasElement;
  const ndcOf = (e: PointerEvent) => {
    const r = sceneCanvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1] as const;
  };
  peekEl.addEventListener("click", () => clipboard.focus());
  closeBtn.addEventListener("click", () => clipboard.blur());
  // DOM tap targets (work in webviews that swallow window touch events):
  // the lower-screen tap-zone opens, the backdrop (behind the focused panel) closes.
  tapzoneEl.addEventListener("click", () => clipboard.focus());
  backdropEl.addEventListener("click", () => clipboard.blur());
  window.addEventListener("pointermove", (e) => {
    if (!shown || clipboard.isFocused()) { clipboard.setHover(false); peekEl.classList.remove("hot"); return; }
    // One combined hover zone: the peek strip OR the 3D clipboard raises both.
    const t = e.target as HTMLElement;
    const overPeek = !!(t.closest && t.closest("#clip-peek"));
    const [x, y] = ndcOf(e);
    const over = overPeek || clipboard.hitTest(x, y);
    clipboard.setHover(over);
    peekEl.classList.toggle("hot", over);
  });
  const isTouch = window.matchMedia("(pointer: coarse)").matches;
  window.addEventListener("pointerdown", (e) => {
    if (!shown) return;
    const t = e.target as HTMLElement;
    const onPanel = !!(t.closest && t.closest("#clip-panel"));
    const onPeek = !!(t.closest && t.closest("#clip-peek"));
    const [x, y] = ndcOf(e);
    const onClip = clipboard.hitTest(x, y);
    if (clipboard.isFocused()) {
      // Tapping anywhere off the paper panel closes it. (When focused the
      // clipboard mesh fills the view, so we must NOT treat a mesh hit as "inside"
      // — only the panel counts, otherwise tap-outside could never register.)
      if (!onPanel) clipboard.blur();
    } else {
      // Open by tapping the clipboard or its peek strip. On touch the visible
      // clipboard sliver is small, so also open on a tap in the lower half of the
      // screen (the only thing down there in peek state is the clipboard).
      const onOtherUi = !!(t.closest && (t.closest("#menu-btn") || t.closest("#menu-panel") || t.closest("#item-menu")));
      const lowerTap = isTouch && e.clientY > window.innerHeight * 0.5 && !onOtherUi;
      if (onClip || onPeek || lowerTap) clipboard.focus();
    }
  });

  // ---- render the paper content ----
  const render = (s: any) => {
    lastState = s;
    const queue: string[] = s.queue ?? [];
    const ready: string[] = s.ready ?? [];
    const host = s.hostId === localId;
    const inQueue = queue.includes(localId);
    const amReady = ready.includes(localId);
    maxPlayers = s.maxPlayers ?? maxPlayers;
    if (s.mode) { selected = s.mode; if (modeSel.value !== selected) modeSel.value = selected; }

    const roomName = inPublic ? `Public room ${publicRoomId ?? ""}` : s.hostId ? `${getName(s.hostId)}'s Class` : "Lobby";
    roomEl.textContent = roomName;
    countEl.textContent = `${queue.length}/${maxPlayers}`;
    peekTextEl.textContent = `${roomName} · ${queue.length}/${maxPlayers}`;

    // Room settings + Find-a-game only apply to your own (private) room.
    settingsEl.style.display = inPublic ? "none" : "";
    findEl.style.display = inPublic ? "none" : "";
    modeSel.disabled = !host;
    maxEl.textContent = String(maxPlayers);
    maxDec.disabled = !host; maxInc.disabled = !host;
    for (const b of Array.from(visEl.querySelectorAll<HTMLElement>("button"))) {
      const on = (b.dataset.v === "public") === inPublic;
      b.classList.toggle("on", on);
    }

    rosterEl.innerHTML = queue.length === 0
      ? '<div class="cp-empty">Waiting for players…</div>'
      : queue.map((id) => {
          const tick = inPublic ? "•" : ready.includes(id) ? "✅" : "⬜";
          const you = id === localId ? " (you)" : "";
          const isH = !inPublic && id === s.hostId;
          return `<div class="cp-prow"><span class="cp-tick">${tick}</span><span class="cp-name${isH ? " host" : ""}">${getName(id)}${you}</span></div>`;
        }).join("");

    const btns: string[] = [];
    if (inPublic) {
      btns.push(`<button class="cpb sec" id="cp-leave">← Leave room</button>`);
    } else {
      if (inQueue) btns.push(`<button class="cpb sec" id="cp-ready">${amReady ? "Unready" : "Ready"}</button>`);
      else btns.push(`<button class="cpb" id="cp-join">Join</button>`);
      if (host) btns.push(`<button class="cpb" id="cp-start">Start match</button>`);
      if (inQueue && !host) btns.push(`<button class="cpb sec" id="cp-claimhost">Become host</button>`);
      if (isMock || host) btns.push(`<button class="cpb sec" id="cp-bots">+ Bots</button>`);
    }
    actionsEl.innerHTML = btns.join("");
    $("cp-leave")?.addEventListener("click", leavePublic);
    $("cp-ready")?.addEventListener("click", () => net.sendBee({ type: "bee_ready", ready: !amReady }));
    $("cp-join")?.addEventListener("click", () => net.sendBee({ type: "bee_join" }));
    $("cp-start")?.addEventListener("click", () => net.sendBee({ type: "bee_begin", mode: selected }));
    $("cp-claimhost")?.addEventListener("click", () => net.sendBee({ type: "bee_claimhost" }));
    $("cp-bots")?.addEventListener("click", () => net.sendBee({ type: "bee_addbots", n: 4 }));
  };

  return {
    onLobbyState(state) { render(state); },
    onCountdown(m) { cdEnd = m.cancelled || !m.ms ? 0 : Date.now() + m.ms; },
    show() {
      shown = true;
      clipboard.setVisible(true);
      if (lastState) render(lastState);
    },
    hide() {
      shown = false;
      clipboard.setVisible(false);
      panelEl.classList.remove("show");
      peekEl.classList.remove("show");
      tapzoneEl.classList.remove("show");
      backdropEl.classList.remove("show");
    },
    frame() {
      if (!shown) {
        panelEl.classList.remove("show");
        peekEl.classList.remove("show");
        tapzoneEl.classList.remove("show");
        backdropEl.classList.remove("show");
        return;
      }
      const focused = clipboard.isFocused();
      // Mobile DOM tap targets: tap-zone opens (peek state), backdrop closes (focused).
      tapzoneEl.classList.toggle("show", isTouch && !focused);
      backdropEl.classList.toggle("show", isTouch && focused);
      const r = focused ? clipboard.paperRect() : null;
      if (r) {
        panelEl.style.left = `${Math.round(r.x)}px`;
        panelEl.style.top = `${Math.round(r.y - 28)}px`;
        panelEl.style.width = `${Math.round(r.w)}px`;
        panelEl.style.height = `${Math.round(r.h + 28)}px`;
        panelEl.classList.add("show");
      } else {
        panelEl.classList.remove("show");
      }
      peekEl.classList.toggle("show", !clipboard.isFocused());
      if (cdEnd) {
        const left = Math.max(0, cdEnd - Date.now());
        cdEl.textContent = left > 0 ? `· starting in ${Math.ceil(left / 1000)}s` : "";
        if (left <= 0) cdEnd = 0;
      } else if (cdEl.textContent) cdEl.textContent = "";
    },
    selectedMode: () => selected,
  };
}
