# 🐝 Spelling Bee — Discord Activity

A multiplayer spelling-bee Discord Activity. Players join a 2D lobby, then a match
plays out inside a 3D classroom (`classroom.glb`): one speller at a time is
narrated a word by a neural TTS voice, types it against a timer, and their live
keystrokes appear on the classroom chalkboard for everyone to watch. Miss your
word and you're out — last speller standing wins.

This is a rebuild of an earlier prototype (`../DiscordRoom`), reusing its
server-authoritative game logic and TTS, with a new classroom-based match view.

## Running locally (mock mode — no Discord needed)

Two processes (the Worker runtime is the full backend — per-call rooms + public
matchmaking + Durable Objects + Google TTS):

```bash
npm install
npm run cf:dev   # Worker backend (Durable Objects) on :8788
npm run dev      # Vite client on :5173 (proxies /api + /ws to :8788)
```

Open http://localhost:5173. You land in the lobby as the host. Use **+ Add bots**
to fill the room, then **Start match**, or **🌐 Play public** to quick-match /
browse public rooms. Bots spell automatically (~60% accuracy) so you can watch the
full loop solo.

> Simpler single-room backend: `npm run server` (Node, :3001) then
> `VITE_DEV_BACKEND=http://localhost:3001 npm run dev`. It lacks rooms/matchmaking;
> deploys (Cloudflare/Railway) are unaffected.

## Running inside Discord

Copy `.env.example` → `.env`, fill in your Discord application's Client ID +
Secret, and point your Activity URL mapping at the Vite dev server (via a tunnel
such as cloudflared). See the old project's `SETUP.md` for the full Discord
Developer Portal walkthrough — the OAuth flow is unchanged.

## Architecture

```
server/
  index.js     Express token-exchange + WebSocket relay; assigns each player a character model
  bee.js       Server-authoritative game: lobby, round-robin turns, lap-based difficulty ramp, bots
  tts.js       Kokoro neural TTS. Synthesizes "Your word is. X." then slices out just the
               word so the Replay button plays a clean, isolated pronunciation.
src/
  main.ts      Wires scene + avatars + classroom + net + lobby + match; the render loop
  scene.ts     Renderer, camera, ambient/hemisphere base light (interior lights live in the GLB)
  classroom.ts Loads classroom.glb, reads markers, builds the chalkboard texture + lights
  bee.ts       Match controller: turn flow, audio playback/Replay, chalkboard, camera, speller
  lobby.ts     2D lobby UI (mode select, roster, ready/start)
  avatars.ts   Animated GLB character manager (idle/walk/emotes) — from the old project
  net.ts       WebSocket client
  discord.ts   Discord Embedded App SDK identity/participants
  mock.ts      Local-dev participant source
public/
  characters/  7 player models (Astronaut, Blue Demon, Cactoro, Demon, Fish, Ninja, Zombie)
  assets/classroom.glb   the 3D classroom
```

## classroom.glb marker conventions

The 3D layer reads these named objects from the GLB (`src/classroom.ts`):

| Name                        | Role                                                                 |
|-----------------------------|----------------------------------------------------------------------|
| `lobby`                     | **Camera** for the lobby view (looks back at the seated class)       |
| `player`, `player.1`…`.7`   | Per-seat **cameras**. Players are seated here **by join order**; `player` (seat 0) is also the fixed match-camera POV |
| `currentturnplayerposition` | Where the active speller stands during their turn (hidden in-game)   |
| `doorwindow_arealight`      | Plane on the −X wall → a **rect-area light** (reads its position, dimensions, and normal) |
| `front wall`                | The board wall; the chalk-text overlay auto-mounts onto the board panel in front of it |

Seated avatars are placed on the floor under each seat camera, facing where that
camera looks. The two ceiling **point lights** are synthesized from the ceiling's
bounds (the GLB exports no `KHR_lights_punctual` data). Everything light/speller
related is tunable live via the **⚙ Debug** panel (mock mode) — hit **Copy
values** to dump the tuned numbers for baking back into `classroom.ts`.

## Flow

- **Lobby** = the 3D classroom rendered from the `lobby` camera, players seated at
  their join-order seats, with the menu (mode / roster / Ready / Start / Become
  host) floating on top.
- **Match** = fixed front camera (`player`); the active speller is pulled to
  `currentturnplayerposition`; live keystrokes render on the chalkboard.

## Status / next steps

- ✅ 3D lobby with seated players, mode select (only **Basic** wired up)
- ✅ Match: fixed front camera, speller at the front spot, live keystrokes on the
  GLB chalkboard (Stefan Simple font), TTS narration + Replay, elimination, bots
- ✅ Debug slider panel (lights + speller), "Become host" button
- ⬜ Independent per-player POVs (the seat cameras exist; not switched per-player yet)
- ⬜ Seated avatars use a standing pose (no sit animation yet)
- ⬜ Other modes: Knockout, Letter Scramble, Photo/Theme
