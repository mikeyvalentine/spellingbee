// Cloudflare Worker entry — the HTTP half of server/index.js.
//   /healthz             -> liveness
//   /api/token           -> Discord OAuth code->token exchange (uses secrets)
//   /api/voice-preview   -> debug TTS preview
//   /ws                  -> forwarded to the BeeRoom Durable Object (one global room)
//   everything else      -> the built client from dist/ (ASSETS binding)
//
// run_worker_first = true (wrangler.toml) means this Worker sees every request;
// non-API paths fall through to env.ASSETS.fetch(), which serves dist/ and does
// the SPA index.html fallback.
import { configureTts, previewMp3, setVoice, getTtsChars } from "../server/tts.js";

export { BeeRoom } from "./room.js";
export { Matchmaker } from "./matchmaker.js";

const mm = (env) => env.MATCHMAKER.get(env.MATCHMAKER.idFromName("global"));

// Flush this (worker) isolate's new TTS chars — e.g. from the voice preview — to
// the global counter so debug previews are counted too.
let lastWorkerTts = 0;
function flushWorkerTts(env) {
  const total = getTtsChars();
  const delta = total - lastWorkerTts;
  if (delta <= 0) return;
  lastWorkerTts = total;
  mm(env).fetch(new Request("https://mm/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chars: delta }),
  })).catch(() => {});
}

// Keep room names bounded + predictable (idFromName accepts anything, but we
// don't want unbounded/garbage keys). Falls back to one shared default room.
function sanitizeRoom(raw) {
  const s = (raw || "").slice(0, 80).replace(/[^a-zA-Z0-9:_-]/g, "");
  return s || "global";
}

async function handleToken(request, env) {
  try {
    const { code } = await request.json();
    const r = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("Token exchange failed:", data);
      return Response.json({ error: "token_exchange_failed" }, { status: 500 });
    }
    return Response.json({ access_token: data.access_token });
  } catch (err) {
    console.error(err);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}

async function handleVoicePreview(url, env) {
  const voice = String(url.searchParams.get("voice") || "");
  if (!voice) return new Response("missing voice", { status: 400 });
  configureTts({ apiKey: env.GOOGLE_TTS_API_KEY, rate: env.GOOGLE_TTS_RATE });
  try {
    const b64 = await previewMp3("Your word is, lagoon.", voice);
    flushWorkerTts(env); // count preview chars toward usage
    if (url.searchParams.get("set") === "1") setVoice(voice);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new Response(bytes, { headers: { "Content-Type": "audio/mpeg" } });
  } catch (e) {
    return new Response(String(e.message || e), { status: 500 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/healthz") return new Response("ok");
    if (p === "/api/token" && request.method === "POST") return handleToken(request, env);
    if (p === "/api/voice-preview") return handleVoicePreview(url, env);

    // Public matchmaking: quick-match / create return a room id; list = browser.
    if (p === "/api/mm/quick") return mm(env).fetch(new Request("https://mm/quick"));
    if (p === "/api/mm/create") return mm(env).fetch(new Request("https://mm/create"));
    if (p === "/api/mm/list") return mm(env).fetch(new Request("https://mm/list"));
    if (p === "/api/tts-usage") return mm(env).fetch(new Request("https://mm/usage"));

    if (p === "/ws") {
      // Route to the requested room: `call:<instanceId>` (private per Discord
      // call), `pub:<id>` (public matchmaking), or a default. The DO reads the
      // same ?room= from the request URL for its own identity.
      const room = sanitizeRoom(url.searchParams.get("room"));
      const id = env.BEE_ROOM.idFromName(room);
      return env.BEE_ROOM.get(id).fetch(request);
    }

    // Static client (dist/) + SPA fallback.
    return env.ASSETS.fetch(request);
  },
};
