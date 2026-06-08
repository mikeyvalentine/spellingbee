import * as THREE from "three";
import type { NetClient } from "./net";
import type { AvatarManager } from "./avatars";
import type { Classroom, CameraPose } from "./classroom";

interface BeeOpts {
  net: NetClient;
  localId: string;
  getName: (id: string) => string;
  camera: THREE.PerspectiveCamera;
  avatars: AvatarManager;
  classroom: Classroom;
}

export interface BeeStage {
  update(): void; // per-frame: drive the render camera + live speller transform
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
  const { net, localId, getName, camera, avatars, classroom } = opts;

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
  let typed = ""; // the speller's current guess (real text; display is censored)
  let amSpectator = false; // connected during a match, not one of the players
  let answered = false;
  let timerRaf = 0;
  let lastAudioRound = -1;

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

  // Replay button pinned to the chalkboard's bottom-right corner (the only HUD
  // shown during a turn — the rest of the modal is gone).
  const boardReplay = document.createElement("button");
  boardReplay.id = "board-replay";
  boardReplay.textContent = "↺ Replay"; // round replay arrow + chalk text
  Object.assign(boardReplay.style, {
    position: "fixed", zIndex: "15", display: "none",
    transform: "translate(calc(-100% - 12px), calc(-100% - 10px))",
    background: "none", border: "0", padding: "0", cursor: "pointer",
    color: "#f4f1e8", // chalk
    font: "600 24px 'ABC Stefan Simple', system-ui, sans-serif",
    textShadow: "0 2px 4px rgba(0,0,0,0.45)",
  } as any);
  boardReplay.addEventListener("click", () => {
    if (lastBuffer) playBuffer(lastBuffer);
  });
  document.body.appendChild(boardReplay);

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
    cancelAnimationFrame(timerRaf);
    activeSpeller = null;
    amSpectator = false;
    specBanner.style.display = "none";
    seatOrder = queue;
    classroom.root.visible = true;
    boardReplay.style.display = "none";
    classroom.clearStats();
    updateMatchHud();
    seatPlayers();
  };

  const enterMatch = (order: string[]) => {
    phase = "match";
    seatOrder = order.length ? order : seatOrder;
    amSpectator = order.length > 0 && !order.includes(localId);
    specBanner.style.display = amSpectator ? "block" : "none";
    activeSpeller = null;
    classroom.root.visible = true;
    classroom.setBoardHeader("🐝 Spelling Bee");
    classroom.clearBoard(0);
    updateMatchHud(); // desktop: hidden · touch: slim bottom bar
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
    const shown = censor(typed);
    classroom.setBoardGuess(shown, curLength);
    net.sendBee({ type: "bee_key", text: shown }); // spectators see the censored guess
  };
  // Desktop path: the field is a passive mirror, so echo the censored guess there.
  const renderGuess = () => {
    input.value = censor(typed);
    pushGuess();
  };

  const submit = () => {
    if (answered || !amSpeller) return;
    answered = true;
    net.sendBee({ type: "bee_answer", text: typed });
    statusEl.textContent = `🔒 Locked in: ${censor(typed) || "(blank)"}`;
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
    const raw = input.value.toLowerCase().replace(/[^a-z]/g, "").slice(0, curLength);
    if (input.value !== raw) input.value = raw;
    typed = raw;
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
      if (typed.length) {
        typed = typed.slice(0, -1);
        renderGuess();
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    } else if (/^[a-zA-Z]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (typed.length < curLength) {
        typed += e.key.toLowerCase();
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

      case "bee_turn": {
        activeSpeller = m.spellerId;
        curLength = m.length;
        curRound = m.round;
        curTier = tierLabel(m.tier ?? "");
        curTierColor = tierColor(m.tier ?? "easy");
        amSpeller = m.spellerId === localId;
        answered = false;
        typed = ""; // fresh guess; typing is captured globally (no click needed)
        lastBuffer = null; // word audio arrives via bee_audio
        seatPlayers();
        // Secondary board: current speller's name + (cumulative) accuracy, WPM resets.
        classroom.setStats(getName(m.spellerId), 0, m.accuracy ?? 100);

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
        classroom.setStats(getName(m.spellerId), m.wpm ?? 0, m.accuracy ?? 100);
        break;

      case "bee_turn_result": {
        cancelAnimationFrame(timerRaf);
        timerbar.style.width = "0%";
        answered = true; // turn resolved — close the touch input row + keyboard
        updateMatchHud();
        if (isTouch) input.blur();
        classroom.setBoardResult(m.word, m.correct);
        // Let the result word linger, then erase both boards char-by-char so
        // they're blank when the next speller's turn writes in.
        window.setTimeout(() => classroom.hideBoards(), 500);
        // Wrong answer → the speller plays a one-shot reaction (duck, or punch if
        // they have no duck clip) that finishes just before the next round starts.
        if (!m.correct && !avatars.playEmote(m.spellerId, "duck")) {
          avatars.playEmote(m.spellerId, "punch");
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
        const w = m.winnerId as string | null;
        whoEl.textContent = "🏆 Match over";
        statusEl.textContent = w
          ? w === localId
            ? "🏆 You win!"
            : `🏆 ${getName(w)} wins!`
          : `Game over — reached round ${m.rounds}`;
        classroom.setBoardHeader(w ? `🏆 ${getName(w)} wins!` : "Game over");
        classroom.clearStats();
        answered = true;
        updateMatchHud();
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

  // Project the board's four corners and place the Replay button at the one that
  // lands bottom-right on screen.
  const cornerV = new THREE.Vector3();
  const positionBoardReplay = () => {
    const mesh = classroom.boardMesh as THREE.Mesh;
    const geo = mesh.geometry as THREE.PlaneGeometry;
    const hw = (geo.parameters?.width ?? 4) / 2;
    const hh = (geo.parameters?.height ?? 2) / 2;
    mesh.updateWorldMatrix(true, false);
    let bx = -Infinity;
    let by = -Infinity;
    let best = -Infinity;
    for (const [x, y] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) {
      cornerV.set(x, y, 0).applyMatrix4(mesh.matrixWorld).project(camera);
      const sx = (cornerV.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-cornerV.y * 0.5 + 0.5) * window.innerHeight;
      if (sx + sy > best) {
        best = sx + sy;
        bx = sx;
        by = sy;
      }
    }
    boardReplay.style.left = `${bx}px`;
    boardReplay.style.top = `${by}px`;
    boardReplay.style.display = "block";
  };

  return {
    update: () => {
      applyCamera(phase === "match" ? classroom.matchCam : classroom.lobbyCam);
      // Re-apply seated positions every frame so the seat-offset slider is live.
      seatOrder.forEach((id, i) => {
        if (phase === "match" && (id === activeSpeller || i === 0)) return;
        const av = avatars.get(id);
        if (av && av.visible) placeSeated(av, i);
      });
      // Keep the speller placed/scaled live (so debug sliders apply) and turned
      // to face the match camera.
      if (phase === "match" && activeSpeller) {
        const sp = avatars.get(activeSpeller);
        if (sp) {
          sp.position.copy(classroom.spellerPos);
          sp.scale.setScalar(classroom.spellerScale);
          const dx = classroom.matchCam.pos.x - sp.position.x;
          const dz = classroom.matchCam.pos.z - sp.position.z;
          sp.rotation.y = Math.atan2(dx, dz);
        }
      }

      // Pin the Replay button to the chalkboard's bottom-right corner. On touch
      // the slim match bar carries Replay instead, so skip the floating one.
      if (phase === "match" && !isTouch) positionBoardReplay();
      else boardReplay.style.display = "none";
    },
    handle,
  };
}
