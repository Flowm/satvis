import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { SATELLITE_COMPONENTS } from "../config/components";
import { sameValue } from "../modules/util/equality";
import {
  moved,
  observerAfterGeolocation,
  observerAfterMove,
  observerAfterRemoval,
  relocated,
  renamed,
  repositioned,
  withGeolocation,
  without,
} from "../modules/util/groundStationEdits";
import { closedStringList, enumString, groundStationList, plainString, stringList, tildeEscapedStringList } from "../modules/util/urlCodec";

export interface SerializedGroundStation {
  lat: number;
  lon: number;
  name?: string;
}

/** Omitted lists keep their value. The three are written together because none can be validated alone. */
export interface ActivationPatch {
  enabledTags?: string[];
  enabledSatellites?: string[];
  disabledSatellites?: string[];
}

const unique = (names: readonly string[]): string[] => [...new Set(names)];
/** Decimal places, ~11 m. */
const COORDINATE_PRECISION = 4;
const roundCoordinate = (value: number): number => Number(value.toFixed(COORDINATE_PRECISION));

export const useSatStore = defineStore(
  "sat",
  () => {
    const enabledComponents = ref<string[]>(["Point", "Label"]);
    /** Bumped on every catalog change, so the entries stay out of Pinia. Not URL-synced. */
    const catalogRevision = ref(0);
    const trackedSatellite = ref("");
    const overpassMode = ref("elevation");

    // One invariant cluster (CONTEXT.md): read-only, so every writer goes through setActivation.
    const tags = ref<string[]>([]);
    const satellites = ref<string[]>([]);
    // Opted out of tag activation; meaningful only while a covering group is enabled.
    const excluded = ref<string[]>([]);
    const stations = ref<SerializedGroundStation[]>([]);

    const enabledTags = computed(() => tags.value);
    const enabledSatellites = computed(() => satellites.value);
    const disabledSatellites = computed(() => excluded.value);
    const groundStations = computed(() => stations.value);

    /** Drops duplicates and keeps enabled and excluded disjoint, with an individual enable winning. */
    function setActivation(patch: ActivationPatch): void {
      const nextTags = unique(patch.enabledTags ?? tags.value);
      const nextSatellites = unique(patch.enabledSatellites ?? satellites.value);
      const enabled = new Set(nextSatellites);
      const nextExcluded = unique(patch.disabledSatellites ?? excluded.value).filter((name) => !enabled.has(name));

      if (!sameValue(nextTags, tags.value)) {
        tags.value = nextTags;
      }
      if (!sameValue(nextSatellites, satellites.value)) {
        satellites.value = nextSatellites;
      }
      if (!sameValue(nextExcluded, excluded.value)) {
        excluded.value = nextExcluded;
      }
    }

    // The sky view's ground station, by index. Not url-synced, so a link's observer is
    // always the first station; a parameter would extend ADR 0001.
    const observer = ref(0);
    const observerStation = computed(() => Math.min(observer.value, Math.max(0, stations.value.length - 1)));

    /** Designates the observer. An index past the end is ignored. */
    function setObserverStation(index: number): void {
      if (!Number.isInteger(index) || index < 0 || index >= stations.value.length) {
        return;
      }
      observer.value = index;
    }

    /**
     * Replaces `_` and `,`, the `gs` separators (ADR 0001): the parser drops an entry with
     * more than three fields, so "Munich, DE" would not come back at all.
     */
    function wireSafeName(name: string | undefined): string | undefined {
      if (name === undefined) {
        return undefined;
      }
      const safe = name.replace(/[,_]/g, " ").replace(/\s+/g, " ").trim();
      return safe === "" ? undefined : safe;
    }

    /**
     * Drops unusable coordinates and duplicates, and puts the observer on the station
     * `observerAt` named in `next`: on the copy kept, should that one be a duplicate.
     */
    function replaceStations(next: readonly SerializedGroundStation[], observerAt: number): void {
      const kept = new Map<string, number>();
      const valid: SerializedGroundStation[] = [];
      let nextObserver = 0;
      for (const [index, station] of next.entries()) {
        if (!Number.isFinite(station.lat) || !Number.isFinite(station.lon)) {
          continue;
        }
        const lat = roundCoordinate(station.lat);
        const lon = roundCoordinate(station.lon);
        const name = wireSafeName(station.name);
        const key = `${lat}|${lon}|${name ?? ""}`;
        let at = kept.get(key);
        if (at === undefined) {
          at = valid.length;
          kept.set(key, at);
          valid.push(name === undefined ? { lat, lon } : { lat, lon, name });
        }
        if (index === observerAt) {
          nextObserver = at;
        }
      }
      if (!sameValue(valid, stations.value)) {
        stations.value = valid;
      }
      observer.value = nextObserver;
    }

    /** Replaces the list, as the url does. The observer keeps its place in it. */
    function setGroundStations(next: readonly SerializedGroundStation[]): void {
      replaceStations(next, observerStation.value);
    }

    // The edits a person makes. Each keeps the observer on the station it designates
    // (CONTEXT.md, Observer), so no caller pairs a list edit with a designation edit.

    /** Appended, the observer where it was. */
    function addGroundStation(station: SerializedGroundStation): void {
      replaceStations([...stations.value, station], observerStation.value);
    }

    /** My location's: the Geolocation station where the device is (`withGeolocation`), the observer where it was. */
    function placeGeolocation(lat: number, lon: number): void {
      replaceStations(withGeolocation(stations.value, lat, lon), observerAfterGeolocation(stations.value, observerStation.value));
    }

    /** Look up's: as `placeGeolocation`, and the observer there. */
    function observeGeolocation(lat: number, lon: number): void {
      replaceStations(withGeolocation(stations.value, lat, lon), 0);
    }

    /** Removing the observer hands it to the first station. */
    function removeGroundStation(index: number): void {
      replaceStations(without(stations.value, index), observerAfterRemoval(observerStation.value, index, stations.value.length));
    }

    /** By `by` places. Unchanged if the move would leave the list. */
    function moveGroundStation(index: number, by: number): void {
      replaceStations(moved(stations.value, index, by), observerAfterMove(observerStation.value, index, by, stations.value.length));
    }

    /** An empty name leaves the station unnamed. */
    function renameGroundStation(index: number, name: string): void {
      replaceStations(renamed(stations.value, index, name), observerStation.value);
    }

    function relocateGroundStation(index: number, field: "lat" | "lon", value: number): void {
      replaceStations(relocated(stations.value, index, field, value), observerStation.value);
    }

    /** Where a sky-view walk ends: the observer's station moves, keeping its name and list position. */
    function repositionObserver(lat: number, lon: number): void {
      const at = observerStation.value;
      if (stations.value[at]) {
        replaceStations(repositioned(stations.value, at, lat, lon), at);
      }
    }

    return {
      enabledComponents,
      catalogRevision,
      trackedSatellite,
      overpassMode,
      enabledTags,
      enabledSatellites,
      disabledSatellites,
      groundStations,
      observerStation,
      setActivation,
      setGroundStations,
      setObserverStation,
      addGroundStation,
      observeGeolocation,
      placeGeolocation,
      removeGroundStation,
      moveGroundStation,
      renameGroundStation,
      relocateGroundStation,
      repositionObserver,
    };
  },
  {
    // Wire format: docs/adr/0001-url-parameter-specification.md.
    urlsync: {
      enabled: true,
      config: [
        { name: "enabledComponents", url: "elements", kind: closedStringList(() => SATELLITE_COMPONENTS) },
        { name: "enabledSatellites", url: "sats", kind: tildeEscapedStringList() },
        { name: "disabledSatellites", url: "xsats", kind: tildeEscapedStringList() },
        { name: "enabledTags", url: "tags", kind: stringList() },
        { name: "groundStations", url: "gs", kind: groundStationList() },
        { name: "trackedSatellite", url: "track", kind: plainString() },
        { name: "overpassMode", url: "overpass", kind: enumString(["elevation", "swath"]) },
      ],
      // Guarded keys are read-only, so the url uses the same actions; the triple goes in one call.
      apply(store, patch) {
        const { enabledTags, enabledSatellites, disabledSatellites, groundStations, ...free } = patch;
        Object.assign(store, free);
        store.setActivation({
          enabledTags: enabledTags as string[],
          enabledSatellites: enabledSatellites as string[],
          disabledSatellites: disabledSatellites as string[],
        });
        store.setGroundStations(groundStations as SerializedGroundStation[]);
      },
    },
  },
);
