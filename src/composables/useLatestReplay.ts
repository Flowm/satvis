import { shallowRef } from "vue";

/**
 * A replay asked for from outside the Passes table (ADR 0023): of the newest overpass by day
 * the selected satellite or station's table records. The info panel starts it once its table
 * has listed them, so its bar steps through the table.
 */
export interface LatestReplayRequest {
  /** The satellite or station selected for it, by name, so a table still of the one before is not used. */
  subject: string;
}

/** The one asked for and not yet started. */
const request = shallowRef<LatestReplayRequest>();

/** Asks for, and hands the info panel, a replay of the newest recorded overpass. */
export function useLatestReplay() {
  /** Asks for it, in place of one not yet started. */
  function requestLatest(asked: LatestReplayRequest): void {
    request.value = asked;
  }
  return { request, requestLatest };
}
