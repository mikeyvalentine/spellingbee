export interface Participant {
  id: string;
  name: string;
  avatarUrl?: string;
}

/** A source of participant state, implemented by both the mock and Discord backends. */
export interface RoomSource {
  localUserId: string;
  onParticipants(cb: (list: Participant[]) => void): void;
}
