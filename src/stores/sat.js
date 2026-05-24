import { defineStore } from "pinia";

export const useSatStore = defineStore("sat", {
  state: () => ({
    enabledComponents: ["Point", "Label"],
    availableSatellitesByTag: [],
    availableTags: [],
    enabledSatellites: [],
    enabledTags: [],
    groundStations: [],
    trackedSatellite: "",
    overpassMode: "elevation",
    customTles: [], // Array of {tle: string, tags: string[]} for user-added TLE data
  }),
  urlsync: {
    enabled: true,
    config: [
      {
        name: "enabledComponents",
        url: "elements",
        serialize: (v) => v.join(",").replaceAll(" ", "-"),
        deserialize: (v) =>
          v
            .replaceAll("-", " ")
            .split(",")
            .filter((e) => e),
        default: ["Point", "Label"],
      },
      {
        name: "enabledSatellites",
        url: "sats",
        serialize: (v) => v.join(",").replaceAll(" ", "~"),
        deserialize: (v) =>
          v
            .replaceAll("~", " ")
            .split(",")
            .filter((e) => e),
        default: [],
      },
      {
        name: "enabledTags",
        url: "tags",
        serialize: (v) => v.join(",").replaceAll(" ", "-"),
        deserialize: (v) =>
          v
            .replaceAll("-", " ")
            .split(",")
            .filter((e) => e),
        default: [],
      },
      {
        name: "groundStations",
        url: "gs",
        serialize: (v) => v.map((gs) => `${gs.lat.toFixed(4)},${gs.lon.toFixed(4)}${gs.name ? `,${gs.name}` : ""}`).join("_"),
        deserialize: (v) =>
          v.split("_").map((gs) => {
            const g = gs.split(",");
            return {
              lat: parseFloat(g[0], 10),
              lon: parseFloat(g[1], 10),
              name: g[2],
            };
          }),
        default: [],
      },
      {
        name: "trackedSatellite",
        url: "track",
        default: "",
      },
      {
        name: "overpassMode",
        url: "overpass",
        default: "elevation",
      },
      {
        name: "customTles",
        url: "tle",
        serialize: (v) => {
          if (!v || v.length === 0) return "";
          // Format: ["TLE","tag1","tag2"],["TLE2","tag"]
          return v.map((entry) => JSON.stringify([entry.tle, ...entry.tags])).join(",");
        },
        deserialize: (v) => {
          if (!v) return [];
          try {
            // Wrap with [] if not already wrapped (starts with [[ means already an array of arrays)
            const json = v.startsWith("[[") ? v : `[${v}]`;
            const parsed = JSON.parse(json);
            return parsed.map((arr) => ({
              tle: arr[0],
              tags: arr.slice(1),
            }));
          } catch {
            return [];
          }
        },
        default: [],
      },
    ],
  },
});
