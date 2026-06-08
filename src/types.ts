export interface Participant {
  id: string;
  name: string;
  avatarUrl?: string;
}

/** A source of participant state, implemented by both the mock and Discord backends. */
export interface RoomSource {
  localUserId: string;
  /**
   * Default room to join. Discord => `call:<instanceId>` (a private room per
   * voice-channel Activity instance); mock/web => a dev default. Public
   * matchmaking later swaps this for a `pub:<roomId>` key (see net.setRoom).
   */
  roomKey: string;
  onParticipants(cb: (list: Participant[]) => void): void;
}
