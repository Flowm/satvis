import { defineStore } from "pinia";
import { shallowRef, watch } from "vue";

import { CUSTOM_TAG, serializeCustomRecords } from "../modules/customSatellites";
import { type GpRecord, parseGpPayload, recordName } from "../modules/util/gp";
import { localStorageOrNone } from "../modules/util/localStorage";
import { useSatStore } from "./sat";

/** Where the records are kept, as a GP payload. */
const STORAGE_KEY = "satvis:customSatellites";

/** Never throws. */
function load(): GpRecord[] {
  try {
    const stored = localStorageOrNone()?.getItem(STORAGE_KEY);
    return stored ? parseGpPayload(stored) : [];
  } catch {
    return [];
  }
}

/**
 * The custom satellites, persisted per browser like bookmarks (docs/adr/0014-custom-satellites.md):
 * the url carries a custom satellite's name in `sats=`, not its elements.
 */
export const useCustomSatelliteStore = defineStore("customSatellites", () => {
  const satStore = useSatStore();

  /** Shallow, so the records reach the catalog unproxied; every change replaces the array. */
  const records = shallowRef<GpRecord[]>(load());

  watch(records, (next) => {
    try {
      localStorageOrNone()?.setItem(STORAGE_KEY, serializeCustomRecords(next));
    } catch (error) {
      console.warn("Could not store the custom satellites", error);
    }
  });

  /** Adds `added`, each replacing a custom satellite of its name. */
  function add(added: readonly GpRecord[]): void {
    const names = new Set(added.map(recordName));
    records.value = [...records.value.filter((record) => !names.has(recordName(record))), ...added];
  }

  /** Drops the custom satellite `name`, off every activation list and untracked; the last one takes its group's tag along. */
  function remove(name: string): void {
    records.value = records.value.filter((record) => recordName(record) !== name);
    satStore.setActivation({
      enabledTags: records.value.length > 0 ? satStore.enabledTags : satStore.enabledTags.filter((tag) => tag !== CUSTOM_TAG),
      enabledSatellites: satStore.enabledSatellites.filter((n) => n !== name),
      disabledSatellites: satStore.disabledSatellites.filter((n) => n !== name),
    });
    if (satStore.trackedSatellite === name) {
      satStore.trackedSatellite = "";
    }
  }

  return { records, add, remove };
});
