// Spelling Bee — lobby + turn-based elimination (server-authoritative).
// A host opens a lobby; players join/ready; host starts. Each turn the next
// queued player must spell a narrated word while everyone watches; a miss
// eliminates them; last speller standing wins (solo = survival).
import { english10, english20, american10, american20 } from "wordlist-js";
import wotc from "./wotc.json" with { type: "json" };
import { synth } from "./tts.js";

const ROUND_MS = 22000;
const RESULT_MS = 3200; // pause between turns: result linger + board erase + a beat for the next speller's model to take the stage (desk POVs watch the swap)
const OVER_MS = 3500; // post-match celebration before the lobby reopens

// Words excluded from every pool: common HOMOPHONES (ambiguous when only heard,
// e.g. suite/sweet) and profanity (so the target word is never a swear).
const HOMOPHONES = new Set([
  "to", "too", "two", "there", "their", "your", "youre", "its", "here", "hear",
  "where", "wear", "ware", "sweet", "suite", "flour", "flower", "sea", "see",
  "son", "sun", "knight", "night", "write", "right", "rite", "wright", "no",
  "know", "one", "won", "eye", "by", "buy", "bye", "cell", "sell", "dear",
  "deer", "fair", "fare", "hour", "our", "made", "maid", "mail", "male", "meat",
  "meet", "mete", "pair", "pear", "pare", "peace", "piece", "plain", "plane",
  "rain", "reign", "rein", "road", "rode", "rowed", "sail", "sale", "scene",
  "seen", "steal", "steel", "tail", "tale", "threw", "through", "tide", "tied",
  "toe", "tow", "vain", "vein", "vane", "waist", "waste", "wait", "weight",
  "weak", "week", "which", "witch", "would", "wood", "break", "brake", "cent",
  "scent", "sent", "course", "coarse", "days", "daze", "die", "dye", "fir",
  "fur", "flew", "flu", "flue", "gait", "gate", "great", "grate", "groan",
  "grown", "hair", "hare", "hall", "haul", "heal", "heel", "heard", "herd",
  "hole", "whole", "knew", "new", "knot", "not", "lead", "led", "loan", "lone",
  "mind", "mined", "miner", "minor", "moan", "mown", "oar", "ore", "or", "pale",
  "pail", "peak", "peek", "pique", "plum", "plumb", "pole", "poll", "pray",
  "prey", "principal", "principle", "profit", "prophet", "real", "reel", "role",
  "roll", "root", "route", "rose", "rows", "sauce", "source", "sight", "site",
  "cite", "soar", "sore", "sole", "soul", "stair", "stare", "stationary",
  "stationery", "sum", "some", "team", "teem", "throne", "thrown", "thyme",
  "time", "vary", "very", "weather", "whether", "board", "bored", "bare", "bear",
  "berry", "bury", "blew", "blue", "cereal", "serial", "chord", "cord", "close",
  "clothes", "creak", "creek", "find", "fined", "for", "four", "fore", "guessed",
  "guest", "high", "hi", "hour", "idle", "idol", "in", "inn", "lessen", "lesson",
  "loot", "lute", "morning", "mourning", "none", "nun", "paws", "pause", "rap",
  "wrap", "ring", "wring", "seam", "seem", "side", "sighed", "stake", "steak",
  "sweet", "tea", "tee", "wave", "waive", "way", "weigh", "whine", "wine",
]);
const SWEARS = new Set([
  "fuck", "fucked", "fucker", "fucking", "shit", "shits", "shitty", "bitch",
  "bitches", "ass", "asshole", "bastard", "damn", "damned", "cunt", "dick",
  "dicks", "cock", "cocks", "piss", "pissed", "slut", "whore", "fag", "faggot",
  "nigger", "nigga", "crap", "wanker", "twat", "prick", "bollocks", "bugger",
  "arse", "bullshit", "douche", "dildo", "boobs", "tits", "penis", "vagina",
  "anus", "rape", "rapist", "nazi", "retard", "retarded",
]);
// Words the TTS voice mispronounces badly enough that they're unfair to spell
// from audio (e.g. "infinitival" comes out like "infinitible"). Add more as found.
const MISPRONOUNCED = new Set([
  "infinitival",
]);
const EXCLUDE = new Set([...HOMOPHONES, ...SWEARS, ...MISPRONOUNCED]);

