import * as THREE from "three";
import type { NetClient } from "./net";
import type { AvatarManager } from "./avatars";
import type { Classroom, CameraPose } from "./classroom";
import { makeTomato } from "./tomato";
import { makeChalk } from "./chalk";

interface BeeOpts {
  net: NetClient;
  localId: string;
  getName: (id: string) => string;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene; // tomato flights live in the scene
  avatars: AvatarManager;
  classroom: Classroom;
  callRoomKey: string; // this client's home room, to return to on "leave match"
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

const tierLabel = (t: string) =>
  ({ easy: "EASY", medium: "MEDIUM", hard: "HARD", veryhard: "VERY HARD", impossible: "IMPOSSIBLE" } as Record<string, string>)[
    t
  ] ?? t.toUpperCase();

// easy = white chalk, medium = yellow, hard and above = red.
const tierColor = (t: string) =>
  t === "easy" ? "#f4f1e8" : t === "medium" ? "#ffd23b" : "#ff6b6b";

export function setupBee(opts: BeeOpts): BeeStage {
  const { net, localId, getName, camera, scene, avatars, classroom, callRoomKey } = opts;
  const debug = !!opts.debug;

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

  // ---- tomato power-up (3D) ----
  // A tomato idles in the lower-right corner (camera-anchored) and spins on a
  // tilted axis while you can throw. Click it to throw: the splat lands on the
  // board for ~75% of the time left, covering all but the last 2 letters. On the
  // server round-trip (bee_splat) EVERYONE sees a tomato arc toward the board.
  const tomato = makeTomato(camera, scene);

  // Hover tooltip ("Throw tomato"), following the cursor.
  const tomatoTip = document.createElement("div");
  tomatoTip.id = "tomato-tip";
  tomatoTip.textContent = "Throw tomato";
  Object.assign(tomatoTip.style, {
    position: "fixed", zIndex: "17", display: "none", pointerEvents: "none",
    padding: "5px 10px", borderRadius: "8px", transform: "translate(-50%, -135%)",
    background: "rgba(12,15,22,0.9)", color: "#ffd9d2", border: "1px solid #5a2b26",
    font: "600 12px system-ui, sans-serif", whiteSpace: "nowrap",
    boxShadow: "0 4px 14px rgba(0,0,0,0.5)",
  } as any);
  document.body.appendChild(tomatoTip);

  // ---- golden chalk power-up (3D), idling just LEFT of the tomato ----
  const chalk = makeChalk(camera, scene);
  const chalkTip = document.createElement("div");
  chalkTip.id = "chalk-tip";
  chalkTip.textContent = "Golden chalk: reveal a letter";
  Object.assign(chalkTip.style, {
    position: "fixed", zIndex: "17", display: "none", pointerEvents: "none",
    padding: "5px 10px", borderRadius: "8px", transform: "translate(-50%, -135%)",
    background: "rgba(12,15,22,0.9)", color: "#ffe9a8", border: "1px solid #6a531f",
    font: "600 12px system-ui, sans-serif", whiteSpace: "nowrap",
    boxShadow: "0 4px 14px rgba(0,0,0,0.5)",
  } as any);
  document.body.appendChild(chalkTip);

  // ---- toolbar: a small rounded backing panel (camera-anchored) that the corner
  // power-ups sit inside, so they read as a little tool tray in the lower-right. ----
  const toolbar = (() => {
    const c = document.createElement("canvas");
    c.width = 320; c.height = 184;
    const x = c.getContext("2d")!;
    const pad = 6, r = 40, w = c.width, h = c.height;
    const rr = () => {
      x.beginPath();
      x.moveTo(pad + r, pad);
      x.arcTo(w - pad, pad, w - pad, h - pad, r);
      x.arcTo(w - pad, h - pad, pad, h - pad, r);
      x.arcTo(pad, h - pad, pad, pad, r);
      x.arcTo(pad, pad, w - pad, pad, r);
      x.closePath();
    };
    x.fillStyle = "rgba(14,17,24,0.5)"; rr(); x.fill();
    x.lineWidth = 4; x.strokeStyle = "rgba(255,255,255,0.10)"; rr(); x.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.62, 0.36),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false })
    );
    mesh.renderOrder = 997; // behind the items (998)
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  })();
  const TOOLBAR_POS = new THREE.Vector3(0.645, -0.52, -1.37); // just behind the items' plane
  const toolbarMat = new THREE.Matrix4();
  const toolbarQ = new THREE.Quaternion();
  const toolbarScl = new THREE.Vector3(1, 1, 1);

  // Each power-up is on-screen for any in-match participant who still has it, and
  // shows the shared "cannot be used" disabled state when its own availability
  // rule isn't met. Tomato: usable only on OTHER players' turns (you can't tomato
  // your own word). Chalk: usable only on YOUR turn.
  const tomatoVisible = () =>
    phase === "match" && !amSpectator && !matchOver && aliveIds.includes(localId) && !tomatoUsedThisTurn;
  const canThrow = () => tomatoVisible() && !amSpeller;
  const chalkVisible = () =>
    phase === "match" && !amSpectator && !matchOver && aliveIds.includes(localId) && !chalkUsedThisMatch;
  const canChalk = () =>
    chalkVisible() && amSpeller && !answered && curLength > 0;

  const hideTips = () => {
    tomatoTip.style.display = "none";
    chalkTip.style.display = "none";
    if (!chalkAiming) document.body.style.cursor = "";
  };

  const updateTomatoBtn = () => {
    // setActive before setVisible: on (re)appear the base snaps to the current
    // active state (no active→disabled tween flash).
    tomato.setActive(canThrow());
    tomato.setVisible(tomatoVisible());
    chalk.setActive(canChalk());
    chalk.setVisible(chalkVisible());
    if (!canChalk() && chalkAiming) cancelAim();
    if (!tomatoVisible() && !chalkVisible()) hideTips();
  };

  const ndcOf = (e: PointerEvent) =>
    [(e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1] as const;

  const throwTomato = () => {
    if (!canThrow()) return;
    net.sendBee({ type: "bee_tomato" });
    tomatoUsedThisTurn = true; // tomatoVisible() now false → the corner tomato hides as the flight starts
    tomato.setVisible(false);
    hideTips();
  };

  // Chalk aim mode: arm on click, then pick a board slot to reveal.
  function startAim() {
    chalkAiming = true;
    chalk.setHover(false);
    chalkTip.style.display = "none";
    classroom.setBoardAim(-1);
    document.body.style.cursor = "crosshair";
  }
  function cancelAim() {
    chalkAiming = false;
    classroom.setBoardAim(-1);
    document.body.style.cursor = "";
  }

  const showTip = (tip: HTMLElement, e: PointerEvent) => {
    tip.style.display = "block";
    tip.style.left = `${e.clientX}px`;
    tip.style.top = `${e.clientY}px`;
  };
  window.addEventListener("pointermove", (e) => {
    const [x, y] = ndcOf(e);
    // Aim mode: track which letter slot is under the cursor.
    if (chalkAiming) {
      const idx = classroom.boardSlotAt(x, y, camera);
      classroom.setBoardAim(idx);
      document.body.style.cursor = idx >= 0 ? "pointer" : "crosshair";
      return;
    }
    // Both power-ups are on-screen during a match (each greys to its disabled
    // state when unavailable), so check both. They never overlap.
    let cursor = "";
    if (tomatoVisible()) {
      const over = tomato.hitTest(x, y);
      const active = canThrow();
      tomato.setHover(over && active);
      if (over) {
        tomatoTip.textContent = active ? "Throw tomato" : "You can’t tomato your own word";
        showTip(tomatoTip, e);
        cursor = active ? "pointer" : "not-allowed";
      } else tomatoTip.style.display = "none";
    } else tomatoTip.style.display = "none";

    if (chalkVisible()) {
      const over = chalk.hitTest(x, y);
      const active = canChalk();
      chalk.setHover(over && active); // disabled chalk shows no scale/glow
      if (over) {
        chalkTip.textContent = active ? "Golden chalk: reveal a letter" : "Golden chalk only available during your turn";
        showTip(chalkTip, e);
        cursor = active ? "pointer" : "not-allowed";
      } else chalkTip.style.display = "none";
    } else chalkTip.style.display = "none";

    document.body.style.cursor = cursor;
  });
  window.addEventListener("pointerdown", (e) => {
    const [x, y] = ndcOf(e);
    if (chalkAiming) {
      const idx = classroom.boardSlotAt(x, y, camera);
      if (idx >= 0) net.sendBee({ type: "bee_chalk", index: idx }); // reveal confirmed on bee_reveal
      cancelAim(); // a click on empty space cancels without spending it
      e.stopPropagation();
      return;
    }
    if (canThrow() && tomato.hitTest(x, y)) { e.stopPropagation(); throwTomato(); return; }
    if (canChalk() && chalk.hitTest(x, y)) { e.stopPropagation(); startAim(); return; }
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
    specBanner.style.display = "block";
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
    out.push(`<div class="menu-item disabled">⚙ Settings — coming soon</div>`);
    menuItems.innerHTML = out.join("");
    document.getElementById("mi-spectate")?.addEventListener("click", () => { becomeSpectator(); closeMenu(); });
    document.getElementById("mi-leave")?.addEventListener("click", () => { leaveMatch(); closeMenu(); });
  };

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
  let audioCtx: AudioContext | null = null;
  let curSource: AudioBufferSourceNode | null = null;
  let lastBuffer: AudioBuffer | null = null; // the trimmed word, for Replay
  const ensureAudio = () => (audioCtx ??= new AudioContext());
  const playBuffer = (buf: AudioBuffer) => {
    const c = ensureAudio();
    if (curSource) {
      try {
        curSource.stop();
      } catch {
        /* already stopped */
      }
    }
    const s = c.createBufferSource();
    s.buffer = buf;
    s.connect(c.destination);
    s.start();
    curSource = s;
  };
  const decodeB64 = (b64: string) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return ensureAudio().decodeAudioData(arr.buffer);
  };
  const playB64 = (b64: string) => decodeB64(b64).then(playBuffer).catch(() => {});
  const bankB64 = (b64: string) =>
    decodeB64(b64)
      .then((buf) => {
        lastBuffer = buf;
      })
      .catch(() => {});

  // Short keyboard "tick" played on each keystroke (a high-passed noise burst).
  const playClick = () => {
    try {
      const c = ensureAudio();
      const len = Math.floor(c.sampleRate * 0.02);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      const src = c.createBufferSource();
      src.buffer = buf;
      const hp = c.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 1600;
      const g = c.createGain();
      g.gain.value = 0.14;
      src.connect(hp);
      hp.connect(g);
      g.connect(c.destination);
      src.start();
    } catch {
      /* ignore */
    }
  };
  // Browsers require a gesture before audio; resume on first interaction.
  window.addEventListener(
    "pointerdown",
    () => {
      try {
        ensureAudio().resume();
      } catch {
        /* ignore */
      }
    },
    { once: true }
  );

  // ---------- timer ----------
  const countdown = (durationMs: number) => {
    const end = performance.now() + durationMs;
    cancelAnimationFrame(timerRaf);
    const tick = () => {
      const frac = Math.max(0, (end - performance.now()) / durationMs);
      timerbar.style.width = `${frac * 100}%`;
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
      const seat = classroom.seats[i];
      if (!seat || (phase === "match" && i === 0)) {
        av.visible = false; // no seat, or this is the match-camera seat
        return;
      }
      placeSeated(av, i);
      av.visible = true;
    });
  };

  const enterLobby = (queue: string[]) => {
    phase = "lobby";
    matchOver = false;
    cancelAnimationFrame(timerRaf);
    activeSpeller = null;
    amSpectator = false;
    specBanner.style.display = "none";
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
    seatOrder = order.length ? order : seatOrder;
    amSpectator = order.length > 0 && !order.includes(localId);
    specBanner.style.display = amSpectator ? "block" : "none";
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
  input.readOnly = !isTouch;

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

  // Show / lay out the bottom match bar. On touch it's the slim
  // input + replay + timer bar; on desktop it stays hidden (the 3D board and the
  // floating Replay button are the only match chrome).
  const updateMatchHud = () => {
    if (!isTouch || phase !== "match") {
      hud.style.display = "none";
      hud.classList.remove("mobile-bar", "no-input");
      return;
    }
    hud.classList.add("mobile-bar");
    const showInput = amSpeller && !answered && !amSpectator;
    hud.classList.toggle("no-input", !showInput);
    hud.style.display = "flex";
  };

  // Touch typing: the native field is the source of truth. Sanitize to letters,
  // clamp to the word length, then mirror to the board/spectators.
  input.addEventListener("input", () => {
    if (!isTouch || phase !== "match" || !amSpeller || answered) return;
    // Distribute the native field's letters into the empty (non-gold) slots in order.
    const raw = input.value.toLowerCase().replace(/[^a-z]/g, "");
    let ti = 0;
    for (let i = 0; i < curLength; i++) { if (gold[i]) continue; slots[i] = ti < raw.length ? raw[ti++] : null; }
    const clamped = raw.slice(0, ti); // clamp the field to what actually fit
    if (input.value !== clamped) input.value = clamped;
    pushGuess();
  });
  input.addEventListener("keydown", (e) => {
    if (!isTouch || phase !== "match" || !amSpeller || answered) return;
    if (e.key === "Enter") {
      submit();
      input.blur(); // dismiss the native keyboard once locked in
      e.preventDefault();
    }
  });

  // Always-listening key capture for the speller (no focus/click required).
  // Desktop only — on touch the native field above drives the guess.
  window.addEventListener("keydown", (e) => {
    if (isTouch) return;
    if (phase !== "match" || !amSpeller || answered) return;
    if (e.key === "Enter") {
      submit();
      e.preventDefault();
      e.stopImmediatePropagation();
    } else if (e.key === "Backspace") {
      if (delLetter()) renderGuess();
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
          from = tomato.cornerWorldPos(new THREE.Vector3());
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
        classroom.revealBoards();

        whoEl.textContent = amSpeller
          ? "Your turn — get ready…"
          : `${getName(m.spellerId)} is up…`;
        roundEl.textContent = `Round ${curRound} · ${curTier} · ${m.alive.length} still in`;
        input.value = "";
        statusEl.textContent = amSpeller ? "🔊 Getting your word…" : "";
        aliveEl.textContent = "";
        timerbar.style.width = "100%";
        updateMatchHud(); // (re)show the slim bar on touch; toggles the input row
        updateTomatoBtn(); // show the tomato to eligible waiting players
        // Raise the native keyboard for the speller on touch devices.
        if (isTouch && amSpeller) input.focus();
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
        timerbar.style.width = "0%";
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

      case "bee_over": {
        cancelAnimationFrame(timerRaf);
        matchOver = true; // hide the board replay/confirm buttons on the end screen
        const w = m.winnerId as string | null;
        whoEl.textContent = "Game Over";
        statusEl.textContent = w ? `Winner: ${getName(w)}` : "Game over";
        // Game-over screen on the board: "GAME OVER" + "Winner: <name>" below.
        classroom.setEndScreen("GAME OVER", w ? `Winner: ${getName(w)}` : "");
        classroom.clearStats();
        answered = true;
        aliveIds = [];
        classroom.clearSplat();
        updateMatchHud();
        updateTomatoBtn();
        if (isTouch) input.blur();
        specBanner.style.display = "none";
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

  // ---- subtle camera life: cursor parallax (both cams) + idle "breathing" bob
  // (match only). Applied on top of the base pose every frame. ----
  let targetMx = 0, targetMy = 0; // cursor in NDC [-1,1]
  let curMx = 0, curMy = 0; // eased toward the target
  let bobT = 0;
  const MAX_YAW = 0.045, MAX_PITCH = 0.03; // cursor-look amounts (radians)
  const BOB_Y = 0.014, BOB_X = 0.008; // breathing translation (world units)
  window.addEventListener("pointermove", (e) => {
    targetMx = (e.clientX / window.innerWidth) * 2 - 1;
    targetMy = (e.clientY / window.innerHeight) * 2 - 1;
  });
  const applyCameraLife = (dt: number) => {
    // Breathing bob (match only): a gentle up/down + side sway along the camera's
    // own axes, two slightly different frequencies so it doesn't feel mechanical.
    if (phase === "match") {
      bobT += dt;
      camera.translateY(Math.sin(bobT * 1.1) * BOB_Y);
      camera.translateX(Math.sin(bobT * 0.73) * BOB_X);
    }
    // Cursor parallax (both cams): look slightly toward the cursor — right of the
    // page pans the view right, etc. Eased so it glides rather than snaps.
    curMx += (targetMx - curMx) * Math.min(1, dt * 5);
    curMy += (targetMy - curMy) * Math.min(1, dt * 5);
    camera.rotateY(-curMx * MAX_YAW);
    camera.rotateX(-curMy * MAX_PITCH);
  };

  // The board + camera are static at runtime, so the board's projected screen
  // corners only change on resize or a phase (camera) change — cache them and
  // recompute only when dirty, instead of projecting 4 corners every frame.
  const cornerV = new THREE.Vector3();
  const blPos = { x: 0, y: 0 }, brPos = { x: 0, y: 0 };

  const computeBoardCorners = () => {
    const mesh = classroom.boardMesh as THREE.Mesh;
    const geo = mesh.geometry as THREE.PlaneGeometry;
    const hw = (geo.parameters?.width ?? 4) / 2;
    const hh = (geo.parameters?.height ?? 2) / 2;
    mesh.updateWorldMatrix(true, false);
    camera.updateMatrixWorld(true); // ensure matrixWorldInverse is current for project()
    let blBest = -Infinity, brBest = -Infinity;
    for (const [x, y] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) {
      cornerV.set(x, y, 0).applyMatrix4(mesh.matrixWorld).project(camera);
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
      applyCamera(phase === "match" ? classroom.matchCam : classroom.lobbyCam);
      applyCameraLife(dt); // breathing bob (match) + cursor parallax (both)
      // Toolbar tray behind the items (shown whenever a power-up is on-screen).
      toolbar.visible = tomatoVisible() || chalkVisible();
      if (toolbar.visible) {
        camera.updateMatrixWorld();
        toolbarMat.compose(TOOLBAR_POS, toolbarQ, toolbarScl);
        toolbar.matrix.multiplyMatrices(camera.matrixWorld, toolbarMat);
        toolbar.matrixWorldNeedsUpdate = true;
      }
      tomato.update(dt); // anchor + spin the corner tomato; advance any flights
      chalk.update(dt); // anchor + spin the corner golden chalk

      // Seats + speller are placed once by seatPlayers() on each state change; only
      // re-apply them every frame in mock/dev so the debug sliders stay live.
      if (debug) {
        seatOrder.forEach((id, i) => {
          if (phase === "match" && (id === activeSpeller || i === 0)) return;
          const av = avatars.get(id);
          if (av && av.visible) placeSeated(av, i);
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
