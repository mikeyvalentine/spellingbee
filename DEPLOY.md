# Deploying Spelling Bee

The app is **one Node process** that serves everything on a single port: the
built client (`dist/`), the `/api/token` exchange, the `/api/voice-preview`
debug route, and the `/ws` WebSocket game relay. Discord's URL mapping points at
that one host; in dev, Vite serves the client and proxies `/api` + `/ws` to the
Node server instead.

---

## Primary: Cloudflare Workers + Durable Objects (free, always-on)

The Worker (`worker/index.js`) serves the built client + the `/api` routes; a
Durable Object (`BeeRoom`, `worker/room.js`) holds the WebSocket connections and
runs the game (`server/bee.js`, unchanged). Free tier covers a small game — no
laptop, permanent URL.

### One-time setup
1. Log in (opens a browser to your Cloudflare account):
   ```
   npx wrangler login
   ```
2. Set the two secrets (prompted for each value):
   ```
   npx wrangler secret put DISCORD_CLIENT_SECRET
   npx wrangler secret put GOOGLE_TTS_API_KEY
   ```
   Non-secret config (`DISCORD_CLIENT_ID`, `GOOGLE_TTS_VOICE`, `GOOGLE_TTS_RATE`)
   lives in `wrangler.toml` `[vars]` — edit there if it changes.
3. Deploy (builds the client, then uploads Worker + assets + the Durable Object):
   ```
   npm run cf:deploy
   ```
   Wrangler prints your URL: `https://spelling-bee.<your-subdomain>.workers.dev`.
4. Discord Dev Portal → **Activities → URL Mappings** → set `/` to that host
   (no `https://`). Permanent.

> The client is built with `VITE_DISCORD_CLIENT_ID` from your local `.env` at
> `cf:deploy` time, so keep `.env` present when you deploy. Custom domain later:
> Cloudflare dashboard → Workers → your worker → **Triggers → Custom Domains**.

### Local dev against the real Worker runtime
```
npm run build      # produce dist/ for the ASSETS binding
npm run cf:dev     # http://127.0.0.1:8787 (miniflare simulates the DO + assets)
```
Local secrets live in `.dev.vars` (gitignored). The lighter Node loop
(`npm run server` + `npm run dev`) still works for quick iteration.

### Redeploy
Just `npm run cf:deploy` again (or wire the GitHub repo to Cloudflare for
push-to-deploy, setting the same vars/secrets + `VITE_DISCORD_CLIENT_ID` as a
build variable in the dashboard).

---

## Alternative: Railway (~$5/mo, no rewrite)

Railway runs the Node server 24/7 with a permanent HTTPS URL — no tunnel, no
laptop dependency.

### One-time setup
1. <https://railway.app> → **New Project** → **Deploy from GitHub repo** →
   pick `mikeyvalentine/spellingbee`.
2. Railway reads `railway.json`:
   - **Build:** `npm run build`  (→ `dist/`)
   - **Start:** `npm run start`  (`node server/index.js`, serves `dist/`)
   - **Health check:** `/healthz`
3. **Variables** (Settings → Variables) — add these:
   | Key | Value |
   |-----|-------|
   | `DISCORD_CLIENT_ID` | your Application ID |
   | `DISCORD_CLIENT_SECRET` | your Client Secret |
   | `VITE_DISCORD_CLIENT_ID` | same Application ID *(needed at **build** time — baked into the client)* |
   | `GOOGLE_TTS_API_KEY` | your Google Cloud TTS key |
   | `GOOGLE_TTS_VOICE` | *(optional)* e.g. `en-US-Neural2-F` |
   | `GOOGLE_TTS_RATE` | *(optional)* e.g. `0.9` |

   Do **not** set `PORT` — Railway injects it (the server already reads
   `process.env.PORT`). Leave `VITE_WS_URL` unset (the client auto-uses
   `/.proxy/ws` inside Discord).
4. **Settings → Networking → Generate Domain** → copy the
   `*.up.railway.app` URL.
5. Discord Dev Portal → your app → **Activities → URL Mappings** → set `/` to
   that host (no `https://`). Permanent — only redo this if you attach your own
   custom domain later.

### Deploys
Every push to `main` redeploys automatically. To verify a deploy by hand, open
`https://<your-app>.up.railway.app/healthz` → should print `ok`.

> Custom domain later: Railway → Settings → Networking → **Custom Domain**, add
> your domain + the CNAME it shows, then update the Discord URL mapping to it.

---

## For local testing / posterity: Cloudflare quick tunnel

No account, but the URL **rotates every run**, so you must re-paste the printed
host into the Discord URL mapping each time. Two terminals:

```
npm run server                 # Node game server on :3001
npm run dev                    # Vite client on :5173 (proxies /api + /ws)
run-cloudflare.cmd             # prints https://<random>.trycloudflare.com
```

(`run-cloudflare.cmd` just calls `cloudflared tunnel --url http://localhost:5173`.)

## Alternative tunnel: ngrok static domain

Free tier gives one permanent `*.ngrok-free.app` domain, but injects a browser
interstitial on top-level loads that can block the Discord iframe — see
`run-ngrok.cmd` for the wiring. Generally prefer Railway over this.