// Difficulty grading comes from the official Scripps "Words of the Champions"
// list (wotc.json, built from the edition the host provided). IMPORTANT: the
// official levels ramp UP — One Bee is the EASIEST (grades 1-3: "water",
// "apple"), Two Bee is genuinely hard, Three Bee champions is brutal — so the
// game tiers map medium→One Bee, hard→Two Bee, veryhard→Three Bee study list,
// impossible→Three Bee champions. Easy stays frequency-based (everyday words).
function freqPool(lists, min, max) {
  const set = new Set();
  for (const list of lists)
    for (const w of list)
      if (w.length >= min && w.length <= max && /^[a-z]+$/.test(w) && !EXCLUDE.has(w)) set.add(w);
  return [...set];
}
// A WOTC tier -> playable pool (single-token, length-sane, nothing excluded).
const wotcPool = (arr) =>
  arr.filter((w) => /^[a-z]+$/.test(w) && w.length >= 3 && w.length <= 20 && !EXCLUDE.has(w));

const POOLS = {
  easy:       freqPool([english10, english20, american10, american20], 4, 8), // commonest everyday words
  medium:     wotcPool(wotc.oneBee),        // Scripps One Bee (study + champions)
  hard:       wotcPool(wotc.twoBee),        // Scripps Two Bee (study + champions)
  veryhard:   wotcPool(wotc.threeBeeStudy), // Scripps Three Bee school study list
  impossible: wotcPool(wotc.threeBee),      // Scripps Three Bee champions
};

// Difficulty ramps by ROUND (a lap = every alive player spelling once). Fixed
// schedule, identical for every lobby size:
//   Rounds 1-2 easy · 3 medium · 4 hard · 5 very hard · 6+ impossible
const tierForLap = (lap) => {
  if (lap <= 2) return "easy";
  if (lap === 3) return "medium";
  if (lap === 4) return "hard";
  if (lap === 5) return "veryhard";
  return "impossible";
};

// In-place Fisher-Yates shuffle.
const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

