import { setupScene } from "./scene";
import { AvatarManager } from "./avatars";
import { loadClassroom } from "./classroom";
import { connectNet } from "./net";
import { setupLobby } from "./lobby";
import { setupBee } from "./bee";
import { isInDiscord, initDiscord } from "./discord";
import { startMock } from "./mock";
import { setupDebug } from "./debug";
import type { RoomSource } from "./types";

const CHARACTER_URLS = [
  "/characters/Astronaut.glb",
  "/characters/Blue Demon.glb",
  "/characters/Cactoro.glb",
  "/characters/Demon.glb",
  "/characters/Fish.glb",
  "/characters/Ninja.glb",
  "/characters/Zombie.glb",
];

async function main(): Promise<void> {
  const { scene, camera, renderer, clock } = setupScene();
  const avatars = new AvatarManager(scene);

  const [, classroom] = await Promise.all([
    avatars.loadModels(CHARACTER_URLS),
    loadClassroom(scene),
  ]);

  // ---- identity / participants (Discord or local mock) ----
  const modeEl = document.getElementById("mode")!;
  const inDiscord = isInDiscord();
  let source: RoomSource;
  if (inDiscord) {
    modeEl.textContent = "Discord mode";
    source = await initDiscord();
  } else {
    modeEl.textContent = "Mock mode (local dev)";
    source = startMock();
  }
  const localId = source.localUserId;

  const names = new Map<string, string>([[localId, "You"]]);
  // Use the real participant name for everyone (Discord fills in the local user's
  // name); the lobby/roster appends "(you)" for the local player separately.
  const getName = (id: string) =>
    id.startsWith("bot:") ? "🤖 " + id.slice(4) : names.get(id) ?? "Player";

  source.onParticipants((list) => {
    for (const p of list) names.set(p.id, p.name);
    avatars.sync(list);
  });

  // Give the local player a model immediately; the server reassigns a globally
  // unique one on connect.
  avatars.setModel(localId, avatars.pickUnusedModel());

  // ---- networking ----
  // Inside Discord every socket must ride the proxy; elsewhere hit /ws directly.
  // VITE_WS_URL overrides both.
  const wsBase =
    import.meta.env.VITE_WS_URL ||
    (inDiscord
      ? `wss://${window.location.host}/.proxy/ws`
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`);
  // Start in this client's room: Discord => its call's private room; otherwise a
  // dev default. Public matchmaking reconnects to a `pub:<id>` room via setRoom.
  const net = connectNet(wsBase, localId, avatars.modelCount, source.roomKey);
  // Models are assigned deterministically by seat/chair (see CHAIR_MODELS in
  // bee.ts), so we ignore the server's per-player model assignment here.
  net.onLeave((id) => avatars.removePlayer(id));

  // ---- lobby + match ----
  const lobby = setupLobby({ net, localId, getName, isMock: !inDiscord, callRoomKey: source.roomKey });
  const match = setupBee({ net, localId, getName, camera, avatars, classroom, callRoomKey: source.roomKey });
  lobby.show(); // landing screen while we connect

  const connectingEl = document.getElementById("connecting");
  net.onBee((m) => {
    if (connectingEl) connectingEl.style.display = "none"; // first state arrived
    match.handle(m);
    switch (m.type) {
      case "bee_lobby":
        if (m.phase === "lobby" || m.phase === "idle") {
          lobby.onLobbyState(m);
          lobby.show();
        }
        break;
      case "bee_match_start":
        lobby.hide();
        break;
      case "bee_countdown":
        lobby.onCountdown(m);
        break;
    }
  });

  // Auto-join the lobby on (re)connect so being in the Activity = being in the lobby.
  net.onReady(() => net.sendBee({ type: "bee_join" }));

  // Dev-only hook to drive the match view locally (used for visual verification
  // without a full server-hosted match) + the tuning slider panel. Mock only.
  if (!inDiscord) {
    (window as any).__dbg = { match, classroom, lobby, localId, renderer, scene, camera, avatars };
    setupDebug(classroom);
  }

  // ---- render loop ----
  renderer.setAnimationLoop(() => {
    // Background tabs/frames (the preview runs several) shouldn't render — it
    // wastes the GPU and uploads the heavy scene into every context.
    if (document.hidden) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    match.update(); // drives the lobby/match camera + speller each frame
    avatars.update(dt);
    renderer.render(scene, camera);
  });
}

main().catch((err) => {
  console.error(err);
  const msg = "Error: " + (err as Error).message;
  const modeEl = document.getElementById("mode");
  if (modeEl) modeEl.textContent = msg;
  const connectingEl = document.getElementById("connecting");
  if (connectingEl) connectingEl.innerHTML = `<div style="font-size:36px">⚠️</div><div>${msg}</div>`;
});
