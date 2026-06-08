# Running Spelling Bee as a Discord Activity

Registering the app, serving it over HTTPS, and launching it inside a Discord
voice channel. Steps marked **(you)** need your account/secrets; the rest is coded.

> Unlike a plain web page, the game logic + TTS live on the Node server (:3001),
> and the client reaches it over WebSocket. In Discord that socket rides the same
> tunnel as the client (via Discord's `/.proxy/ws`), so you only tunnel one port.

---

## 1. Create the Discord application **(you)**

1. <https://discord.com/developers/applications> → **New Application**, name it.
2. **General Information** → copy the **Application ID** (this is your Client ID).
3. **OAuth2** → **Client Secret** → **Reset Secret** → copy it (shown once).

## 2. Enable Activities + URL mapping **(you)**

1. Left sidebar → **Activities** (a.k.a. "Embedded App SDK") → **Enable Activities**.
2. **URL Mappings** → add a root mapping:
   - **Prefix:** `/`
   - **Target:** your public HTTPS host *without* the protocol, e.g.
     `your-subdomain.trycloudflare.com` (you get this in step 5 — come back and fill it in).
3. Save changes. (One root mapping covers the app, `/assets`, `/api`, and `/ws`.)

## 3. Configure local env

Copy `.env.example` to `.env` and fill in:

```
VITE_DISCORD_CLIENT_ID=<Application ID from 1.2>
DISCORD_CLIENT_ID=<same Application ID>
DISCORD_CLIENT_SECRET=<Client Secret from 1.3>
PORT=3001
# Leave empty — inside Discord the client auto-uses wss://<host>/.proxy/ws.
VITE_WS_URL=
```

## 4. Start the servers

Two terminals from the project root:

```bash
npm run server   # game logic + Kokoro TTS + token exchange on :3001
npm run dev      # client on :5173 (proxies /api and /ws to :3001)
```

First server start downloads the TTS model (~once). Wait until it's warm before
launching a match.

## 5. Expose the client over HTTPS

Discord loads the Activity in an iframe and **requires HTTPS** (no `localhost`).
Tunnel the **Vite** port (5173) — it proxies `/api` and `/ws` to :3001, so one
tunnel serves everything:

```bash
cloudflared tunnel --url http://localhost:5173    # no account needed
# …or: ngrok http 5173
```

Copy the printed HTTPS URL (e.g. `https://abc-123.trycloudflare.com`) and put its
**host** into the URL Mapping from step 2.2. Save in the portal.

## 6. Install the app to your test server **(you)**

1. Developer Portal → **Installation** → copy the **Install Link** (needs the
   `applications.commands` scope), or build an OAuth2 install URL.
2. Open it, pick the server with your voice channel, authorize (needs **Manage
   Server** on that server).

## 7. Allow your testers **(you)**

While unverified, only you + allow-listed testers see the Activity:
Developer Portal → your app → **App Testers** (add their usernames) or add them to
your **Team**.

## 8. Launch it

1. In the **Discord desktop app**, join a voice channel in that server.
2. Click the **Activity shelf** (rocket icon) in the voice panel.
3. Your app appears under your/dev apps → launch it. Everyone who launches it
   lands in the same lobby; others can spectate mid-match and join when it ends.
4. Devtools in the Activity window: focus Discord, **Ctrl+Shift+I** (or right-click
   → Inspect). Watch the console for SDK/auth errors on first launch.

---

## Troubleshooting

- **Blank iframe / won't load** → wrong URL-mapping host or the tunnel died.
  Confirm the HTTPS tunnel URL opens in a normal browser tab first.
- **Auth error after launch** → `VITE_DISCORD_CLIENT_ID` mismatch, or the token
  server isn't running / `DISCORD_CLIENT_SECRET` wrong. Check the `npm run server`
  terminal for the token-exchange error.
- **Lobby loads but no game / no audio** → the WebSocket isn't reaching :3001.
  Make sure `npm run server` is running and the root URL mapping is correct
  (the client uses `/.proxy/ws` in Discord, which routes through your tunnel).
- **Only you show up** → testers aren't allow-listed (step 7), or they haven't
  actually opened the Activity (being in the call isn't enough).
- **External requests blocked (CSP)** → any non-Discord URL the client calls must
  be added as a URL Mapping; Discord routes them through `/.proxy/...`.
