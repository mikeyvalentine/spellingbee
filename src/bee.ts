import * as THREE from "three";
import type { NetClient } from "./net";
import type { AvatarManager } from "./avatars";
import { genSplatBlobs, drawSplatShape } from "./classroom";
import type { Classroom, CameraPose } from "./classroom";
import { makeTomatoFlights } from "./tomato";
import type { AudioBus } from "./audio";

interface BeeOpts {
  net: NetClient;
  localId: string;
  getName: (id: string) => string;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene; // tomato flights live in the scene
  avatars: AvatarManager;
  classroom: Classroom;
  audio: AudioBus; // master audio bus (TTS + clicks route to its sfx node)
  callRoomKey: string; // this client's home room, to return to on "leave match"
  isUiFocused?: () => boolean; // the lobby clipboard is up — eases the free-look back to center
  debug?: boolean; // mock/dev: re-apply seat/speller transforms each frame (live sliders)
}

export interface BeeStage {
  update(dt: number): void; // per-frame: drive the render camera + speller + tomato
  handle(m: any): void;
}

// Fixed model per seat (join-order chair), so each chair always shows the same
// character — keeps the per-chair height offsets valid and is consistent across
// clients (bots would otherwise be assigned random models per client).
// Model order matches CHARACTER_URLS in main.ts:
// 0 Astronaut · 1 Blue Demon · 2 Cactoro · 3 Demon · 4 Fish · 5 Ninja · 6 Zombie
// Fixed model per join-order chair (8 chairs). To tune the OTHER models' seat
// fit with bots, temporarily change these indices to the model you want seated
// (model index = order in CHARACTER_URLS; there are more models than chairs).
const CHAIR_MODELS = [0, 1, 2, 3, 4, 5, 6, 7];

// Mask profanity in displayed guesses (board + spectators). Unambiguous terms
// only, so real words like "class"/"assignment" aren't false-flagged.
const SWEARS = [
  "motherfucker", "bullshit", "fuck", "shit", "bitch", "cunt", "pussy",
  "faggot", "nigger", "nigga", "whore", "slut", "asshole", "bastard",
  "wanker", "twat", "retard", "dildo", "jizz",
];
const censor = (t: string): string => {
  let out = t;
  for (const s of SWEARS) {
    let i: number;
    while ((i = out.toLowerCase().indexOf(s)) !== -1) {
      out = out.slice(0, i) + "*".repeat(s.length) + out.slice(i + s.length);
    }
  }
  return out;
};

const TIER_LABELS: Record<string, string> = {
  easy: "EASY", medium: "MEDIUM", hard: "HARD", veryhard: "VERY HARD", impossible: "IMPOSSIBLE",
};
const tierLabel = (t: string) => TIER_LABELS[t] ?? t.toUpperCase();

// easy = white chalk, medium = yellow, hard and above = red.
const tierColor = (t: string) =>
  t === "easy" ? "#f4f1e8" : t === "medium" ? "#ffd23b" : "#ff6b6b";

