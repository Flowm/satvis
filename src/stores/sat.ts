import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { SATELLITE_COMPONENTS } from "../config/components";
import { sameValue } from "../modules/util/equality";
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

    /** An index past the end is ignored. */
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

    /** Drops unusable coordinates and duplicates. */
    function setGroundStations(next: readonly SerializedGroundStation[]): void {
      const seen = new Set<string>();
      const valid: SerializedGroundStation[] = [];
      for (const station of next) {
        if (!Number.isFinite(station.lat) || !Number.isFinite(station.lon)) {
          continue;
        }
        const lat = roundCoordinate(station.lat);
        const lon = roundCoordinate(station.lon);
        const name = wireSafeName(station.name);
        const key = `${lat}|${lon}|${name ?? ""}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        valid.push(name === undefined ? { lat, lon } : { lat, lon, name });
      }
      if (!sameValue(valid, stations.value)) {
        stations.value = valid;
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
