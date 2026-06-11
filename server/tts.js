// Google Cloud Text-to-Speech. A simple REST call per phrase — no local model,
// no event-loop blocking, clean audio (so no silence-slicing needed).
//
// Returns { wav, ms, wavWord }, matching the previous interface so the client +
// game logic are unchanged:
//   wav     — base64 MP3 of the carrier phrase "Your word is, X." (played once)
//   wavWord — base64 MP3 of just the word "X." (banked for the Replay button)
//   ms      — unused (kept for compatibility)
//
// Requires a Google TTS API key with the Cloud Text-to-Speech API enabled.
// Node reads it from process.env (loaded via dotenv in server/index.js); the
// Cloudflare Worker has no process.env, so it calls configureTts() with its
// bindings instead. We read whatever process.env exists at load, then let
// configureTts() override.
const ENV = (typeof process !== "undefined" && process.env) || {};

const cache = new Map(); // word -> { wav, ms, wavWord }

const LANG = "en-US";
let RATE = Number(ENV.GOOGLE_TTS_RATE || 0.9); // a touch slow for clarity
let currentVoice = ENV.GOOGLE_TTS_VOICE || "en-US-Neural2-J";
let apiKey = ENV.GOOGLE_TTS_API_KEY || "";

// ElevenLabs — the active game voice once its key is configured (see activeProvider).
let elevenKey = ENV.ELEVENLABS_API_KEY || "";
let elevenVoiceId = ENV.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // "Rachel" — clear default
let elevenModel = ENV.ELEVENLABS_MODEL || "eleven_multilingual_v2"; // or eleven_flash_v2_5 (faster/cheaper)
// Playback speed (0.7 slowest … 1.2 fastest; 1.0 = normal). Pinned at the API's
// floor — spellers want every syllable. Tunable via ELEVENLABS_SPEED.
let elevenSpeed = ENV.ELEVENLABS_SPEED != null && ENV.ELEVENLABS_SPEED !== "" ? Number(ENV.ELEVENLABS_SPEED) : 0.7;
// Up to 3 "<id>:<version>" pronunciation-dictionary locators to hard-fix words the
// model mangles (comma-separated; version optional). e.g. "abc123,def456:7".
let elevenPronos = ENV.ELEVENLABS_PRONO_DICTS || "";

// Optional explicit provider override ("google" | "elevenlabs" | "qwen"). When
// unset, ElevenLabs wins if its key is present, else Google. So configuring the
// key is all it takes to "switch to ElevenLabs".
let providerOverride = (ENV.TTS_PROVIDER || "").toLowerCase();
const activeProvider = () => providerOverride || (elevenKey ? "elevenlabs" : "google");

// Qwen3-TTS (Apache-2.0) via fal.ai, used only for the debug A/B voice preview so
// its rare-word pronunciation can be judged against the others.
let falKey = ENV.FAL_KEY || "";
let qwenVoice = ENV.QWEN_TTS_VOICE || "Ryan"; // an American-English male voice
const QWEN_MODEL = ENV.QWEN_TTS_MODEL || "fal-ai/qwen-3-tts/text-to-speech/1.7b";

// Set credentials/voice/rate at runtime (used by the Cloudflare Worker, which
// passes its env bindings). Safe to call multiple times. Clears the audio cache
// when anything affecting the rendered audio changes.
export const configureTts = ({ apiKey: k, voice, rate, falKey: fk, qwenVoice: qv,
  elevenKey: ek, elevenVoiceId: ev, elevenModel: em, elevenSpeed: es, elevenPronos: ep, provider } = {}) => {
  if (k) apiKey = k;
  if (voice) currentVoice = voice;
  if (rate != null && rate !== "") RATE = Number(rate);
  if (fk) falKey = fk;
  if (qv) qwenVoice = qv;
  if (ek && ek !== elevenKey) { elevenKey = ek; cache.clear(); }
  if (ev && ev !== elevenVoiceId) { elevenVoiceId = ev; cache.clear(); }
  if (em && em !== elevenModel) { elevenModel = em; cache.clear(); }
  if (es != null && es !== "" && Number(es) !== elevenSpeed) { elevenSpeed = Number(es); cache.clear(); }
  if (ep != null && ep !== elevenPronos) { elevenPronos = ep; cache.clear(); }
  if (provider != null && provider !== "") providerOverride = String(provider).toLowerCase();
};