export function setupBee(opts: BeeOpts): BeeStage {
  const { net, localId, getName, camera, scene, avatars, classroom, audio, callRoomKey } = opts;
  const debug = !!opts.debug;
  const uiFocused = opts.isUiFocused ?? (() => false);

  // ---------- HUD elements ----------
  const hud = document.getElementById("match-hud")!;
  const whoEl = document.getElementById("m-who")!;
  const roundEl = document.getElementById("m-round")!;
  const input = document.getElementById("m-input") as HTMLInputElement;
  const replayBtn = document.getElementById("m-replay")!;
  const timerbar = document.getElementById("m-timerbar")!;
  const statusEl = document.getElementById("m-status")!;
  const aliveEl = document.getElementById("m-alive")!;

  // ---------- state ----------
  let phase: "lobby" | "match" = "lobby";
  let seatOrder: string[] = []; // player ids in seat order (queue, then match order)
  let hostId: string | null = null; // current lobby host (blue "(Host)" nametag)
  let activeSpeller: string | null = null;
  let curLength = 0;
  let curRound = 0;
  let curTier = "";
  let curTierColor = "#f4f1e8";
  let amSpeller = false;
  let amSpectator = false; // connected during a match, not one of the players
  let answered = false;
  let timerRaf = 0;
  let lastAudioRound = -1;
  let matchOver = false; // game-over screen showing — hide the board buttons

  // ---- tomato power-up ----
  let aliveIds: string[] = []; // current alive players (from bee_turn / result)
  let tomatoUsedThisTurn = false; // one throw per opponent's turn

  // ---- golden chalk power-up (speller-only) ----
  let chalkUsedThisMatch = false; // once per match
  let chalkAiming = false; // armed: hovering the board to pick a slot to reveal
  let armedAim = -1; // touch two-tap: the slot tapped once (tap again to confirm)
  // Per-slot answer model so a mid-word reveal replaces a letter IN PLACE (the
  // player's other letters keep their positions). slots = the player's own letters
  // by slot; gold = chalk-revealed letters by slot; gold always wins a slot.
  let slots: (string | null)[] = [];
  let gold: (string | null)[] = [];
  const typedCount = () => slots.reduce((n, s) => n + (s ? 1 : 0), 0);
  const sizeSlots = () => { slots = new Array(curLength).fill(null); gold = new Array(curLength).fill(null); };
  // Type into the leftmost empty, non-gold slot; backspace clears the rightmost.
  const addLetter = (ch: string) => {
    for (let i = 0; i < curLength; i++) if (!gold[i] && !slots[i]) { slots[i] = ch.toLowerCase(); return true; }
    return false;
  };
  const delLetter = () => {
    for (let i = curLength - 1; i >= 0; i--) if (!gold[i] && slots[i]) { slots[i] = null; return true; }
    return false;
  };
  // Positional board string: gold slots sent as "_" (the board colors gold from its
  // own reveal map); empty slots "_"; the player's letters at their exact slots.
  const boardText = () => {
    let s = "";
    for (let i = 0; i < curLength; i++) s += gold[i] ? "_" : (slots[i] ?? "_");
    return s;
  };
  // The submitted answer = gold + typed per slot (a gap collapses → a miss).
  const composedAnswer = () => {
    let s = "";
    for (let i = 0; i < curLength; i++) s += (gold[i] ?? slots[i] ?? "");
    return s;
  };

  classroom.root.visible = true; // the 3D room is shown in both lobby and match now

  // Spectator banner (shown when watching a match you're not playing in).
  const specBanner = document.createElement("div");
  specBanner.id = "spectator-banner";
  specBanner.textContent = "👀 Spectating — you can join when this match ends";
  Object.assign(specBanner.style, {
    position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)",
    zIndex: "16", display: "none", padding: "8px 16px", borderRadius: "999px",
    background: "rgba(12,15,22,0.86)", color: "#ffd23b", border: "1px solid #2a3344",
    font: "600 13px system-ui, sans-serif", boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
  } as any);
  document.body.appendChild(specBanner);

  // Simple "Spectating" label, bottom-center of the screen.
  const specBottom = document.createElement("div");
  specBottom.id = "spectator-bottom";
  specBottom.textContent = "👀 Spectating";
  Object.assign(specBottom.style, {
    position: "fixed", bottom: "16px", left: "50%", transform: "translateX(-50%)",
    zIndex: "16", display: "none", padding: "6px 14px", borderRadius: "999px",
    background: "rgba(12,15,22,0.72)", color: "#ffd23b", border: "1px solid #2a3344",
    font: "600 13px system-ui, sans-serif", letterSpacing: "0.02em",
    boxShadow: "0 4px 16px rgba(0,0,0,0.45)", pointerEvents: "none",
  } as any);
  document.body.appendChild(specBottom);

  // Refresh the spectator indicators from current state. The banner is for
  // explicit spectators (chose to / forced); the bottom pill also shows for
  // ELIMINATED players, who keep watching from their own (locked) desk. Derives
  // everything, so callers don't pass a flag — `setSpec()` just re-evaluates.
  const setSpec = (_on?: boolean) => {
    const out = phase === "match" && !matchOver && !amSpectator &&
      myMatchSeat >= 0 && aliveIds.length > 0 && !aliveIds.includes(localId);
    specBanner.style.display = amSpectator ? "block" : "none";
    specBottom.textContent = amSpectator ? "👀 Spectating" : "❌ Out — watching from your seat";
    specBottom.style.display = amSpectator || out ? "block" : "none";
  };

  // Replay button pinned to the chalkboard's bottom-LEFT corner.
  const boardReplay = document.createElement("button");
  boardReplay.id = "board-replay";
  boardReplay.textContent = "↺ Replay"; // round replay arrow + chalk text
  Object.assign(boardReplay.style, {
    position: "fixed", zIndex: "15", display: "none",
    // Anchoring transform + hover live in CSS (#board-replay) so :hover can add scale.
    background: "none", border: "0", padding: "0", cursor: "pointer",
    // Styled like the muted "ROUND X" header: greyer chalk, a bit smaller.
    color: "rgba(244,241,232,0.55)",
    font: "600 19px 'ABC Stefan Simple', system-ui, sans-serif",
    textShadow: "0 1px 3px rgba(0,0,0,0.4)",
  } as any);
  boardReplay.addEventListener("click", () => {
    if (lastBuffer) playBuffer(lastBuffer);
  });
  document.body.appendChild(boardReplay);

  // ---- speller HUD (desk-POV near-field controls) ----
  // The speller watches from their own desk now, so the word slots, countdown,
  // replay and confirm live in this overlay (markup/CSS in index.html). On touch
  // the on-screen keyboard's FABs + timer take over the buttons/bar roles.
  const spellHud = document.getElementById("spell-hud")!;
  const shSlots = document.getElementById("sh-slots")!;
  const shTimerfill = document.getElementById("sh-timerfill") as HTMLElement;
  const shReplay = document.getElementById("sh-replay")!;
  const shCheck = document.getElementById("sh-check")!;
  const correctWord = document.getElementById("correct-word")!;
  const shStats = document.getElementById("sh-stats")!;
  shReplay.addEventListener("click", () => { if (lastBuffer) playBuffer(lastBuffer); });
  shCheck.addEventListener("click", () => submit());

  // Live WPM/accuracy above the HUD — the stats board is behind you in first
  // person. Fed by the server's bee_key echoes (same numbers the board shows).
  const setShStats = (wpm: number, acc: number) => {
    shStats.innerHTML = `<b>${Math.round(wpm)}</b> WPM&ensp;·&ensp;<b>${Math.round(acc)}%</b> ACC`;
  };

  // Result state mirrored from the board: green when right, red + struck when
  // wrong (with the correct word center-screen). Lives until the next turn.
  let hudResult: { correct: boolean; answer: string } | null = null;

  // Tomato face splat — in first person the tomato hits YOUR view: the board's
  // splat artwork is drawn on a DOM canvas over the HUD slots, covering all but
  // the last 2 letters (same coverage as the 3D board splat).
  let faceSplatEl: HTMLCanvasElement | null = null;
  let faceSplatTimers: number[] = [];
  let flinch = 0; // 1 → 0 decaying first-person impact jolt
  const clearFaceSplat = () => {
    for (const t of faceSplatTimers) clearTimeout(t);
    faceSplatTimers = [];
    faceSplatEl?.remove();
    faceSplatEl = null;
  };
  const showFaceSplat = (durationMs: number) => {
    clearFaceSplat();
    const n = shSlots.children.length;
    const coverN = Math.max(0, n - 2); // leave the last 2 letters readable
    if (coverN <= 0 || !spellHud.classList.contains("show")) return;
    const first = (shSlots.children[0] as HTMLElement).getBoundingClientRect();
    const last = (shSlots.children[coverN - 1] as HTMLElement).getBoundingClientRect();
    const span = Math.max(48, last.right - first.left);
    const cx = first.left + span / 2;
    const cy = (first.top + first.bottom) / 2;
    const w = span * 1.4;
    const h = Math.max(first.height * 3.4, span * 0.55);
    const c = document.createElement("canvas");
    c.id = "face-splat";
    c.width = Math.ceil(w);
    c.height = Math.ceil(h);
    Object.assign(c.style, { left: `${cx - w / 2}px`, top: `${cy - h * 0.38}px`, width: `${w}px`, height: `${h}px` });
    const g = c.getContext("2d")!;
    g.translate(c.width / 2, c.height * 0.38); // main mass on the letters, drips below
    drawSplatShape(g, c.width * 0.36, c.height * 0.3, genSplatBlobs());
    document.body.appendChild(c);
    requestAnimationFrame(() => { c.style.opacity = "0.97"; });
    faceSplatEl = c;
    flinch = 1; // impact jolt (applied in applyCameraLife)
    const dur = Math.max(800, durationMs);
    faceSplatTimers.push(window.setTimeout(() => {
      if (faceSplatEl !== c) return;
      c.style.transition = "opacity 0.55s ease";
      c.style.opacity = "0";
    }, dur - 550));
    faceSplatTimers.push(window.setTimeout(() => { if (faceSplatEl === c) clearFaceSplat(); }, dur));
  };

  // Golden-chalk aim now happens on the HUD slots (near-field) instead of the
  // distant 3D board: desktop = click a pulsing slot to reveal; touch = tap a
  // slot to arm it, tap the SAME slot again to confirm.
  const onSlotTap = (i: number) => {
    if (!chalkAiming || answered) return;
    if (!isTouch || armedAim === i) {
      net.sendBee({ type: "bee_chalk", index: i });
      cancelAim();
      return;
    }
    armedAim = i;
    renderHud();
  };

  // Rebuild/update the HUD slot row from the slot model (letters, gold reveals,
  // the blinking cursor, and any chalk-aim state).
  const renderHud = () => {
    if (!amSpeller && !hudResult) return; // result display outlives amSpeller
    while (shSlots.children.length > curLength) shSlots.lastChild!.remove();
    while (shSlots.children.length < curLength) {
      const idx = shSlots.children.length;
      const s = document.createElement("span");
      s.className = "sh-slot";
      s.addEventListener("click", (e) => { e.stopPropagation(); onSlotTap(idx); });
      shSlots.appendChild(s);
    }
    let cursorIdx = -1;
    for (let i = 0; i < curLength; i++) if (!gold[i] && !slots[i]) { cursorIdx = i; break; }
    for (let i = 0; i < curLength; i++) {
      const el = shSlots.children[i] as HTMLElement;
      const ch = gold[i] ?? slots[i] ?? "";
      el.textContent = ch ? ch.toUpperCase() : " ";
      el.className =
        "sh-slot" +
        (gold[i] ? " gold" : "") +
        (!chalkAiming && i === cursorIdx && !answered ? " cursor" : "") +
        (chalkAiming ? (armedAim === i ? " sel" : armedAim < 0 ? " aim" : "") : "");
    }
  };

  const updateSpellHud = () => {
    // Live turn, OR holding the just-resolved result on screen until next turn.
    const live = phase === "match" && !matchOver && amSpeller && !amSpectator;
    const show = live || (phase === "match" && !matchOver && hudResult !== null);
    spellHud.classList.toggle("show", show);
    spellHud.classList.toggle("result", answered || hudResult !== null);
    spellHud.classList.toggle("ok", hudResult?.correct === true);
    spellHud.classList.toggle("bad", hudResult?.correct === false);
    correctWord.classList.toggle("show", show && hudResult?.correct === false);
    if (show) renderHud();
  };

  // ---- power-up item menu (2D, bottom-right) ----
  // The throw still launches a 3D tomato that everyone sees arc to the board.
  const tomato = makeTomatoFlights(camera, scene);
  const itemMenu = document.getElementById("item-menu")!;
  const itemTomato = document.getElementById("item-tomato") as HTMLButtonElement;
  const itemChalk = document.getElementById("item-chalk") as HTMLButtonElement;

  // Each item is in the menu only while the player still has it; it greys out +
  // drops opacity (the `.disabled` class) when its availability rule isn't met.
  // Tomato: usable only on OTHER players' turns (you can't tomato your own word).
  // Chalk: usable only on YOUR turn.
  const tomatoVisible = () =>
    phase === "match" && !amSpectator && !matchOver && aliveIds.includes(localId) && !tomatoUsedThisTurn;
  const canThrow = () => tomatoVisible() && !amSpeller;
  const chalkVisible = () =>
    phase === "match" && !amSpectator && !matchOver && aliveIds.includes(localId) && !chalkUsedThisMatch;
  const canChalk = () =>
    chalkVisible() && amSpeller && !answered && curLength > 0;

  const sceneCanvas = document.getElementById("app") as HTMLCanvasElement;

  const updateTomatoBtn = () => {
    itemTomato.style.display = tomatoVisible() ? "" : "none";
    itemTomato.classList.toggle("disabled", !canThrow());
    itemTomato.title = canThrow() ? "Throw tomato" : "You can’t tomato your own word";
    itemChalk.style.display = chalkVisible() ? "" : "none";
    itemChalk.classList.toggle("disabled", !canChalk());
    itemChalk.title = canChalk() ? "Golden chalk: reveal a letter" : "Golden chalk only on your turn";
    itemMenu.classList.toggle("show", tomatoVisible() || chalkVisible());
    if (!canChalk() && chalkAiming) cancelAim();
  };

  const throwTomato = () => {
    if (!canThrow()) return;
    net.sendBee({ type: "bee_tomato" });
    tomatoUsedThisTurn = true; // hides the tomato item; the flight starts on bee_splat
    updateTomatoBtn();
  };
  itemTomato.addEventListener("click", (e) => { e.stopPropagation(); if (canThrow()) throwTomato(); });
  // Tapping the chalk toggles aim mode (tap again to cancel without spending it).
  itemChalk.addEventListener("click", (e) => { e.stopPropagation(); if (chalkAiming) cancelAim(); else if (canChalk()) startAim(); });

  // Chalk aim: tap the chalk → every HUD slot pulses ("pick any letter"). The
  // pick + confirm interactions live on the HUD slots (see onSlotTap above) —
  // the 3D board is too far/small to aim at from the desk POV.
  function startAim() {
    chalkAiming = true;
    armedAim = -1;
    renderHud();
  }
  function cancelAim() {
    chalkAiming = false;
    armedAim = -1;
    renderHud();
  }
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && chalkAiming) { cancelAim(); e.preventDefault(); }
  });

  // ---- top-right universal menu (always visible: lobby + match) ----
  const menuBtn = document.getElementById("menu-btn")!;
  const menuPanel = document.getElementById("menu-panel")!;
  const menuItems = document.getElementById("menu-items")!;

  const closeMenu = () => menuPanel.classList.remove("on");

  // Become a spectator for the rest of this match (rejoin next match).
  const becomeSpectator = () => {
    if (phase !== "match" || amSpectator) return;
    net.sendBee({ type: "bee_spectate" });
    amSpectator = true;
    amSpeller = false;
    answered = true;
    setSpec(true);
    updateMatchHud();
    updateTomatoBtn();
  };
  // Leave the current match/room: public room -> back to your home lobby; your
  // own/home room -> a fresh empty lobby.
  const leaveMatch = () => {
    const dest = net.currentRoom() === callRoomKey
      ? `solo:${localId}-${Math.random().toString(36).slice(2, 7)}`
      : callRoomKey;
    net.setRoom(dest);
  };

  const renderMenu = () => {
    const out: string[] = [];
    if (phase === "match") {
      if (!amSpectator && aliveIds.includes(localId)) {
        out.push(`<button class="menu-item" id="mi-spectate">👀 Spectate</button>`);
      }
      if (localId === hostId) {
        out.push(`<button class="menu-item danger" id="mi-endmatch">🛑 End match</button>`);
      }
      out.push(`<button class="menu-item danger" id="mi-leave">🚪 Leave match</button>`);
      out.push(`<div class="menu-sep"></div>`);
    }
    out.push(`<button class="menu-item" id="mi-settings">⚙ Settings</button>`);
    menuItems.innerHTML = out.join("");
    document.getElementById("mi-spectate")?.addEventListener("click", () => { becomeSpectator(); closeMenu(); });
    document.getElementById("mi-endmatch")?.addEventListener("click", () => { net.sendBee({ type: "bee_endmatch" }); closeMenu(); });
    document.getElementById("mi-leave")?.addEventListener("click", () => { leaveMatch(); closeMenu(); });
    document.getElementById("mi-settings")?.addEventListener("click", () => { openSettings(); closeMenu(); });
  };

  // ---- settings panel: master / music / sounds volume ----
  const settingsPanel = document.getElementById("settings-panel")!;
  const settingsClose = document.getElementById("set-close")!;
  const bindVol = (id: string, get: () => number, set: (v: number) => void) => {
    const el = document.getElementById(id) as HTMLInputElement;
    const val = document.getElementById(`${id}-val`)!;
    el.value = String(Math.round(get() * 100));
    val.textContent = `${el.value}%`;
    el.addEventListener("input", () => {
      const v = parseInt(el.value, 10);
      set(v / 100);
      val.textContent = `${v}%`;
    });
  };
  const v = audio.volumes();
  bindVol("set-master", () => v.master, audio.setMaster);
  bindVol("set-music", () => v.music, audio.setMusic);
  bindVol("set-sfx", () => v.sfx, audio.setSfx);
  const openSettings = () => { audio.resume(); settingsPanel.classList.add("on"); };
  const closeSettings = () => settingsPanel.classList.remove("on");
  settingsClose.addEventListener("click", closeSettings);
  settingsPanel.addEventListener("click", (e) => { if (e.target === settingsPanel) closeSettings(); });

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menuPanel.classList.toggle("on");
    if (open) renderMenu();
  });
  // Click anywhere else closes the menu.
  window.addEventListener("pointerdown", (e) => {
    if (!menuPanel.classList.contains("on")) return;
    const t = e.target as HTMLElement;
    if (t.closest("#menu-panel") || t.closest("#menu-btn")) return;
    closeMenu();
  });


  // ---------- audio (server-synthesized narration) ----------
  // All audio runs through the shared bus (audio.ctx + audio.sfx) so the volume
  // sliders apply. TTS + clicks are SFX.
  const actx = audio.ctx;
  let curSource: AudioBufferSourceNode | null = null;
  let lastBuffer: AudioBuffer | null = null; // the trimmed word, for Replay
  const playBuffer = (buf: AudioBuffer) => {
    if (curSource) {
      try { curSource.stop(); } catch { /* already stopped */ }
    }
    curSource = audio.playSfx(buf);
  };
  const decodeB64 = (b64: string) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return actx.decodeAudioData(arr.buffer);
  };
  const playB64 = (b64: string) => decodeB64(b64).then(playBuffer).catch(() => {});
  const bankB64 = (b64: string) =>
    decodeB64(b64)
      .then((buf) => {
        lastBuffer = buf;
      })
      .catch(() => {});

  // Short keyboard "tick" (a filtered noise burst), routed through the sfx bus.
  // `deep` = a lower, duller thunk for backspace (low-pass, a touch longer/louder).
  const playClick = (deep = false) => {
    try {
      const len = Math.floor(actx.sampleRate * (deep ? 0.035 : 0.02));
      const buf = actx.createBuffer(1, len, actx.sampleRate);
      const d = buf.getChannelData(0);
      const decay = deep ? 2 : 3;
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      const src = actx.createBufferSource();
      src.buffer = buf;
      const filt = actx.createBiquadFilter();
      filt.type = deep ? "lowpass" : "highpass";
      filt.frequency.value = deep ? 900 : 1600;
      const g = actx.createGain();
      g.gain.value = deep ? 0.2 : 0.14;
      src.connect(filt);
      filt.connect(g);
      g.connect(audio.sfx); // -> sfx bus
      src.start();
    } catch {
      /* ignore */
    }
  };
  // Browsers require a gesture before audio; resume on first interaction.
  window.addEventListener("pointerdown", () => audio.resume(), { once: true });

  // ---------- timer ----------
  const countdown = (durationMs: number) => {
    const end = performance.now() + durationMs;
    cancelAnimationFrame(timerRaf);
    const tick = () => {
      const frac = Math.max(0, (end - performance.now()) / durationMs);
      const pct = `${frac * 100}%`;
      timerbar.style.width = pct;
      kbdTimerbar.style.width = pct; // mirror to the on-screen keyboard's timer
      shTimerfill.style.width = pct; // mirror to the speller HUD's bar
      shTimerfill.style.background = `hsl(${120 * frac}, 65%, 55%)`; // green → red
      if (frac > 0) timerRaf = requestAnimationFrame(tick);
    };
    tick();
  };

  // ---------- 3D placement ----------
  // Seat every player at their join-order camera. The active speller (match only)
  // is pulled to the front spot instead; the avatar occupying the fixed match
  // camera (seat 0) is hidden so we don't render inside its head.
  const placeSeated = (av: THREE.Object3D, i: number, id?: string) => {
    const seat = classroom.seats[i];
    if (!seat) return;
    av.position.copy(seat.pos).add(classroom.seatOffset);
    const per = classroom.seatOffsets[i];
    if (per) av.position.add(per);
    // Per-model seating fit: x/z are seat-relative (rotated by the seat's facing
    // so +z is into the desk), y is straight up. Lets each character sit right
    // in any chair regardless of its modeled origin/pose.
    if (id) {
      const mo = avatars.seatOffsetFor(id);
      const c = Math.cos(seat.yaw), s = Math.sin(seat.yaw);
      av.position.x += mo.x * c + mo.z * s;
      av.position.y += mo.y;
      av.position.z += mo.z * c - mo.x * s;
    }
    av.rotation.y = seat.yaw;
  };

  // Lobby seating skips the host (they stand at the front, at the lobby camera):
  // the first NON-host player takes the 'player' seat, the next 'player.1', etc.
  const lobbySeatIdx = (id: string) => seatOrder.filter((p) => p !== hostId).indexOf(id);
  // The local player's seat indices, cached by seatPlayers() — basePose() and
  // onMatchCam() run every frame, so they must not rescan/allocate.
  let myLobbySeat = -1; // index among non-hosts (lobby POV)
  let myMatchSeat = -1; // index in the match order (match POV)

  // True when this client's POV is the shared front 'player' camera during a
  // match: only NON-SEATED spectators (not in the match order) use it now.
  // Seated players look out of their desk camera; the active speller goes
  // first-person at the stage (see spellerPose).
  const onMatchCam = () => phase === "match" && myMatchSeat < 0;

  const seatPlayers = () => {
    const nonHosts = seatOrder.filter((p) => p !== hostId); // computed once, not per player
    myLobbySeat = nonHosts.indexOf(localId);
    myMatchSeat = seatOrder.indexOf(localId);
    avatars.setAllVisible(false);
    seatOrder.forEach((id, i) => {
      avatars.ensure(id, getName(id));
      avatars.setModel(id, CHAIR_MODELS[i % CHAIR_MODELS.length]); // fixed model per chair
      avatars.setHost(id, id === hostId); // blue nametag for the host
      avatars.setPosed(id, true); // seated players + speller loop idle, never jump
      avatars.clearEmote(id); // drop a held wrong-answer pose from the previous turn
      // The current speller's nametag is hidden mid-match (it's on the stats board).
      avatars.setLabelVisible(id, !(phase === "match" && id === activeSpeller));
      const av = avatars.get(id);
      if (!av) return;
      av.scale.setScalar(1);
      if (phase === "match" && id === activeSpeller) {
        av.position.copy(classroom.spellerPos);
        av.scale.setScalar(classroom.spellerScale);
        // Face the match camera (set once here, not re-applied every frame).
        av.rotation.y = Math.atan2(
          classroom.matchCam.pos.x - av.position.x,
          classroom.matchCam.pos.z - av.position.z
        );
        // Your own live turn is first person on stage — don't render inside your
        // model's head. (At game over you watch your wave from your desk.)
        av.visible = !(id === localId && !matchOver);
        return;
      }
      if (phase === "match") {
        const seat = classroom.seats[i];
        // Hide: no desk · my own seated body (my camera sits in its head) · the
        // desk-0 occupant when MY view is the shared front cam (it sits there).
        if (!seat || id === localId || (i === 0 && onMatchCam())) {
          av.visible = false;
          return;
        }
        placeSeated(av, i, id);
        av.visible = true;
        return;
      }
      // ---- lobby: independent POVs ----
      if (id === localId) {
        av.visible = false; // the local camera looks out of this avatar's head
        return;
      }
      if (id === hostId) {
        av.position.copy(classroom.hostSpot.pos); // host stands at the front, facing the class
        av.rotation.y = classroom.hostSpot.yaw;
        av.visible = true;
        return;
      }
      const si = nonHosts.indexOf(id);
      const seat = classroom.seats[si];
      if (!seat) {
        av.visible = false; // more players than seat cameras
        return;
      }
      placeSeated(av, si, id);
      av.visible = true;
    });
    setSpec(); // reflect alive/seat/spectator state (incl. "out — at your desk")
  };

  // The wall turn-queue board. In a match: upcoming players, next-up at top,
  // current speller excluded (they're on the chalkboard), eliminated dropped.
  // In the lobby: the join roster in order. The board diffs + animates itself.
  const refreshPlayerList = () => {
    const items: { key: string; label: string }[] = [];
    if (phase === "match") {
      const aliveSet = new Set(aliveIds);
      const start = activeSpeller ? seatOrder.indexOf(activeSpeller) : -1;
      for (let k = 1; k <= seatOrder.length; k++) {
        const id = seatOrder[((start < 0 ? -1 : start) + k + seatOrder.length) % seatOrder.length];
        if (!id || id === activeSpeller || !aliveSet.has(id)) continue;
        items.push({ key: id, label: getName(id) });
      }
    } else {
      for (const id of seatOrder) items.push({ key: id, label: getName(id) });
    }
    classroom.setPlayerList(items);
  };

  const enterLobby = (queue: string[]) => {
    phase = "lobby";
    matchOver = false;
    lastAudioRound = -1; // reset the audio-dedup key between matches
    hudResult = null;
    clearFaceSplat();
    audio.setMusicEnabled(true); // background song plays in the lobby only
    cancelAnimationFrame(timerRaf);
    activeSpeller = null;
    amSpectator = false;
    setSpec(false);
    seatOrder = queue;
    classroom.root.visible = true;
    boardReplay.style.display = "none";
    classroom.clearStats();
    classroom.clearSplat();
    if (chalkAiming) cancelAim();
    classroom.clearReveals();
    aliveIds = [];
    updateMatchHud();
    updateTomatoBtn();
    seatPlayers();
    refreshPlayerList(); // wall board shows the lobby roster
  };

  const enterMatch = (order: string[]) => {
    phase = "match";
    matchOver = false;
    lastAudioRound = -1; // the server resets its per-match round counter, so clear
                         // our audio-dedup key or the next match's word goes silent
    hudResult = null;
    clearFaceSplat();
    audio.setMusicEnabled(false); // silence the lobby song during the match
    seatOrder = order.length ? order : seatOrder;
    aliveIds = [...seatOrder]; // everyone starts alive (seats locked to this order)
    amSpectator = order.length > 0 && !order.includes(localId);
    setSpec(amSpectator);
    activeSpeller = null;
    chalkUsedThisMatch = false; // fresh golden chalk for the new match
    slots = []; gold = [];
    if (chalkAiming) cancelAim();
    classroom.root.visible = true;
    classroom.setBoardHeader("🐝 Spelling Bee");
    classroom.clearBoard(0);
    classroom.clearSplat();
    updateMatchHud(); // desktop: hidden · touch: slim bottom bar
    updateTomatoBtn();
    seatPlayers();
    // Show the full (shuffled) turn order; the first bee_turn then erases the
    // speller off the top and slides the rest up.
    classroom.setPlayerList(seatOrder.map((id) => ({ key: id, label: getName(id) })));
  };

  // ---------- input ----------
  // Touch devices have no physical keyboard, so there the #m-input becomes a real
  // editable field that raises the native keyboard (and the match HUD becomes a
  // slim bottom bar). On desktop it stays a read-only mirror of the guess — typing
  // is captured globally below so you never have to click to type.
  const isTouch = window.matchMedia("(pointer: coarse)").matches;
  // The #m-input is now always a read-only mirror — touch uses the on-screen
  // keyboard (no device keyboard), desktop captures keys globally.
  input.readOnly = true;

  // No cheating: block copy/cut/paste/drop on the guess field so the word can't be
  // pasted in wholesale (the touch field is editable; desktop's is read-only). The
  // beforeinput guard also stops paste/drop insertions the clipboard events miss.
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("spellcheck", "false");
  for (const ev of ["paste", "copy", "cut", "drop"]) {
    input.addEventListener(ev, (e) => e.preventDefault());
  }
  input.addEventListener("beforeinput", (e) => {
    const it = (e as InputEvent).inputType || "";
    if (it.startsWith("insertFromPaste") || it.startsWith("insertFromDrop")) e.preventDefault();
  });

  // Mirror the current guess to the 3D board + spectators (censored). Leaves
  // input.value alone so it never fights the native field while typing.
  const pushGuess = () => {
    const shown = censor(boardText()); // positional, gold slots as "_"
    classroom.setBoardGuess(shown, curLength);
    renderHud(); // the speller's near-field slot row mirrors every change
    // `n` = the player's real typed-letter count, so server WPM/accuracy ignores
    // gold reveals and "_" placeholders.
    net.sendBee({ type: "bee_key", text: shown, n: typedCount() });
  };
  // Desktop path: the field is a passive mirror, so echo the gapless guess there.
  const renderGuess = () => {
    input.value = censor(slots.filter(Boolean).join(""));
    pushGuess();
  };

  const submit = () => {
    if (answered || !amSpeller) return;
    answered = true;
    if (chalkAiming) cancelAim();
    const answer = composedAnswer(); // typed letters + any gold-revealed letters
    net.sendBee({ type: "bee_answer", text: answer });
    statusEl.textContent = `🔒 Locked in: ${censor(answer) || "(blank)"}`;
    updateMatchHud(); // hide the input row now that the guess is locked
  };

  // ---- on-screen keyboard (touch only) ----
  // Replaces the device keyboard: shown on the speller's turn, fills the bottom
  // third, alphabet + replay + submit. Uses the chalk font on the keys.
  const kbd = document.getElementById("kbd")!;
  const kbdTimerbar = document.getElementById("kbd-timerbar")!;
  const kbdReplay = document.getElementById("kbd-replay")!;
  const kbdSubmit = document.getElementById("kbd-submit")!;
  const kbType = (ch: string) => {
    if (phase !== "match" || !amSpeller || answered) return;
    if (addLetter(ch)) { playClick(); renderGuess(); }
  };
  const mkKey = (label: string, cls: string, onTap: () => void) => {
    const b = document.createElement("button");
    b.className = "key" + (cls ? " " + cls : "");
    b.textContent = label;
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onTap(); });
    return b;
  };
  ["qwertyuiop", "asdfghjkl", "zxcvbnm"].forEach((row, ri) => {
    const r = document.createElement("div");
    r.className = "kbd-row";
    for (const ch of row) {
      const key = mkKey(ch.toUpperCase(), "", () => kbType(ch));
      key.dataset.k = ch.toUpperCase(); // drives the iOS-style key-pop preview
      r.appendChild(key);
    }
    if (ri === 2) r.appendChild(mkKey("⌫", "act", () => { if (amSpeller && !answered && delLetter()) { playClick(true); renderGuess(); } }));
    kbd.appendChild(r);
  });
  // Replay (round, left) + submit (round, right) FABs above the keyboard.
  kbdReplay.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (lastBuffer) playBuffer(lastBuffer); });
  kbdSubmit.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); submit(); });
  const updateKeyboard = () => {
    const show = isTouch && phase === "match" && amSpeller && !answered && !amSpectator;
    kbd.classList.toggle("show", show);
    kbdReplay.classList.toggle("show", show);
    kbdSubmit.classList.toggle("show", show);
  };

  // The old slim match bar is retired on touch (the keyboard replaces it); the
  // #match-hud stays hidden on both platforms now.
  const updateMatchHud = () => {
    hud.style.display = "none";
    hud.classList.remove("mobile-bar", "no-input");
    updateKeyboard();
    updateSpellHud();
  };

  // Always-listening key capture for the speller (no focus/click required).
  // Desktop only — on touch the on-screen keyboard drives the guess.
  window.addEventListener("keydown", (e) => {
    if (isTouch) return;
    if (phase !== "match" || !amSpeller || answered) return;
    if (e.key === "Enter") {
      submit();
      e.preventDefault();
      e.stopImmediatePropagation();
    } else if (e.key === "Backspace") {
      if (delLetter()) { playClick(true); renderGuess(); }
      e.preventDefault();
      e.stopImmediatePropagation();
    } else if (/^[a-zA-Z]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (addLetter(e.key)) {
        playClick();
        renderGuess();
      }
      e.preventDefault();
      e.stopImmediatePropagation(); // don't let letters reach the debug 'h' toggle etc.
    }
  });

  replayBtn.addEventListener("click", () => {
    if (lastBuffer) playBuffer(lastBuffer);
  });

  // ---------- network ----------
  const handle = (m: any) => {
    switch (m.type) {
      case "bee_lobby":
        if (m.phase === "lobby" || m.phase === "idle") {
          hostId = m.hostId ?? null;
          enterLobby(m.queue ?? []);
        }
        break;

      case "bee_match_start":
        enterMatch(m.order ?? []);
        break;

      case "bee_look":
        // Another player's gaze — turn their avatar's head toward it.
        if (m.id !== localId) avatars.setLook(m.id, m.yaw ?? 0, m.pitch ?? 0);
        break;

      case "bee_splat": {
        const dur = m.durationMs ?? 4000;
        const onLand = () => {
          classroom.splatTomato(dur); // the 3D board splat (what spectators watch)
          if (amSpeller && !answered) showFaceSplat(dur); // first person: it hits YOUR view
        };
        // Launch a tomato arcing from the thrower toward the board, then splat.
        // Thrower sees it leave their own corner; everyone else sees it leave the
        // thrower's avatar. Unknown thrower (no avatar) → just splat, no flight.
        const target = new THREE.Vector3();
        (classroom.boardMesh as THREE.Object3D).getWorldPosition(target);
        let from: THREE.Vector3 | null = null;
        if (m.by && m.by === localId) {
          from = tomato.menuWorldPos(new THREE.Vector3());
        } else if (m.by) {
          const av = avatars.get(m.by);
          if (av) { from = new THREE.Vector3(); av.getWorldPosition(from); from.y += 1.4; }
        }
        if (from) tomato.launch(from, target, onLand);
        else onLand();
        break;
      }

      case "bee_reveal": {
        const i = m.index;
        const letter = String(m.letter || "");
        if (typeof i !== "number" || i < 0 || i >= curLength || !letter) break;
        classroom.revealLetter(i, letter.toUpperCase()); // everyone sees the gold reveal
        if (m.spellerId === localId) {
          gold[i] = letter.toLowerCase();
          slots[i] = null; // the reveal takes this slot (replaces any letter in place)
          chalkUsedThisMatch = true;
          if (chalkAiming) cancelAim();
          pushGuess(); // recompose my board with the reveal in place
          updateTomatoBtn(); // chalk is spent → hide it
        }
        break;
      }

      case "bee_turn": {
        activeSpeller = m.spellerId;
        curLength = m.length;
        curRound = m.lap ?? m.round; // display the lap as the round (all players = 1)
        curTier = tierLabel(m.tier ?? "");
        curTierColor = tierColor(m.tier ?? "easy");
        amSpeller = m.spellerId === localId;
        answered = false;
        hudResult = null; // the previous turn's result leaves with the new turn
        sizeSlots(); // fresh empty per-slot answer (typing is captured globally)
        lastBuffer = null; // word audio arrives via bee_audio
        aliveIds = m.alive ?? aliveIds;
        tomatoUsedThisTurn = false; // fresh tomato for this opponent's turn
        if (chalkAiming) cancelAim();
        classroom.clearReveals();
        classroom.clearSplat(); // clear any splat from last turn
        clearFaceSplat();
        seatPlayers();
        // Secondary board: current speller's name + (cumulative) accuracy, WPM resets.
        classroom.setStats(getName(m.spellerId), 0, m.accuracy ?? 100, m.spellerId === localId);
        if (amSpeller) setShStats(0, m.accuracy ?? 100); // fresh turn → fresh HUD stats
        refreshPlayerList(); // wall queue: erase the new speller off the top, slide up

        // Stage the boards' content, then write it all in one char at a time.
        // The tier is known now, so show the round header straight away.
        classroom.setBoardHeader(`ROUND ${curRound}`, { text: curTier, color: curTierColor });
        classroom.clearBoard(curLength);
        classroom.clearBoardTimer(); // the bar starts at bee_go
        classroom.setBoardCursorEnabled(amSpeller); // only the speller's own POV blinks the cursor
        classroom.revealBoards();

        whoEl.textContent = amSpeller
          ? "Your turn — get ready…"
          : `${getName(m.spellerId)} is up…`;
        roundEl.textContent = `Round ${curRound} · ${curTier} · ${m.alive.length} still in`;
        input.value = "";
        statusEl.textContent = amSpeller ? "🔊 Getting your word…" : "";
        aliveEl.textContent = "";
        timerbar.style.width = "100%";
        kbdTimerbar.style.width = "100%";
        shTimerfill.style.width = "100%";
        shTimerfill.style.background = "hsl(120, 65%, 55%)";
        updateMatchHud(); // hide the legacy HUD; (re)show the keyboard + speller HUD
        updateTomatoBtn(); // show the tomato to eligible waiting players
        break;
      }

      case "bee_audio":
        // Word is ready. The header was already written in at bee_turn — don't
        // re-set it here, that would abort the board's write-in animation.
        if (amSpeller) {
          whoEl.textContent = "Your turn — spell it!";
          if (!answered) statusEl.textContent = "🔊 Your word is… — type it!";
        }
        if (m.round === lastAudioRound) break; // already played this round
        lastAudioRound = m.round;
        playB64(m.wav); // full "Your word is, X." phrase
        bankB64(m.wavWord || m.wav); // trimmed word for clean Replay
        break;

      case "bee_go":
        countdown(m.duration); // timer starts as the word begins playing
        classroom.setBoardTimer(m.duration); // under-word countdown bar on the board
        if (amSpeller && !answered) statusEl.textContent = "Type the word, then press Enter.";
        break;

      case "bee_key":
        // Live spectator view of whoever is typing (already censored at the source;
        // censor again defensively). The speller's own board updates locally.
        if (m.spellerId !== localId) classroom.setBoardGuess(censor(m.text || ""), curLength);
        // Live WPM + accuracy on the secondary stats board (everyone sees it).
        classroom.setStats(getName(m.spellerId), m.wpm ?? 0, m.accuracy ?? 100, m.spellerId === localId);
        // …and mirrored above the speller's HUD (the stats board is behind them).
        if (m.spellerId === localId) setShStats(m.wpm ?? 0, m.accuracy ?? 100);
        break;

      case "bee_turn_result": {
        cancelAnimationFrame(timerRaf);
        classroom.clearBoardTimer();
        timerbar.style.width = "0%";
        kbdTimerbar.style.width = "0%";
        shTimerfill.style.width = "0%";
        answered = true; // turn resolved — close the touch input row + keyboard
        // My word: mirror the board's verdict in the HUD (green, or red + the
        // correct word center-screen) and hold it until the next turn starts.
        if (m.spellerId === localId) {
          hudResult = { correct: !!m.correct, answer: String(m.word || "") };
          correctWord.textContent = String(m.word || "").toUpperCase();
        }
        clearFaceSplat(); // turn over — the face splat goes with the board's
        updateMatchHud();
        if (isTouch) input.blur();
        aliveIds = m.alive ?? aliveIds;
        setSpec(); // if that result eliminated me, show "out — at your desk" now
        classroom.clearSplat(); // turn over — clear the splat
        updateTomatoBtn();
        classroom.setBoardResult(censor(m.guess || ""), m.correct, m.word);
        // Let the result word linger, then erase both boards char-by-char so
        // they're blank when the next speller's turn writes in.
        window.setTimeout(() => classroom.hideBoards(), 500);
        // Wrong answer → the speller plays a one-shot reaction (duck, or punch if
        // they have no duck clip) that finishes just before the next round starts.
        if (!m.correct && !avatars.playEmote(m.spellerId, "duck", false, 1.5)) {
          avatars.playEmote(m.spellerId, "punch", false, 1.5);
        }
        if (m.spellerId === localId) {
          statusEl.textContent = m.correct
            ? "✅ Correct!"
            : `❌ Out — it was “${m.word}”`;
        } else {
          statusEl.textContent = `${getName(m.spellerId)} ${
            m.correct ? "got it ✅" : `missed ❌ — “${m.word}”`
          }`;
        }
        aliveEl.textContent = `${m.alive.length} still in`;
        break;
      }

      case "bee_forcespectate": {
        // Server bumped us to spectator (e.g. flagged for inhuman typing speed).
        amSpectator = true;
        amSpeller = false;
        answered = true;
        if (chalkAiming) cancelAim();
        setSpec(true);
        if (m.reason) statusEl.textContent = String(m.reason);
        updateMatchHud();
        updateTomatoBtn();
        if (isTouch) input.blur();
        break;
      }

      case "bee_over": {
        cancelAnimationFrame(timerRaf);
        classroom.clearBoardTimer();
        matchOver = true; // hide the board replay/confirm buttons on the end screen
        const w = m.winnerId as string | null;
        whoEl.textContent = "Game Over";
        statusEl.textContent = w ? `Winner: ${getName(w)}` : "Game over";
        // Game-over screen on the board: "GAME OVER" + "Winner: <name>" below.
        classroom.setEndScreen("GAME OVER", w ? `Winner: ${getName(w)}` : "");
        classroom.clearStats();
        answered = true;
        aliveIds = [];
        hudResult = null; // the game-over screen replaces any per-turn result
        clearFaceSplat();
        classroom.setPlayerList([]); // clear the wall queue at game over
        // Showcase the winner: pull THEM to the front-stage spot (under the lamp
        // spotlight, replacing whoever was last up) and loop a celebratory wave.
        // seatPlayers() returns everyone else to their chairs.
        activeSpeller = w; // null clears the stage spot
        seatPlayers();
        if (w && !avatars.celebrate(w)) avatars.playEmote(w, "wave", false, 1);
        classroom.clearSplat();
        updateMatchHud();
        updateTomatoBtn();
        if (isTouch) input.blur();
        setSpec(false);
        // The server reopens the lobby itself a few seconds later (returnToLobby).
        break;
      }
    }
  };

  const applyCamera = (pose: CameraPose) => {
    camera.position.copy(pose.pos);
    camera.quaternion.copy(pose.quat);
    if (camera.fov !== pose.fov) {
      camera.fov = pose.fov;
      camera.updateProjectionMatrix();
    }
  };

  // Per-player POV. Lobby: the host looks from the front (lobby cam), everyone
  // else from their own seat camera (by non-host join order). Match: the active
  // speller + non-seated spectators use the shared front 'player' cam (the
  // speller sees their own model on stage — unchanged); players waiting their
  // turn watch from the seat camera of their shuffled match-order desk.
  // First-person stage POV for the active speller: the camera stands where
  // their model does (the tuned currentturnplayerposition spot), at eye height,
  // facing the class. Recomputed per frame so the debug speller sliders stay
  // live; the pose object is reused (no per-frame allocation).
  const SPELLER_EYE = 1.55; // eye height above the stand spot (× spellerScale)
  const UP_AXIS = new THREE.Vector3(0, 1, 0);
  const spellerCamPose: CameraPose = {
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    fov: classroom.matchCam.fov,
  };
  const spellerPose = (): CameraPose => {
    const p = classroom.spellerPos;
    spellerCamPose.pos.set(p.x, p.y + SPELLER_EYE * classroom.spellerScale, p.z);
    // The camera looks down -Z, so facing the class (toward the matchCam, like
    // the model does) means the model's yaw + π.
    const yaw = Math.atan2(classroom.matchCam.pos.x - p.x, classroom.matchCam.pos.z - p.z) + Math.PI;
    spellerCamPose.quat.setFromAxisAngle(UP_AXIS, yaw);
    return spellerCamPose;
  };

  const basePose = (): CameraPose => {
    if (phase === "match") {
      // Your live turn = first person on stage (the game-over wave is watched
      // from your desk instead, so the winner sees their own celebration).
      if (localId === activeSpeller && !matchOver) return spellerPose();
      if (onMatchCam()) return classroom.matchCam;
      return classroom.seatCams[myMatchSeat] || classroom.matchCam;
    }
    if (localId === hostId) return classroom.lobbyCam;
    return (myLobbySeat >= 0 && classroom.seatCams[myLobbySeat]) || classroom.lobbyCam;
  };

  // ---- camera life, applied on top of the base pose every frame ----
  // Lobby: full free-look — the view sweeps toward the cursor (desktop) or
  // follows a one-finger drag (touch). Match: idle "breathing" bob + a subtle
  // cursor parallax (unchanged this pass).
  let targetMx = 0, targetMy = 0; // cursor in NDC [-1,1]
  let turnTilt = 0; // 0..1 eased; on the local speller's touch turn, tilt down for the keyboard
  const TURN_TILT = 0.16; // downward pitch on the speller's touch turn (radians)
  // Free-look range. Seated players + the lobby get a tight "lock" so they keep
  // facing the board; spectators (not a seated player this match) aren't playing,
  // so they look around freely with a much wider, unlocked range.
  const LOOK_YAW = 0.5, LOOK_PITCH_UP = 0.088, LOOK_PITCH_DOWN = 0.128; // locked
  const SPEC_LOOK_YAW = 1.5, SPEC_PITCH_UP = 0.5, SPEC_PITCH_DOWN = 0.6; // spectators
  // Actively playing = a seated player this match who is still alive and hasn't
  // opted out. Everyone else in a match is spectating (eliminated players watch
  // from their own desk — their seat is locked at match start and never changes).
  const amPlaying = () => phase === "match" && !amSpectator && myMatchSeat >= 0 && aliveIds.includes(localId);
  const spectating = () => phase === "match" && !amPlaying();
  const lookRange = () =>
    spectating()
      ? { yaw: SPEC_LOOK_YAW, up: SPEC_PITCH_UP, down: SPEC_PITCH_DOWN }
      : { yaw: LOOK_YAW, up: LOOK_PITCH_UP, down: LOOK_PITCH_DOWN };
  let lookTX = 0, lookTY = 0; // free-look target, -1..1 (touch drags write here)
  let lookX = 0, lookY = 0; // eased
  let lookGain = 1; // eases to 0 while the clipboard is up, so it reads calmly
  window.addEventListener("pointermove", (e) => {
    targetMx = (e.clientX / window.innerWidth) * 2 - 1;
    targetMy = (e.clientY / window.innerHeight) * 2 - 1;
  });
  const applyCameraLife = (dt: number) => {
    // Everyone free-looks now (lobby, seated players, and spectators) — only the
    // RANGE differs (lookRange: tight lock for players, wide for spectators). The
    // clipboard is camera-anchored (clipboard.ts composes its matrix from the
    // camera each frame, AFTER this), so it stays glued no matter where you look.
    const r = lookRange();
    if (!isTouch) { lookTX = targetMx; lookTY = targetMy; }
    // Damp the free-look to 30% on your own turn (the cursor doubles as the
    // typing/HUD pointer), and to 0 while the clipboard is up.
    const myTurn = phase === "match" && amSpeller && !answered && !amSpectator;
    lookGain += ((uiFocused() ? 0 : myTurn ? 0.3 : 1) - lookGain) * Math.min(1, dt * 4);
    lookX += (lookTX - lookX) * Math.min(1, dt * 5);
    lookY += (lookTY - lookY) * Math.min(1, dt * 5);
    camera.rotateY(-lookX * r.yaw * lookGain);
    camera.rotateX(-lookY * (lookY > 0 ? r.down : r.up) * lookGain);
    // Touch: on your own turn, ease the view DOWN so the stage/board clears the
    // on-screen keyboard.
    const tiltTarget = isTouch && myTurn ? 1 : 0;
    turnTilt += (tiltTarget - turnTilt) * Math.min(1, dt * 6);
    if (turnTilt > 0.001) camera.rotateX(-turnTilt * TURN_TILT);
    // Tomato-impact flinch: a short decaying first-person jolt (~0.3s).
    if (flinch > 0.003) {
      flinch *= Math.exp(-dt * 7);
      const a = flinch * flinch * 0.05;
      camera.rotateX(Math.sin(flinch * 37) * a);
      camera.rotateZ(Math.sin(flinch * 23) * a * 0.6);
    }
  };

  // Broadcast where this player is looking (throttled) so their avatar turns its
  // head on other clients. Zeros flow once when free-look ends (e.g. on stage).
  let sentYaw = 0, sentPitch = 0, lastLookAt = 0;
  const sendLook = () => {
    const now = performance.now();
    if (now - lastLookAt < 150) return;
    const active = !onMatchCam() && lookGain > 0.05; // non-seated spectators have no avatar
    const r = lookRange();
    const yaw = active ? -lookX * r.yaw * lookGain : 0;
    const pitch = active ? -lookY * (lookY > 0 ? r.down : r.up) * lookGain : 0;
    if (Math.abs(yaw - sentYaw) < 0.02 && Math.abs(pitch - sentPitch) < 0.02) return;
    sentYaw = yaw; sentPitch = pitch; lastLookAt = now;
    net.sendBee({ type: "bee_look", yaw, pitch });
  };

  // Touch: a one-finger drag on the 3D scene looks around (lobby, seated players,
  // and spectators alike). The drag "grabs the world": dragging right swings the
  // view left. DOM overlays (the clipboard tap-zone, panels, buttons) sit above
  // the canvas and keep their taps.
  if (isTouch) {
    let dragId: number | null = null, dragLX = 0, dragLY = 0;
    const clampLook = (v: number) => Math.max(-1, Math.min(1, v));
    const noLook = () => phase !== "lobby" && phase !== "match";
    sceneCanvas.addEventListener("pointerdown", (e) => {
      if (noLook()) return;
      dragId = e.pointerId; dragLX = e.clientX; dragLY = e.clientY;
    });
    window.addEventListener("pointermove", (e) => {
      if (dragId !== e.pointerId || noLook()) return;
      lookTX = clampLook(lookTX - ((e.clientX - dragLX) * 1.7) / window.innerWidth);
      lookTY = clampLook(lookTY - ((e.clientY - dragLY) * 1.7) / window.innerHeight);
      dragLX = e.clientX; dragLY = e.clientY;
    });
    const endDrag = (e: PointerEvent) => { if (dragId === e.pointerId) dragId = null; };
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
  }

  // Project the board's 4 corners to screen space to pin the Replay/Confirm
  // buttons. The camera now moves each frame (bob/parallax), so this recomputes
  // per frame in a match — keep its temporaries allocation-free.
  const cornerV = new THREE.Vector3();
  const CORNER_SIGNS = [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const;
  const blPos = { x: 0, y: 0 }, brPos = { x: 0, y: 0 };

  const computeBoardCorners = () => {
    const mesh = classroom.boardMesh as THREE.Mesh;
    const geo = mesh.geometry as THREE.PlaneGeometry;
    const hw = (geo.parameters?.width ?? 4) / 2;
    const hh = (geo.parameters?.height ?? 2) / 2;
    mesh.updateWorldMatrix(true, false);
    camera.updateMatrixWorld(true); // ensure matrixWorldInverse is current for project()
    let blBest = -Infinity, brBest = -Infinity;
    for (const [sx0, sy0] of CORNER_SIGNS) {
      cornerV.set(sx0 * hw, sy0 * hh, 0).applyMatrix4(mesh.matrixWorld).project(camera);
      const sx = (cornerV.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-cornerV.y * 0.5 + 0.5) * window.innerHeight;
      if (sy - sx > blBest) { blBest = sy - sx; blPos.x = sx; blPos.y = sy; }
      if (sy + sx > brBest) { brBest = sy + sx; brPos.x = sx; brPos.y = sy; }
    }
  };
  const pin = (el: HTMLElement, p: { x: number; y: number }) => {
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.style.display = "block";
  };

  return {
    update: (dt: number) => {
      applyCamera(basePose()); // per-player POV (host = front, others = their seat)
      applyCameraLife(dt); // lobby free-look · match bob + parallax
      sendLook(); // throttled gaze sync — other clients turn this player's head
      tomato.update(dt); // advance any in-flight thrown tomatoes

      // Seats + speller are placed once by seatPlayers() on each state change; only
      // re-apply them every frame in mock/dev so the debug sliders stay live.
      if (debug) {
        seatOrder.forEach((id, i) => {
          if (phase === "match" && id === activeSpeller) return;
          const av = avatars.get(id);
          if (!av || !av.visible) return; // hidden = own body / desk-0 under the shared cam
          if (phase === "match") { placeSeated(av, i, id); return; }
          if (id === hostId) {
            av.position.copy(classroom.hostSpot.pos);
            av.rotation.y = classroom.hostSpot.yaw;
            return;
          }
          const si = lobbySeatIdx(id);
          if (classroom.seats[si]) placeSeated(av, si, id);
        });
        if (phase === "match" && activeSpeller) {
          const sp = avatars.get(activeSpeller);
          if (sp) {
            sp.position.copy(classroom.spellerPos);
            sp.scale.setScalar(classroom.spellerScale);
            sp.rotation.y = Math.atan2(
              classroom.matchCam.pos.x - sp.position.x,
              classroom.matchCam.pos.z - sp.position.z
            );
          }
        }
      }

      // Pin the spectators' Replay to the board's bottom-left corner. The
      // speller's replay/confirm live in the spell HUD now; on touch the
      // keyboard FABs handle them, so skip the floating one entirely.
      if (phase === "match" && !isTouch && !matchOver && !amSpeller) {
        computeBoardCorners(); // camera free-look moves each frame, so always recompute
        pin(boardReplay, blPos);
      } else {
        boardReplay.style.display = "none";
      }
    },
    handle,
  };
}
