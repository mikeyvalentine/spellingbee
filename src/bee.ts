import * as THREE from "three";
import type { NetClient } from "./net";
import type { AvatarManager } from "./avatars";
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
const CHAIR_MODELS = [0, 4, 5, 3, 1, 2, 6, 0];

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

  // Toggle both spectator indicators together.
  const setSpec = (on: boolean) => {
    specBanner.style.display = on ? "block" : "none";
    specBottom.style.display = on ? "block" : "none";
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

  // Checkmark at the chalkboard's bottom-RIGHT corner — confirms the speller's
  // word (same as pressing Enter). Only shown to the speller, before they answer.
  const boardCheck = document.createElement("button");
  boardCheck.id = "board-check";
  boardCheck.textContent = "✔";
  boardCheck.title = "Confirm your word (Enter)";
  Object.assign(boardCheck.style, {
    position: "fixed", zIndex: "15", display: "none",
    // Anchoring transform + hover live in CSS (#board-check).
    background: "none", border: "0", padding: "0", cursor: "pointer",
    color: "#f4f1e8", // white chalk
    font: "700 32px 'ABC Stefan Simple', system-ui, sans-serif",
    textShadow: "0 2px 5px rgba(0,0,0,0.5)",
  } as any);
  boardCheck.addEventListener("click", () => submit());
  document.body.appendChild(boardCheck);

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

  // NDC relative to the CANVAS rect (not the window) — on mobile/Discord the
  // canvas may be offset by safe-area insets, so window-based coords miss the ray.
  const sceneCanvas = document.getElementById("app") as HTMLCanvasElement;
  const ndcOf = (e: PointerEvent) => {
    const r = sceneCanvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1] as const;
  };

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

  // Chalk aim: tap the chalk → EVERY slot pulses ("pick any letter"). Tap one →
  // only that slot pulses (armed). Tap it again → confirm + reveal.
  function startAim() {
    chalkAiming = true;
    armedAim = -1;
    document.body.style.cursor = "crosshair";
    // Mobile: pulse every slot to pick from. Desktop: no all-slots highlight —
    // the oval just follows the cursor (hover) onto a single slot.
    if (isTouch) classroom.setBoardAimAll();
    else classroom.setBoardAim(-1);
  }
  function cancelAim() {
    chalkAiming = false;
    armedAim = -1;
    classroom.setBoardAim(-1);
    document.body.style.cursor = "";
  }

  // These listen on the CANVAS (not window) — some webviews (Discord mobile)
  // swallow window-level touch events, but the canvas under the finger still gets
  // them. Desktop: hover narrows the pulse to the hovered slot; click confirms.
  sceneCanvas.addEventListener("pointermove", (e) => {
    if (!chalkAiming || isTouch) return;
    const [x, y] = ndcOf(e);
    const idx = classroom.boardSlotAt(x, y, camera);
    classroom.setBoardAim(idx); // idx<0 clears the oval (no all-slots on desktop)
    document.body.style.cursor = idx >= 0 ? "pointer" : "crosshair";
  });
  sceneCanvas.addEventListener("pointerdown", (e) => {
    if (!chalkAiming) return;
    const [x, y] = ndcOf(e);
    const idx = classroom.boardSlotAt(x, y, camera);
    if (isTouch) {
      // First tap on a slot narrows to it; a second tap on the SAME slot confirms.
      // Off-slot taps are ignored (tap the chalk again to cancel).
      if (idx < 0) return;
      if (idx === armedAim) { net.sendBee({ type: "bee_chalk", index: idx }); cancelAim(); }
      else { armedAim = idx; classroom.setBoardAim(idx); }
    } else {
      // Desktop: the hover already narrowed the oval, so a click confirms.
      if (idx >= 0) net.sendBee({ type: "bee_chalk", index: idx });
      cancelAim();
    }
    e.stopPropagation();
  });
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
      out.push(`<button class="menu-item danger" id="mi-leave">🚪 Leave match</button>`);
      out.push(`<div class="menu-sep"></div>`);
    }
    out.push(`<button class="menu-item" id="mi-settings">⚙ Settings</button>`);
    menuItems.innerHTML = out.join("");
    document.getElementById("mi-spectate")?.addEventListener("click", () => { becomeSpectator(); closeMenu(); });
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
      if (frac > 0) timerRaf = requestAnimationFrame(tick);
    };
    tick();
  };

  // ---------- 3D placement ----------
  // Seat every player at their join-order camera. The active speller (match only)
  // is pulled to the front spot instead; the avatar occupying the fixed match
  // camera (seat 0) is hidden so we don't render inside its head.
  const placeSeated = (av: THREE.Object3D, i: number) => {
    const seat = classroom.seats[i];
    if (!seat) return;
    av.position.copy(seat.pos).add(classroom.seatOffset);
    const per = classroom.seatOffsets[i];
    if (per) av.position.add(per);
    av.rotation.y = seat.yaw;
  };

  // Lobby seating skips the host (they stand at the front, at the lobby camera):
  // the first NON-host player takes the 'player' seat, the next 'player.1', etc.
  const lobbySeatIdx = (id: string) => seatOrder.filter((p) => p !== hostId).indexOf(id);

  // True when this client's POV is the shared front 'player' camera during a
  // match: the active speller (watching their own model on stage) and non-seated
  // spectators (not in the match order) use it. Everyone else watches from the
  // seat camera of their (shuffled) match-order desk.
  const onMatchCam = () =>
    phase === "match" && (localId === activeSpeller || !seatOrder.includes(localId));

  const seatPlayers = () => {
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
        av.visible = true;
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
        placeSeated(av, i);
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
      const si = lobbySeatIdx(id);
      const seat = classroom.seats[si];
      if (!seat) {
        av.visible = false; // more players than seat cameras
        return;
      }
      placeSeated(av, si);
      av.visible = true;
    });
  };

  // The desk-lamp spotlight doubles as the lobby host light. Its dialed-in stage
  // pool is a short throw (~1.4u, steep decay) that only reads with someone in
  // the beam — so in the lobby it swings to the host at the front, with gentler
  // decay + a tighter cone to survive the ~3× longer throw. A match restores the
  // baked speller-stage values.
  const spot = classroom.lights.spot;
  const spotStage = spot && {
    target: spot.target.position.clone(),
    intensity: spot.intensity, distance: spot.distance,
    angle: spot.angle, decay: spot.decay,
  };
  const aimSpotAtHost = () => {
    if (!spot) return;
    spot.target.position.set(classroom.hostSpot.pos.x, 1.2, classroom.hostSpot.pos.z);
    spot.intensity = 100; spot.distance = 9; spot.angle = 0.5; spot.decay = 1.4;
  };
  const aimSpotAtStage = () => {
    if (!spot || !spotStage) return;
    spot.target.position.copy(spotStage.target);
    spot.intensity = spotStage.intensity; spot.distance = spotStage.distance;
    spot.angle = spotStage.angle; spot.decay = spotStage.decay;
  };

  const enterLobby = (queue: string[]) => {
    phase = "lobby";
    matchOver = false;
    lastAudioRound = -1; // reset the audio-dedup key between matches
    audio.setMusicEnabled(true); // background song plays in the lobby only
    aimSpotAtHost(); // the desk lamp lights the host at the front while in the lobby
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
  };

  const enterMatch = (order: string[]) => {
    phase = "match";
    matchOver = false;
    lastAudioRound = -1; // the server resets its per-match round counter, so clear
                         // our audio-dedup key or the next match's word goes silent
    audio.setMusicEnabled(false); // silence the lobby song during the match
    aimSpotAtStage(); // lamp spotlight back on the speller stage
    seatOrder = order.length ? order : seatOrder;
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
        const onLand = () => classroom.splatTomato(dur); // splat appears when it lands
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
        sizeSlots(); // fresh empty per-slot answer (typing is captured globally)
        lastBuffer = null; // word audio arrives via bee_audio
        aliveIds = m.alive ?? aliveIds;
        tomatoUsedThisTurn = false; // fresh tomato for this opponent's turn
        if (chalkAiming) cancelAim();
        classroom.clearReveals();
        classroom.clearSplat(); // clear any splat from last turn
        seatPlayers();
        // Secondary board: current speller's name + (cumulative) accuracy, WPM resets.
        classroom.setStats(getName(m.spellerId), 0, m.accuracy ?? 100, m.spellerId === localId);

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
        updateMatchHud(); // hide the legacy HUD; (re)show the on-screen keyboard on touch
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
        break;

      case "bee_turn_result": {
        cancelAnimationFrame(timerRaf);
        classroom.clearBoardTimer();
        timerbar.style.width = "0%";
        kbdTimerbar.style.width = "0%";
        answered = true; // turn resolved — close the touch input row + keyboard
        updateMatchHud();
        if (isTouch) input.blur();
        aliveIds = m.alive ?? aliveIds;
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
  const basePose = (): CameraPose => {
    if (phase === "match") {
      if (onMatchCam()) return classroom.matchCam;
      const i = seatOrder.indexOf(localId);
      return (i >= 0 && classroom.seatCams[i]) || classroom.matchCam;
    }
    if (localId === hostId) return classroom.lobbyCam;
    const i = lobbySeatIdx(localId);
    return (i >= 0 && classroom.seatCams[i]) || classroom.lobbyCam;
  };

  // ---- camera life, applied on top of the base pose every frame ----
  // Lobby: full free-look — the view sweeps toward the cursor (desktop) or
  // follows a one-finger drag (touch). Match: idle "breathing" bob + a subtle
  // cursor parallax (unchanged this pass).
  let targetMx = 0, targetMy = 0; // cursor in NDC [-1,1]
  let curMx = 0, curMy = 0; // eased toward the target
  let bobT = 0;
  let turnTilt = 0; // 0..1 eased; on the local speller's touch turn, tilt down for the keyboard
  const MAX_YAW = 0.045, MAX_PITCH = 0.03; // match cursor-look amounts (radians)
  const BOB_Y = 0.014, BOB_X = 0.008; // breathing translation (world units)
  const TURN_TILT = 0.16; // downward pitch on the speller's touch turn (radians)
  // Free-look range: cursor at the screen edge (or a full-width drag) = full
  // sweep. Wide enough to glance "over your shoulder" without spinning the room.
  // Down gets a bit more travel than up.
  const LOOK_YAW = 1.2; // radians (~69°) each way
  const LOOK_PITCH_UP = 0.22, LOOK_PITCH_DOWN = 0.3;
  let lookTX = 0, lookTY = 0; // free-look target, -1..1 (touch drags write here)
  let lookX = 0, lookY = 0; // eased
  let lookGain = 1; // eases to 0 while the clipboard is up, so it reads calmly
  window.addEventListener("pointermove", (e) => {
    targetMx = (e.clientX / window.innerWidth) * 2 - 1;
    targetMy = (e.clientY / window.innerHeight) * 2 - 1;
  });
  const applyCameraLife = (dt: number) => {
    if (!onMatchCam()) {
      // Free-look: the lobby, and seated players waiting their turn in a match.
      // The clipboard is camera-anchored (clipboard.ts composes its matrix from
      // the camera's each frame, AFTER this runs), so it stays glued to the same
      // screen spot no matter where the player looks.
      if (!isTouch) { lookTX = targetMx; lookTY = targetMy; }
      lookGain += ((uiFocused() ? 0 : 1) - lookGain) * Math.min(1, dt * 4);
      lookX += (lookTX - lookX) * Math.min(1, dt * 5);
      lookY += (lookTY - lookY) * Math.min(1, dt * 5);
      camera.rotateY(-lookX * LOOK_YAW * lookGain);
      camera.rotateX(-lookY * (lookY > 0 ? LOOK_PITCH_DOWN : LOOK_PITCH_UP) * lookGain);
      return;
    }
    // Breathing bob: a gentle up/down + side sway along the camera's own axes,
    // two slightly different frequencies so it doesn't feel mechanical.
    bobT += dt;
    camera.translateY(Math.sin(bobT * 1.1) * BOB_Y);
    camera.translateX(Math.sin(bobT * 0.73) * BOB_X);
    // On the local speller's turn (touch), ease the view DOWN so the word rises
    // above the on-screen keyboard. (Looking down lifts the wall board in frame.)
    const tiltTarget = isTouch && amSpeller && !answered && !amSpectator ? 1 : 0;
    turnTilt += (tiltTarget - turnTilt) * Math.min(1, dt * 6);
    if (turnTilt > 0.001) camera.rotateX(-turnTilt * TURN_TILT);
    // Cursor parallax: look slightly toward the cursor, eased so it glides.
    curMx += (targetMx - curMx) * Math.min(1, dt * 5);
    curMy += (targetMy - curMy) * Math.min(1, dt * 5);
    camera.rotateY(-curMx * MAX_YAW);
    camera.rotateX(-curMy * MAX_PITCH);
  };

  // Broadcast where this player is looking (throttled) so their avatar turns its
  // head on other clients. Zeros flow once when free-look ends (e.g. on stage).
  let sentYaw = 0, sentPitch = 0, lastLookAt = 0;
  const sendLook = () => {
    const now = performance.now();
    if (now - lastLookAt < 150) return;
    const active = !onMatchCam() && lookGain > 0.05;
    const yaw = active ? -lookX * LOOK_YAW * lookGain : 0;
    const pitch = active ? -lookY * (lookY > 0 ? LOOK_PITCH_DOWN : LOOK_PITCH_UP) * lookGain : 0;
    if (Math.abs(yaw - sentYaw) < 0.02 && Math.abs(pitch - sentPitch) < 0.02) return;
    sentYaw = yaw; sentPitch = pitch; lastLookAt = now;
    net.sendBee({ type: "bee_look", yaw, pitch });
  };

  // Touch: a one-finger drag on the 3D scene looks around (whenever free-look is
  // active: the lobby + waiting players mid-match — never the speller, whose
  // canvas taps belong to the golden chalk). The drag "grabs the world": dragging
  // right swings the view left. DOM overlays (the clipboard tap-zone, panels,
  // buttons) sit above the canvas and keep their taps.
  if (isTouch) {
    let dragId: number | null = null, dragLX = 0, dragLY = 0;
    const clampLook = (v: number) => Math.max(-1, Math.min(1, v));
    sceneCanvas.addEventListener("pointerdown", (e) => {
      if (onMatchCam()) return;
      dragId = e.pointerId; dragLX = e.clientX; dragLY = e.clientY;
    });
    window.addEventListener("pointermove", (e) => {
      if (dragId !== e.pointerId || onMatchCam()) return;
      lookTX = clampLook(lookTX - ((e.clientX - dragLX) * 2.4) / window.innerWidth);
      lookTY = clampLook(lookTY - ((e.clientY - dragLY) * 2.4) / window.innerHeight);
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
          if (phase === "match") { placeSeated(av, i); return; }
          if (id === hostId) {
            av.position.copy(classroom.hostSpot.pos);
            av.rotation.y = classroom.hostSpot.yaw;
            return;
          }
          const si = lobbySeatIdx(id);
          if (classroom.seats[si]) placeSeated(av, si);
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

      // Pin the Replay (bottom-left) + the speller's Confirm checkmark
      // (bottom-right) to the board's cached corners. On touch the slim match bar
      // + keyboard handle these, so skip the floating ones.
      if (phase === "match" && !isTouch && !matchOver) {
        computeBoardCorners(); // camera bob/parallax moves each frame, so always recompute
        pin(boardReplay, blPos);
        if (amSpeller && !answered) pin(boardCheck, brPos);
        else boardCheck.style.display = "none";
      } else {
        boardReplay.style.display = "none";
        boardCheck.style.display = "none";
      }
    },
    handle,
  };
}
