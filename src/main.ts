import { setupScene } from "./scene";
import { AvatarManager } from "./avatars";
import { loadClassroom } from "./classroom";
import { connectNet } from "./net";
import { setupLobby } from "./lobby";
import { setupBee } from "./bee";
import { makeClipboard } from "./clipboard";
import { makeAudioBus } from "./audio";
import type { RoomSource, Participant } from "./types";

// Model index = position in this list (CHAIR_MODELS, the bot roster, and the
// per-model seat offsets all index into it — keep the original 7 first so their
// indices stay stable, append new characters).
const CHARACTER_URLS = [
  "/characters/Astronaut.glb",
  "/characters/Blue Demon.glb",
  "/characters/Cactoro.glb",
  "/characters/Demon.glb",
  "/characters/Fish.glb",
  "/characters/Ninja.glb",
  "/characters/Zombie.glb",
  "/characters/Alien.glb",
  "/characters/Big arm.glb",
  "/characters/Bunny.glb",
  "/characters/Dino.glb",
  "/characters/Frog.glb",
  "/characters/Monkroose.glb",
  "/characters/Yeti.glb",
  "/characters/Zombie2.glb",
];

// Discord loads the Activity in an iframe with a `frame_id` query param. Inlined
// (instead of importing from ./discord) so the Discord SDK stays out of the
// initial bundle on the non-Discord/web path.
const isInDiscord = () => new URLSearchParams(window.location.search).has("frame_id");

async function main(): Promise<void> {
  const { scene, camera, renderer, clock, render, bloom } = setupScene();
  const avatars = new AvatarManager(scene);
  const clipboard = makeClipboard(camera); // 3D lobby clipboard (placeholder mesh)
  scene.add(clipboard.group);

  // Master audio bus (music + sfx). Autoplay is blocked until a user gesture, so
  // unlock + start the looping background song on the first interaction.
  const audio = makeAudioBus();
  const startAudio = () => { audio.startMusic("/assets/song.m4a"); };
  window.addEventListener("pointerdown", startAudio, { once: true });
  window.addEventListener("keydown", startAudio, { once: true });
  const modeEl = document.getElementById("mode")!;
  const inDiscord = isInDiscord();
  modeEl.textContent = inDiscord ? "Discord mode" : "Mock mode (local dev)";

  // Identity (Discord auth or mock) and the heavy 3D assets load IN PARALLEL —
  // the connect/lobby path must NOT wait for ~24MB of GLB. The SDK / mock module
  // is dynamically imported so only the path actually used is in the bundle.
  const sourceP: Promise<RoomSource> = inDiscord
    ? import("./discord").then((m) => m.initDiscord())
    : import("./mock").then((m) => m.startMock());
  const assetsP = Promise.all([avatars.loadModels(CHARACTER_URLS), loadClassroom(scene)]);

  // ---- identity ready → connect immediately (does not wait on assets) ----
  const source = await sourceP;
  const localId = source.localUserId;
  const names = new Map<string, string>([[localId, "You"]]);
  const getName = (id: string) =>
    id.startsWith("bot:") ? "🤖 " + id.slice(4) : names.get(id) ?? "Player";

  let assetsReady = false;
  let latestParticipants: Participant[] = [];
  source.onParticipants((list) => {
    latestParticipants = list;
    for (const p of list) names.set(p.id, p.name);
    if (assetsReady) avatars.sync(list); // avatar clones need the models loaded
  });

  // Inside Discord every socket rides the proxy; elsewhere hit /ws directly.
  // VITE_WS_URL overrides both. The hello `count` is a fixed constant (models are
  // assigned deterministically by seat/chair in bee.ts), so connect needn't wait
  // for the character GLBs to finish loading.
  const wsBase =
    import.meta.env.VITE_WS_URL ||
    (inDiscord
      ? `wss://${window.location.host}/.proxy/ws`
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`);
  const net = connectNet(wsBase, localId, CHARACTER_URLS.length, source.roomKey);
  net.onLeave((id) => avatars.removePlayer(id));

  // The lobby is 2D DOM — show it now, over the (still-loading) 3D scene.
  const lobby = setupLobby({ net, localId, getName, isMock: !inDiscord, callRoomKey: source.roomKey, clipboard });
  lobby.show();

  // The 3D match stage needs the classroom; until it's built, buffer bee messages.
  let match: ReturnType<typeof setupBee> | null = null;
  const pending: any[] = [];
  const connectingEl = document.getElementById("connecting");
  net.onBee((m) => {
    if (connectingEl) connectingEl.style.display = "none"; // first state arrived
    if (match) match.handle(m);
    else pending.push(m);
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
  // Being in the Activity = being in the lobby; (re)join on every (re)connect.
  net.onReady(() => net.sendBee({ type: "bee_join" }));

  // ---- assets ready → build the 3D match stage + start rendering ----
  const [, classroom] = await assetsP;
  assetsReady = true;
  avatars.setModel(localId, avatars.pickUnusedModel());
  if (latestParticipants.length) avatars.sync(latestParticipants);

  match = setupBee({
    net, localId, getName, camera, scene, avatars, classroom, audio,
    callRoomKey: source.roomKey,
    isUiFocused: () => clipboard.isFocused(), // calm the lobby free-look while the clipboard is up
    debug: !inDiscord,
  });
  for (const m of pending) match.handle(m); // replay anything that arrived early
  pending.length = 0;

  // Dev-only: debug hook + tuning slider panel (lazy — kept out of the prod bundle).
  if (!inDiscord) {
    (window as any).__dbg = { match, classroom, lobby, localId, renderer, scene, camera, avatars, bloom };
    import("./debug").then((m) => m.setupDebug(classroom, avatars, bloom)).catch(() => {});
  }

  renderer.setAnimationLoop(() => {
    // Background tabs/frames (the preview runs several) shouldn't render — it
    // wastes the GPU and uploads the heavy scene into every context.
    if (document.hidden) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    if (match) match.update(dt); // drives the lobby/match camera + speller + tomato
    clipboard.update(dt); // anchor + animate the lobby clipboard (after the camera is set)
    lobby.frame(); // position the paper panel over the clipboard
    avatars.setLabelsHidden(clipboard.isFocused()); // hide nametags while the clipboard is up
    avatars.update(dt);
    render(); // scene → bloom composer (desktop) or direct (mobile)
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