export function createBee(broadcast, sendTo, getPlayerIds, opts = {}) {
  // Public rooms auto-start (drop-in): once `minPlayers` are present, a countdown
  // runs and the match begins with no host action. Private rooms leave autoStart
  // off and keep the host-driven start.
  const { autoStart = false, minPlayers = 2 } = opts;
  const AUTO_COUNTDOWN_MS = 8000;
  let countdownTimer = null;
  let countdownEnd = 0;

  let phase = "idle"; // idle | lobby | match
  let hostId = null;
  let queue = []; // join order
  let ready = new Set();
  let settings = { mode: "basic", maxPlayers: 8 }; // host-controlled room settings
  let keyText = ""; // current speller's typed text (for catching spectators up)

  // ---- per-player typing stats (for the secondary stats board) ----
  const playerStats = new Map(); // id -> { letters, corrections } (this match)
  let turnTypeStart = 0; // ms timestamp of the first keystroke this turn (for WPM)
  let prevKeyLen = 0; // previous keyText length this turn (to detect backspaces)

  // ---- anti-cheat: inhuman typing speed ----
  // WPM here is measured per WORD (chars/5 over the time from the first to the
  // last keystroke), NOT a paragraph average — short, already-heard words can be
  // bursted fast, so the bar is set well above elite human bursts (~200-256 WPM):
  // sustaining this average across a whole 6+ letter word is macro/script territory.
  const INHUMAN_WPM = 280; // per-word average flagged as inhuman
  const MIN_EVAL_LEN = 6; // only judge words this long (short words are too noisy)
  const STRIKES_TO_SPECTATE = 3; // flagged rounds before being bumped to spectator
  const fastStrikes = new Map(); // id -> count of inhuman rounds this match
  let turnMaxLen = 0; // highest typed-letter count reached this turn
  let turnFastWpm = 0; // the per-word WPM at that high-water mark (stable average)

  const matchAccuracy = (id) => {
    const st = playerStats.get(id);
    if (!st || st.letters === 0) return 100;
    return Math.max(0, Math.min(100, Math.round(((st.letters - st.corrections) / st.letters) * 100)));
  };
  // Record a keystroke update for `id` (len = real typed-letter count, excluding
  // "_" placeholders + gold reveals), returning live { wpm, accuracy }.
  const recordKey = (id, len) => {
    if (turnTypeStart === 0 && len > 0) turnTypeStart = Date.now();
    const delta = len - prevKeyLen;
    prevKeyLen = len;
    let st = playerStats.get(id);
    if (!st) playerStats.set(id, (st = { letters: 0, corrections: 0 }));
    if (delta > 0) st.letters += delta;
    else if (delta < 0) st.corrections += -delta; // a backspace = a correction = a typo
    const mins = turnTypeStart ? (Date.now() - turnTypeStart) / 60000 : 0;
    const wpm = mins > 0 ? Math.round(len / 5 / mins) : 0;
    // Track the WPM at the longest input reached (= avg speed to type the word).
    if (len > turnMaxLen) { turnMaxLen = len; turnFastWpm = wpm; }
    return { wpm, accuracy: matchAccuracy(id) };
  };

  const bots = new Set(); // dev-only AI players
  const isBot = (id) => bots.has(id);
  const BOT_NAMES = ["Ada", "Bo", "Cy", "Dot", "Eve", "Fox", "Gus", "Ivy", "Jax", "Kit"];
  const EMOTES = new Set(["wave", "yes", "no", "punch", "duck"]); // desk-emote allow-list
  const emoteAt = new Map(); // id -> last emote ms (rate limit)

  let order = []; // turn order = queue snapshot at start
  let mode = "basic"; // selected gamemode (only "basic" is implemented for now)
  let alive = new Set();
  let turnIdx = -1;
  let round = 0;
  let lap = 1; // increments each time the turn order wraps around
  let currentTier = "easy";
  let accepting = false; // answers only count after the word has been spoken
  let speller = null;
  let word = "";
  let answered = false;
  let timer = null;

  // ---- tomato power-up ----
  const tomatoThrowers = new Set(); // player ids who've thrown this turn (one each)
  let turnEndsAt = 0; // ms timestamp the current turn's timer ends (for splat duration)

  // ---- golden chalk power-up ----
  const chalkUsers = new Set(); // speller ids who've spent their chalk (once per match)
  let turnReveal = null; // { index, letter } revealed this turn (for spectator catch-up)

  const lobbyState = () => ({
    type: "bee_lobby",
    phase,
    hostId,
    queue: [...queue],
    ready: [...ready],
    mode: settings.mode,
    maxPlayers: settings.maxPlayers,
  });
  const sendLobby = () => broadcast(lobbyState());

  const reset = () => {
    phase = "idle";
    hostId = null;
    queue = [];
    ready = new Set();
    order = [];
    alive = new Set();
    turnIdx = -1;
    round = 0;
    lap = 1;
    accepting = false;
    speller = null;
    word = "";
    bots.clear();
    clearTimeout(timer);
    timer = null;
    clearCountdown();
  };

  const usedWords = new Set(); // words already spelled this match (no repeats)
  const pickFrom = (tier) => {
    const pool = POOLS[tier] || POOLS.medium;
    let w;
    let tries = 0;
    do {
      w = pool[Math.floor(Math.random() * pool.length)];
    } while (usedWords.has(w) && ++tries < 40);
    usedWords.add(w);
    return w;
  };

  // Pre-synthesize a few easy words so the FIRST word of every match has instant
  // audio. Round 1 draws from here (randomized, avoiding a back-to-back repeat)
  // when available. Synthesized in PARALLEL (Google TTS is a network call, not a
  // blocking local model), so the buffer fills in ~one round trip.
  const FIRST_WORDS = [];
  let lastFirstWord = null;
  const PREWARM_TARGET = 8;
  const prewarmFirstWords = () => {
    if (FIRST_WORDS.length >= PREWARM_TARGET) return;
    const easy = POOLS.easy;
    const picks = [];
    while (picks.length < PREWARM_TARGET && picks.length < easy.length) {
      const w = easy[Math.floor(Math.random() * easy.length)];
      if (!picks.includes(w) && !FIRST_WORDS.includes(w)) picks.push(w);
    }
    for (const w of picks) {
      synth(w).then(() => { if (!FIRST_WORDS.includes(w)) FIRST_WORDS.push(w); }).catch(() => {});
    }
  };
  prewarmFirstWords(); // immediately — no warm-up delay needed for Google TTS

  // Catch a client up to the in-progress match so they spectate from the shared
  // POV (they aren't added to the queue — they join when the match ends).
  const sendSpectatorState = (id) => {
    sendTo(id, { type: "bee_match_start", order: [...order], mode });
    if (speller) {
      sendTo(id, {
        type: "bee_turn",
        spellerId: speller,
        round,
        length: word.length,
        tier: currentTier,
        alive: [...alive],
      });
      if (keyText) sendTo(id, { type: "bee_key", spellerId: speller, text: keyText });
      if (turnReveal) sendTo(id, { type: "bee_reveal", spellerId: speller, index: turnReveal.index, letter: turnReveal.letter, round });
    }
  };

  const join = (id) => {
    if (phase === "match") {
      sendSpectatorState(id); // spectate; can't join mid-match
      return;
    }
    prewarmFirstWords(); // top up the opening-word buffer before anyone can Start
    if (phase === "idle") {
      phase = "lobby";
      hostId = id;
    }
    if (!queue.includes(id)) {
      if (queue.length >= settings.maxPlayers) { sendTo(id, lobbyState()); return; } // room full
      queue.push(id);
    }
    sendLobby();
    maybeAutoStart();
  };

  const leave = (id) => {
    queue = queue.filter((q) => q !== id);
    ready.delete(id);
    if (id === hostId) hostId = queue[0] || null;
    if (queue.length === 0) reset();
    sendLobby();
    maybeAutoStart();
  };

  const addBots = (n) => {
    if (phase !== "lobby") return; // only fill the lobby pre-match
    let added = 0;
    for (const name of BOT_NAMES) {
      if (added >= (n || 4)) break;
      const id = "bot:" + name;
      if (queue.includes(id)) continue;
      bots.add(id);
      queue.push(id);
      ready.add(id);
      added++;
    }
    sendLobby();
  };

  // Bots idly glance around so their heads move like real players' (and so head
  // tracking is testable solo). New gaze targets every few ticks; the client
  // eases between them. The current speller's gaze is recentered instead.
  setInterval(() => {
    if (!bots.size || !getPlayerIds().length) return;
    for (const b of bots) {
      if (b === speller) {
        broadcast({ type: "bee_look", id: b, yaw: 0, pitch: 0 });
        continue;
      }
      if (Math.random() < 0.4) continue; // sometimes hold the current gaze
      const yaw = (Math.random() * 2 - 1) * 0.9;
      const pitch = (Math.random() * 2 - 1) * 0.25;
      broadcast({ type: "bee_look", id: b, yaw, pitch });
    }
  }, 2200);

  // Remove the most recently added bot (lobby only).
  const removeBot = () => {
    if (phase !== "lobby") return;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!isBot(queue[i])) continue;
      const id = queue[i];
      queue.splice(i, 1);
      bots.delete(id);
      ready.delete(id);
      sendLobby();
      return;
    }
  };

  const misspell = (w) => {
    if (w.length <= 3) return w + "x";
    const i = 1 + Math.floor(Math.random() * (w.length - 2));
    return w.slice(0, i) + w.slice(i + 1); // drop a letter
  };

  // Bots "type" their guess letter-by-letter (so spectators see it), ~60% right.
  const botPlay = (botId, turnRound) => {
    const typed = Math.random() < 0.6 ? word : misspell(word);
    let i = 0;
    const step = () => {
      if (phase !== "match" || speller !== botId || round !== turnRound) return;
      i++;
      keyText = typed.slice(0, i);
      const s = recordKey(botId, keyText);
      broadcast({ type: "bee_key", spellerId: botId, text: keyText, wpm: s.wpm, accuracy: s.accuracy });
      if (i < typed.length) setTimeout(step, 160 + Math.random() * 140);
      else
        setTimeout(() => {
          if (phase === "match" && speller === botId && round === turnRound)
            resolveTurn(typed);
        }, 600);
    };
    setTimeout(step, 800 + Math.random() * 700);
  };

  const doStart = (requestedMode) => {
    clearCountdown();
    // Randomize the line-up per match; the order then stays fixed for every lap.
    order = shuffle([...queue]);
    mode = requestedMode || "basic";
    alive = new Set(order);
    turnIdx = -1;
    round = 0;
    lap = 1;
    usedWords.clear(); // no repeated words within a match
    playerStats.clear(); // reset per-player accuracy for the new match
    fastStrikes.clear(); // reset inhuman-speed strikes for the new match
    chalkUsers.clear(); // everyone gets a fresh golden chalk this match
    phase = "match";
    broadcast({ type: "bee_match_start", order: [...order], mode });
    // Brief beat before round 1, then begin. Warm the opening word's audio now —
    // Google TTS is an async network call (non-blocking), so synthesizing here just
    // overlaps the beat instead of delaying the turn.
    if (advanceAndPrepare()) setTimeout(beginTurn, 200);
    else endMatch();
  };

  const startMatch = (id, requestedMode) => {
    if (phase !== "lobby" || id !== hostId || queue.length < 1) return;
    doStart(requestedMode);
  };

  // ---- public-room auto-start (drop-in) ----
  const sendCountdown = (cancelled = false) => {
    const ms = cancelled ? 0 : Math.max(0, countdownEnd - Date.now());
    broadcast({ type: "bee_countdown", ms, seconds: Math.ceil(ms / 1000), cancelled });
  };
  const clearCountdown = () => {
    if (countdownTimer) clearTimeout(countdownTimer);
    countdownTimer = null;
    countdownEnd = 0;
  };
  // Re-evaluate whether a public lobby should be counting down. Called whenever
  // the lobby population changes.
  const maybeAutoStart = () => {
    if (!autoStart || phase !== "lobby") return;
    if (queue.length >= minPlayers) {
      if (!countdownTimer) {
        countdownEnd = Date.now() + AUTO_COUNTDOWN_MS;
        countdownTimer = setTimeout(() => {
          countdownTimer = null;
          countdownEnd = 0;
          if (phase === "lobby" && queue.length >= minPlayers) doStart("basic");
        }, AUTO_COUNTDOWN_MS);
      }
      sendCountdown(); // (re)broadcast remaining time, syncing any late joiners
    } else if (countdownTimer) {
      clearCountdown();
      sendCountdown(true); // dropped below the minimum — abort the countdown
    }
  };

  // Advance to the next alive speller, pick their word, and (if warm) pre-generate
  // its audio so it's cached/instant when the turn plays. Returns false if no one
  // is left. Run at the START of the result pause to hide synth latency.
  const advanceAndPrepare = (warm = true) => {
    if (alive.size === 0) return false;
    const prevIdx = turnIdx;
    let tries = 0;
    do {
      turnIdx = (turnIdx + 1) % order.length;
      tries++;
    } while (!alive.has(order[turnIdx]) && tries <= order.length);
    if (turnIdx <= prevIdx) lap++; // wrapped back to the start of the order
    speller = order[turnIdx];
    round++;
    currentTier = tierForLap(lap);
    // Round 1 uses a pre-synthesized easy word (instant audio, no opening pause),
    // randomized and avoiding a back-to-back repeat across matches.
    if (round === 1 && FIRST_WORDS.length) {
      const choices = FIRST_WORDS.filter((w) => w !== lastFirstWord);
      const pool = choices.length ? choices : FIRST_WORDS;
      word = pool[Math.floor(Math.random() * pool.length)];
      lastFirstWord = word;
      usedWords.add(word);
    } else {
      word = pickFrom(currentTier);
    }
    if (warm) synth(word).catch(() => {}); // warm the cache
    return true;
  };

  // Show the turn (speller appears), then a short beat, then SPEAK the word and
  // start the timer. The speller can type/answer from the instant the turn shows
  // (accepting is true immediately) — typing is never blocked.
  const beginTurn = () => {
    if (phase !== "match") return;
    answered = false;
    accepting = true; // never gate the speller's typing/answer
    keyText = ""; // reset the board for spectator catch-up
    turnTypeStart = 0; // reset the WPM clock for this turn
    prevKeyLen = 0;
    turnMaxLen = 0; // reset the anti-cheat per-word speed trackers
    turnFastWpm = 0;
    tomatoThrowers.clear(); // fresh tomato for everyone this turn
    turnEndsAt = 0;
    turnReveal = null; // no golden-chalk reveal yet this turn
    const turnRound = round;
    const turnWord = word;
    const turnSpeller = speller;
    // Word text is NOT sent during the turn (only length + audio) — harder to cheat.
    broadcast({
      type: "bee_turn",
      spellerId: turnSpeller,
      round: turnRound, // per-turn id (used internally for audio/staleness matching)
      lap, // the displayed "round" — all players spelling once = one lap
      length: turnWord.length,
      tier: currentTier,
      accuracy: matchAccuracy(turnSpeller), // cumulative match accuracy for the stats board
      alive: [...alive],
    });
    // Fire synth NOW so a cache miss overlaps the UI beat instead of stacking
    // after it (usually a cache hit anyway — warmed at start / during the pause).
    const audioP = synth(turnWord).catch(() => null);
    setTimeout(async () => {
      if (phase !== "match" || round !== turnRound) return;
      const audio = await audioP;
      if (phase !== "match" || round !== turnRound) return;
      if (audio)
        broadcast({
          type: "bee_audio",
          round: turnRound,
          wav: audio.wav,
          wavWord: audio.wavWord,
        });
      // Start the round timer as the word begins playing.
      broadcast({ type: "bee_go", round: turnRound, duration: ROUND_MS });
      clearTimeout(timer);
      turnEndsAt = Date.now() + ROUND_MS;
      timer = setTimeout(() => resolveTurn(null), ROUND_MS);
      if (isBot(turnSpeller)) botPlay(turnSpeller, turnRound);
    }, 120);
  };

  const resolveTurn = (text) => {
    if (phase !== "match" || !accepting) return; // ignore until the word has been said
    accepting = false;
    clearTimeout(timer);
    timer = null;
    // Compare letters-only (ignore case, spaces, stray punctuation) so a clean
    // spelling is never marked wrong.
    const correct = (text || "").toLowerCase().replace(/[^a-z]/g, "") === word;
    if (!correct) alive.delete(speller);
    // Anti-cheat: an inhuman per-word typing speed (on a long-enough word) earns a
    // strike; after STRIKES_TO_SPECTATE strikes in a match the player is bumped to
    // spectator. Bots are exempt.
    let demoted = false;
    if (correct && !isBot(speller) && turnMaxLen >= MIN_EVAL_LEN && turnFastWpm >= INHUMAN_WPM) {
      const n = (fastStrikes.get(speller) || 0) + 1;
      fastStrikes.set(speller, n);
      if (n >= STRIKES_TO_SPECTATE && alive.has(speller)) { alive.delete(speller); demoted = true; }
    }
    broadcast({
      type: "bee_turn_result",
      spellerId: speller,
      word,
      correct,
      eliminated: !correct,
      alive: [...alive],
      guess: (typeof text === "string" ? text : keyText) || "", // what they spelled
    });
    // Tell the demoted player they're now spectating (and why).
    if (demoted) sendTo(speller, { type: "bee_forcespectate", reason: "Removed for inhuman typing speed" });
    const multiplayer = order.length >= 2;
    const over = multiplayer ? alive.size <= 1 : alive.size === 0;
    if (over) {
      setTimeout(endMatch, RESULT_MS);
    } else {
      advanceAndPrepare(); // pre-generate the next word during the result pause
      setTimeout(beginTurn, RESULT_MS);
    }
  };

  const endMatch = () => {
    const multiplayer = order.length >= 2;
    const winnerId = multiplayer && alive.size === 1 ? [...alive][0] : null;
    broadcast({ type: "bee_over", winnerId, rounds: round });
    clearTimeout(timer);
    timer = null;
    accepting = false;
    speller = null;
    // After the celebration, drop back to a fresh lobby (NOT fully idle) so the
    // same players can start again and spectators can join.
    setTimeout(returnToLobby, OVER_MS);
  };

  // Reset match state and reopen the lobby, keeping the still-connected human
  // players queued (bots and disconnected players are dropped).
  const returnToLobby = () => {
    bots.clear();
    const connected = new Set(getPlayerIds());
    // Public rooms: everyone still connected (including mid-match spectators)
    // rolls into the next match. Private rooms: just the prior players.
    queue = autoStart ? [...connected] : order.filter((p) => connected.has(p));
    ready = new Set();
    order = [];
    alive = new Set();
    turnIdx = -1;
    round = 0;
    lap = 1;
    accepting = false;
    speller = null;
    word = "";
    keyText = "";
    clearTimeout(timer);
    timer = null;
    clearCountdown();
    phase = queue.length ? "lobby" : "idle";
    if (!queue.includes(hostId)) hostId = queue[0] || null;
    sendLobby();
    maybeAutoStart();
  };

  // A waiting (alive, non-speller) player throws a tomato — it splats over all but
  // the last 2 letters of the speller's word and lasts ~75% of the time left in the
  // turn. One throw per player per turn.
  const throwTomato = (senderId) => {
    if (phase !== "match" || !speller || senderId === speller) return;
    if (!alive.has(senderId)) return; // spectators / eliminated can't throw
    if (tomatoThrowers.has(senderId)) return; // already threw this turn
    tomatoThrowers.add(senderId);
    const remaining = turnEndsAt ? Math.max(0, turnEndsAt - Date.now()) : ROUND_MS;
    const durationMs = Math.round(remaining * 0.75);
    broadcast({ type: "bee_splat", spellerId: speller, by: senderId, round, durationMs });
  };

  // The speller spends their golden chalk to reveal ONE letter of the word. Only
  // the current speller can use it, once per match, while the turn is live. The
  // revealed letter is broadcast (everyone sees it gold on the shared board).
  const useChalk = (senderId, index) => {
    if (phase !== "match" || !speller || senderId !== speller) return; // speller only
    if (!accepting) return; // only during a live turn
    if (chalkUsers.has(senderId)) return; // one per match
    if (typeof index !== "number" || index < 0 || index >= word.length) return;
    chalkUsers.add(senderId);
    turnReveal = { index, letter: word[index] };
    broadcast({ type: "bee_reveal", spellerId: speller, index, letter: word[index], round });
  };

  // Voluntarily stop playing this match (a "spectate" from the menu): drop out
  // like an elimination but stay connected to watch; you rejoin the next match.
  const spectate = (id) => {
    if (phase !== "match" || !alive.has(id)) return;
    if (id === speller) {
      accepting = true; // force-resolve their open turn as a miss
      resolveTurn(null);
      return;
    }
    alive.delete(id);
    const multiplayer = order.length >= 2;
    if ((multiplayer && alive.size <= 1) || alive.size === 0) {
      clearTimeout(timer);
      endMatch();
    }
  };

  return {
    handle(id, m) {
      switch (m.type) {
        case "bee_join":
          join(id);
          break;
        case "bee_leave":
          leave(id);
          break;
        case "bee_ready":
          if (m.ready) ready.add(id);
          else ready.delete(id);
          sendLobby();
          break;
        case "bee_settings":
          if (phase === "lobby" && id === hostId) {
            if (typeof m.mode === "string") settings.mode = m.mode;
            if (Number.isFinite(m.maxPlayers)) settings.maxPlayers = Math.max(2, Math.min(12, Math.floor(m.maxPlayers)));
            sendLobby();
          }
          break;
        case "bee_begin":
          startMatch(id, m.mode);
          break;
        case "bee_addbots":
          addBots(m.n || 4);
          break;
        case "bee_removebot":
          removeBot();
          break;
        case "bee_endmatch":
          // Host aborts the match early — everyone goes straight back to the
          // lobby (no game-over screen, no winner).
          if (phase === "match" && id === hostId) returnToLobby();
          break;
        case "bee_claimhost":
          // Any player in the lobby can take over as host.
          if (phase === "lobby" && queue.includes(id)) {
            hostId = id;
            sendLobby();
          }
          break;
        case "bee_key":
          if (phase === "match" && id === speller) {
            keyText = String(m.text || "").slice(0, 40); // positional display ("_" for empty/gold)
            const n = typeof m.n === "number" ? m.n : keyText.replace(/[^a-z*]/gi, "").length;
            const s = recordKey(speller, n);
            broadcast({ type: "bee_key", spellerId: speller, text: keyText, wpm: s.wpm, accuracy: s.accuracy });
          }
          break;
        case "bee_look": {
          // Gaze sync: relay where this player is looking so their avatar's head
          // tracks it on other clients (client-throttled; clamped here).
          const yaw = Math.max(-1.6, Math.min(1.6, Number(m.yaw) || 0));
          const pitch = Math.max(-0.9, Math.min(0.9, Number(m.pitch) || 0));
          broadcast({ type: "bee_look", id, yaw, pitch });
          break;
        }
        case "bee_emote": {
          // Desk emote: relay a player-triggered one-shot animation to everyone
          // (sender ignores its own echo). Allow-list + light rate limit.
          if (!EMOTES.has(m.emote)) break;
          const now = Date.now();
          if (now - (emoteAt.get(id) || 0) < 350) break;
          emoteAt.set(id, now);
          broadcast({ type: "bee_emote", id, emote: m.emote });
          break;
        }
        case "bee_answer":
          if (phase === "match" && id === speller && accepting && !answered) {
            answered = true;
            resolveTurn(m.text);
          }
          break;
        case "bee_tomato":
          throwTomato(id);
          break;
        case "bee_chalk":
          useChalk(id, m.index);
          break;
        case "bee_spectate":
          spectate(id);
          break;
        case "bee_sync":
          if (phase === "match") sendSpectatorState(id);
          else sendTo(id, lobbyState());
          break;
      }
    },
    removePlayer(id) {
      if (phase === "lobby") {
        leave(id);
      } else if (phase === "match" && alive.has(id)) {
        if (id === speller) {
          accepting = true; // force-resolve even if the word wasn't said yet
          resolveTurn(null); // current speller bailed → counts as a miss
        } else {
          alive.delete(id);
          const multiplayer = order.length >= 2;
          if ((multiplayer && alive.size <= 1) || alive.size === 0) {
            clearTimeout(timer);
            endMatch();
          }
        }
      }
    },
  };
}