// base64 of an ArrayBuffer, working in both Node (Buffer) and the Worker (btoa).
function toB64(buf) {
  const bytes = new Uint8Array(buf);
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export const getVoice = () => currentVoice;
// Switch the active voice at runtime (used by the debug voice picker). Clears the
// cache so already-synthesized words re-render in the new voice.
export const setVoice = (v) => {
  if (v && v !== currentVoice) {
    currentVoice = v;
    cache.clear();
  }
};

// Running tally of input characters sent to Google (≈ what they bill), per
// isolate. The DO/worker flush the delta to the Matchmaker for a global total.
let ttsChars = 0;
export const getTtsChars = () => ttsChars;

async function gtts(text, voice = currentVoice) {
  if (!apiKey) throw new Error("GOOGLE_TTS_API_KEY is not set");
  const lang = voice.split("-").slice(0, 2).join("-") || LANG; // e.g. en-GB-Neural2-A -> en-GB
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: lang, name: voice },
        audioConfig: { audioEncoding: "MP3", speakingRate: RATE },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Google TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  ttsChars += text.length; // billed on a successful synthesize
  const data = await res.json();
  if (!data.audioContent) throw new Error("Google TTS: empty audioContent");
  return data.audioContent; // base64 MP3
}

// ElevenLabs TTS. Returns base64 MP3, same shape as gtts(). Pronunciation
// dictionaries (if configured) are applied in order to hard-fix mangled words.
async function eltts(text, voiceId = elevenVoiceId) {
  if (!elevenKey) throw new Error("ELEVENLABS_API_KEY is not set");
  const body = {
    text,
    model_id: elevenModel,
    voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: Math.max(0.7, Math.min(1.2, elevenSpeed)) },
  };
  const locators = elevenPronos
    .split(",").map((s) => s.trim()).filter(Boolean)
    .slice(0, 3)
    .map((s) => {
      const [id, version_id] = s.split(":");
      return version_id ? { pronunciation_dictionary_id: id, version_id } : { pronunciation_dictionary_id: id };
    });
  if (locators.length) body.pronunciation_dictionary_locators = locators;
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": elevenKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return toB64(await res.arrayBuffer()); // base64 MP3
}

// Synthesize one phrase with the active provider; returns base64 MP3. A failing
// non-Google provider falls back to Google — a worse voice beats a silent word
// (e.g. ElevenLabs blocks free-tier API calls from datacenter IPs, so it can
// work in local dev yet fail from the deployed Worker).
async function speak(text) {
  const provider = activeProvider();
  try {
    switch (provider) {
      case "elevenlabs": return await eltts(text);
      case "qwen": return (await qtts(text)).b64;
      default: return await gtts(text);
    }
  } catch (e) {
    if (provider === "google") throw e;
    console.error(`[tts] ${provider} failed (${e.message}); falling back to Google`);
    return gtts(text);
  }
}

export function synth(word) {
  // The PROMISE (not the result) is cached, so concurrent calls for the same
  // word share one in-flight synthesis. beginTurn fires ~200ms after the
  // match-start prewarm — caching only the finished result let the first word
  // synthesize TWICE (4 concurrent requests trips ElevenLabs' free-tier
  // concurrency limit → 401 → the Google fallback voice on word one).
  if (cache.has(word)) return cache.get(word);
  const p = (async () => {
    const [wav, wavWord] = await Promise.all([
      speak(`Your word is, ${word}.`),
      speak(`${word}.`),
    ]);
    return { wav, ms: 0, wavWord };
  })();
  cache.set(word, p);
  p.catch((e) => {
    console.error("[tts] synth failed:", e.message);
    cache.delete(word); // don't cache failures — retry fresh next time
  });
  return p;
}

// Qwen3-TTS via fal.ai's synchronous endpoint. Returns base64 of the (MP3) audio.
// fal returns a JSON pointer to the rendered file, which we fetch + inline so the
// caller gets the same base64 shape as gtts().
async function qtts(text, voice = qwenVoice) {
  if (!falKey) throw new Error("FAL_KEY is not set");
  const res = await fetch(`https://fal.run/${QWEN_MODEL}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Key ${falKey}` },
    body: JSON.stringify({ text, voice, language: "English" }),
  });
  if (!res.ok) throw new Error(`Qwen TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const audioUrl = data?.audio?.url;
  if (!audioUrl) throw new Error("Qwen TTS: no audio url in response");
  const a = await fetch(audioUrl);
  if (!a.ok) throw new Error(`Qwen audio fetch ${a.status}`);
  return { b64: toB64(await a.arrayBuffer()), mime: data.audio.content_type || "audio/mpeg" };
}

// Debug A/B preview: synthesize `text` with a chosen provider. Returns { b64, mime }.
export async function previewAudio(text, { provider = "google", voice } = {}) {
  if (provider === "qwen") return qtts(text, voice);
  if (provider === "elevenlabs") return { b64: await eltts(text, voice || elevenVoiceId), mime: "audio/mpeg" };
  return { b64: await gtts(text, voice || currentVoice), mime: "audio/mpeg" };
}

// Base64 MP3 of a sample phrase in a specific (Google) voice — back-compat helper.
export const previewMp3 = (text, voice) => gtts(text, voice);
