// Google Cloud Text-to-Speech. A simple REST call per phrase — no local model,
// no event-loop blocking, clean audio (so no silence-slicing needed).
//
// Returns { wav, ms, wavWord }, matching the previous interface so the client +
// game logic are unchanged:
//   wav     — base64 MP3 of the carrier phrase "Your word is, X." (played once)
//   wavWord — base64 MP3 of just the word "X." (banked for the Replay button)
//   ms      — unused (kept for compatibility)
//
// Requires GOOGLE_TTS_API_KEY in .env, with the Cloud Text-to-Speech API enabled.
import "dotenv/config";

const cache = new Map(); // word -> { wav, ms, wavWord }

const LANG = "en-US";
const RATE = Number(process.env.GOOGLE_TTS_RATE || 0.9); // a touch slow for clarity
let currentVoice = process.env.GOOGLE_TTS_VOICE || "en-US-Neural2-F";

export const getVoice = () => currentVoice;
// Switch the active voice at runtime (used by the debug voice picker). Clears the
// cache so already-synthesized words re-render in the new voice.
export const setVoice = (v) => {
  if (v && v !== currentVoice) {
    currentVoice = v;
    cache.clear();
  }
};

async function gtts(text, voice = currentVoice) {
  const key = process.env.GOOGLE_TTS_API_KEY;
  if (!key) throw new Error("GOOGLE_TTS_API_KEY is not set");
  const lang = voice.split("-").slice(0, 2).join("-") || LANG; // e.g. en-GB-Neural2-A -> en-GB
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`,
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
  const data = await res.json();
  if (!data.audioContent) throw new Error("Google TTS: empty audioContent");
  return data.audioContent; // base64 MP3
}

export async function synth(word) {
  if (cache.has(word)) return cache.get(word);
  try {
    const [wav, wavWord] = await Promise.all([
      gtts(`Your word is, ${word}.`),
      gtts(`${word}.`),
    ]);
    const out = { wav, ms: 0, wavWord };
    cache.set(word, out);
    return out;
  } catch (e) {
    console.error("[tts] synth failed:", e.message);
    throw e;
  }
}

// Base64 MP3 of a sample phrase in a specific voice (for the debug preview).
export const previewMp3 = (text, voice) => gtts(text, voice);
