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
}

export interface LobbyController {
  onLobbyState(state: any): void;
  show(): void;
  hide(): void;
  selectedMode(): string;
}

export function setupLobby(opts: LobbyOpts): LobbyController {
  const { net, localId, getName, isMock } = opts;
  const lobbyEl = document.getElementById("lobby")!;
  const modesEl = document.getElementById("modes")!;
  const rosterEl = document.getElementById("roster")!;
  const actionsEl = document.getElementById("lobby-actions")!;
  const hintEl = document.getElementById("lobby-hint")!;

  let selected = "basic";
  let lastState: any = null;

  // ---- mode cards ----
  // Only show playable modes for now; the rest stay defined in MODES for later.
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

    rosterEl.innerHTML =
      queue.length === 0
        ? '<div class="roster-empty">Waiting for players…</div>'
        : queue
            .map((id) => {
              const tick = ready.includes(id) ? "✅" : "⬜";
              const you = id === localId ? " (you)" : "";
              const isHostRow = id === s.hostId;
              const name = `${isHostRow ? "(Host) " : ""}${getName(id)}${you}`;
              return `<div class="roster-row"><span class="tick">${tick}</span><span class="roster-name${isHostRow ? " host" : ""}">${name}</span></div>`;
            })
            .join("");

    const btns: string[] = [];
    if (inQueue) {
      btns.push(`<button class="btn secondary" id="lb-ready">${amReady ? "Unready" : "Ready"}</button>`);
    } else {
      btns.push(`<button class="btn" id="lb-join">Join</button>`);
    }
    if (isHost) {
      btns.push(`<button class="btn" id="lb-start">Start match</button>`);
    }
    if (inQueue && !isHost) {
      btns.push(`<button class="btn secondary" id="lb-host">Become host</button>`);
    }
    if (isMock || isHost) {
      btns.push(`<button class="btn secondary" id="lb-bots">+ Add bots</button>`);
    }
    actionsEl.innerHTML = btns.join("");

    document.getElementById("lb-host")?.addEventListener("click", () =>
      net.sendBee({ type: "bee_claimhost" })
    );

    document.getElementById("lb-ready")?.addEventListener("click", () =>
      net.sendBee({ type: "bee_ready", ready: !amReady })
    );
    document.getElementById("lb-join")?.addEventListener("click", () =>
      net.sendBee({ type: "bee_join" })
    );
    document.getElementById("lb-start")?.addEventListener("click", () =>
      net.sendBee({ type: "bee_begin", mode: selected })
    );
    document.getElementById("lb-bots")?.addEventListener("click", () =>
      net.sendBee({ type: "bee_addbots", n: 4 })
    );

    hintEl.textContent = isHost ? "" : "Waiting for the host to start the match.";
  };

  renderModes();

  return {
    onLobbyState(state) {
      render(state);
    },
    show() {
      lobbyEl.style.display = "flex";
      if (lastState) render(lastState);
    },
    hide() {
      lobbyEl.style.display = "none";
    },
    selectedMode: () => selected,
  };
}
