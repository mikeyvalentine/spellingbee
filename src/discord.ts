import { DiscordSDK, Common } from "@discord/embedded-app-sdk";
import type { Participant, RoomSource } from "./types";

/** Discord loads the Activity in an iframe with a `frame_id` query param. */
export function isInDiscord(): boolean {
  return new URLSearchParams(window.location.search).has("frame_id");
}

export async function initDiscord(): Promise<RoomSource> {
  const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;
  if (!CLIENT_ID) throw new Error("VITE_DISCORD_CLIENT_ID is not set");

  const sdk = new DiscordSDK(CLIENT_ID);
  await sdk.ready();

  // The 3D match view is authored for a wide (landscape) frame, so lock phones
  // to landscape. No-ops on desktop; wrapped defensively so an unsupported
  // platform/SDK version never blocks startup.
  try {
    await sdk.commands.setOrientationLockState({
      lock_state: Common.OrientationLockStateTypeObject.LANDSCAPE,
    });
  } catch (e) {
    console.warn("setOrientationLockState failed:", e);
  }

  // 1) Get an OAuth code from Discord. The Discord client fills in the redirect_uri
  // from the app's registered OAuth2 → Redirects, so at least one must be set there
  // (e.g. https://<application_id>.discordsays.com), or this errors "Missing redirect_uri".
  const { code } = await sdk.commands.authorize({
    client_id: CLIENT_ID,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify"],
  });

  // 2) Exchange it for an access token via our server (keeps the secret server-side).
  const res = await fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const { access_token } = await res.json();

  // 3) Authenticate this client.
  const auth = await sdk.commands.authenticate({ access_token });
  const localUserId = auth.user.id;

  let participantsCb: ((list: Participant[]) => void) | null = null;

  const toParticipant = (p: {
    id: string;
    username: string;
    global_name?: string | null;
    nickname?: string | null;
  }): Participant => ({
    id: p.id,
    name: p.nickname || p.global_name || p.username || "Player",
  });

  // Participants in this Activity instance. Defensive: payload shapes vary across
  // SDK versions, so never let one missing field break spawn-in.
  let initialParticipants: Participant[] = [];
  try {
    const initial = await sdk.commands.getInstanceConnectedParticipants();
    initialParticipants = (initial?.participants ?? []).map(toParticipant);
  } catch (e) {
    console.warn("getInstanceConnectedParticipants failed:", e);
  }

  try {
    sdk.subscribe("ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE", (e) => {
      participantsCb?.((e?.participants ?? []).map(toParticipant));
    });
  } catch (e) {
    console.warn("participants subscription failed:", e);
  }

  return {
    localUserId,
    onParticipants(cb) {
      participantsCb = cb;
      cb(initialParticipants); // re-emit the initial set now that we have a listener
    },
  };
}
