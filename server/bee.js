// Spelling Bee — lobby + turn-based elimination (server-authoritative).
// A host opens a lobby; players join/ready; host starts. Each turn the next
// queued player must spell a narrated word while everyone watches; a miss
// eliminates them; last speller standing wins (solo = survival).
import {
  english10, english20, english35, english40, english50, english55, english60,
  american10, american20, american35, american40, american50, american55, american60,
} from "wordlist-js";
import { synth } from "./tts.js";

const ROUND_MS = 22000;
const RESULT_MS = 2200; // pause between turns: ~500ms linger + char-by-char board erase, then next round
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
const EXCLUDE = new Set([...HOMOPHONES, ...SWEARS]);

function buildPool(lists, min = 4, max = 10) {
  const set = new Set();
  for (const list of lists) {
    for (const w of list)
      if (w.length >= min && w.length <= max && /^[a-z]+$/.test(w) && !EXCLUDE.has(w)) set.add(w);
  }
  return [...set];
}

// wordlist-js sizes are frequency BANDS (deltas). Rarer band = harder; and since
// nothing rarer than band 60 ships, very-hard/impossible escalate by LENGTH too
// (long uncommon words are the toughest to spell).
const hardBands = [english50, english55, english60, american50, american55, american60];
const POOLS = {
  easy: buildPool([english10, english20, english35, american10, american20, american35], 4, 8),
  medium: buildPool([english40, english50, american40, american50], 4, 9),
  hard: buildPool([english55, english60, american55, american60], 5, 11),
  veryhard: buildPool(hardBands, 9, 12),
  impossible: buildPool(hardBands, 12, 20),
};

// Difficulty ramps by LAP (each alive player having spelled once). The easy
// phase is kept to roughly a constant number of TURNS regardless of player count
// (a lap = one turn per player), so a big match doesn't sit on easy words for
// dozens of turns; later tiers each advance one lap.
const tierForLap = (lap, players) => {
  const easyLaps = Math.max(1, Math.round(7 / Math.max(1, players)));
  if (lap <= easyLaps) return "easy";
  if (lap <= easyLaps + 1) return "medium";
  if (lap <= easyLaps + 2) return "hard";
  if (lap <= easyLaps + 3) return "veryhard";
  return "impossible";
};

