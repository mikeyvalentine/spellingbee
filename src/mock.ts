import type { RoomSource } from "./types";

/**
 * Local-development backend. Provides a single local participant so the app runs
 * without any Discord setup (`npm run dev`). To test multiplayer locally, use the
 * lobby's "Add bots" button — those are server-side players that actually spell.
 */
export function startMock(): RoomSource {
  // A unique id per page load so multiple local tabs/frames don't collide as the
  // same player on the relay server.
  const id = "me-" + Math.random().toString(36).slice(2, 8);
  return {
    localUserId: id,
    onParticipants(cb) {
      setTimeout(() => cb([{ id, name: "You" }]), 0);
    },
  };
}