export function createBee(broadcast, sendTo, getPlayerIds) {
  let phase = "idle"; // idle | lobby | match
  let hostId = null;
  let queue = []; // join order
  let ready = new Set();
  let keyText = ""; // current speller's typed text (for catching spectators up)

  // ---- per-player typing stats (for the secondary stats board) ----
  const playerStats = new Map(); // id -> { letters, corrections } (this match)
  let turnTypeStart = 0; // ms timestamp of the first keystroke this turn (for WPM)
  let prevKeyLen = 0; // previous keyText length this turn (to detect backspaces)

  const matchAccuracy = (id) => {
    const st = playerStats.get(id);
    if (!st || st.letters === 0) return 100;
    return Math.max(0, Math.min(100, Math.round(((st.letters - st.corrections) / st.letters) * 100)));
  };
  // Record a keystroke update for `id`, returning live { wpm, accuracy }.
  const recordKey = (id, text) => {
    const len = text.length;
    if (turnTypeStart === 0 && len > 0) turnTypeStart = Date.now();
    const delta = len - prevKeyLen;
    prevKeyLen = len;
    let st = playerStats.get(id);
    if (!st) playerStats.set(id, (st = { letters: 0, corrections: 0 }));
    if (delta > 0) st.letters += delta;
    else if (delta < 0) st.corrections += -delta; // a backspace = a correction = a typo
    const mins = turnTypeStart ? (Date.now() - turnTypeStart) / 60000 : 0;
    const wpm = mins > 0 ? Math.round(len / 5 / mins) : 0;
    return { wpm, accuracy: matchAccuracy(id) };
  };

  const bots = new Set(); // dev-only AI players
  const isBot = (id) => bots.has(id);
  const BOT_NAMES = ["Ada", "Bo", "Cy", "Dot", "Eve", "Fox"];

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

  const lobbyState = () => ({
    type: "bee_lobby",
    phase,
    hostId,
    queue: [...queue],
    ready: [...ready],
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

  // Pre-synthesize several easy words at startup so the FIRST word of every match
  // has instant audio (Kokoro's first cold synth otherwise blocks ~1-2s with no
  // prior pause to hide it). Round 1 draws from here (randomized, avoiding a
  // back-to-back repeat) when available.
  const FIRST_WORDS = [];
  let lastFirstWord = null;
  const prewarmFirstWords = () => {
    const easy = POOLS.easy;
    const picks = [];
    while (picks.length < 12 && picks.length < easy.length) {
      const w = easy[Math.floor(Math.random() * easy.length)];
      if (!picks.includes(w)) picks.push(w);
    }
    let i = 0;
    const next = () => {
      if (i >= picks.length) return;
      if (phase === "match") return void setTimeout(next, 1500); // never block an active match
      const w = picks[i++];
      synth(w)
        .then(() => FIRST_WORDS.push(w))
        .catch(() => {})
        .finally(() => setTimeout(next, 200));
    };
    next();
  };
  setTimeout(prewarmFirstWords, 3000); // let the model warm (see tts.js) first

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
    }
  };

  const join = (id) => {
    if (phase === "match") {
      sendSpectatorState(id); // spectate; can't join mid-match
      return;
    }
    if (phase === "idle") {
      phase = "lobby";
      hostId = id;
    }
    if (!queue.includes(id)) queue.push(id);
    sendLobby();
  };

  const leave = (id) => {
    queue = queue.filter((q) => q !== id);
    ready.delete(id);
    if (id === hostId) hostId = queue[0] || null;
    if (queue.length === 0) reset();
    sendLobby();
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

  const startMatch = (id, requestedMode) => {
    if (phase !== "lobby" || id !== hostId || queue.length < 1) return;
    order = [...queue];
    mode = requestedMode || "basic";
    alive = new Set(order);
    turnIdx = -1;
    round = 0;
    lap = 1;
    usedWords.clear(); // no repeated words within a match
    playerStats.clear(); // reset per-player accuracy for the new match
    phase = "match";
    broadcast({ type: "bee_match_start", order: [...order], mode });
    // Short prep pause before round 1, then begin. Don't pre-synth here (it would
    // block the event loop and delay the opening turn) — beginTurn synthesizes
    // after broadcasting bee_turn, so the speller appears immediately.
    if (advanceAndPrepare(false)) setTimeout(beginTurn, 600);
    else endMatch();
  };

  // Advance to the next alive speller, pick their word, and PRE-GENERATE its
  // audio (so it's cached/instant when the turn plays). Returns false if no one
  // is left. Run this at the START of the result pause to hide synth latency.
  // `warm` pre-generates the word's audio so it's cached when the turn plays.
  // Kokoro inference blocks the event loop, so we only warm during the between-
  // turn result pause (where the latency is hidden) — NOT on the match-start path,
  // where it would delay the opening turn from even appearing.
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
    currentTier = tierForLap(lap, order.length);
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
    const turnRound = round;
    const turnWord = word;
    const turnSpeller = speller;
    // Word text is NOT sent during the turn (only length + audio) — harder to cheat.
    broadcast({
      type: "bee_turn",
      spellerId: turnSpeller,
      round: turnRound,
      length: turnWord.length,
      tier: currentTier,
      accuracy: matchAccuracy(turnSpeller), // cumulative match accuracy for the stats board
      alive: [...alive],
    });
    setTimeout(async () => {
      if (phase !== "match" || round !== turnRound) return;
      let audio = null;
      try {
        audio = await synth(turnWord);
      } catch {
        /* fall through silently */
      }
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
      timer = setTimeout(() => resolveTurn(null), ROUND_MS);
      if (isBot(turnSpeller)) botPlay(turnSpeller, turnRound);
    }, 250);
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
    broadcast({
      type: "bee_turn_result",
      spellerId: speller,
      word,
      correct,
      eliminated: !correct,
      alive: [...alive],
    });
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
    queue = order.filter((p) => connected.has(p));
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
    phase = queue.length ? "lobby" : "idle";
    if (!queue.includes(hostId)) hostId = queue[0] || null;
    sendLobby();
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
        case "bee_begin":
          startMatch(id, m.mode);
          break;
        case "bee_addbots":
          addBots(m.n || 4);
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
            keyText = String(m.text || "").slice(0, 40);
            const s = recordKey(speller, keyText);
            broadcast({ type: "bee_key", spellerId: speller, text: keyText, wpm: s.wpm, accuracy: s.accuracy });
          }
          break;
        case "bee_answer":
          if (phase === "match" && id === speller && accepting && !answered) {
            answered = true;
            resolveTurn(m.text);
          }
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
