#!/usr/bin/env node
// Write the parity fixtures the native app's tests are held to
// (docs/adr/0009-native-ios-app.md): what the web app's own code answers for the
// element sets in parity-input.json, and the axes Cesium tracks them in
// (tracking-frames.json, for SatvisRender). Also write the tables the native app reads
// as they are rather than keeping a copy of its own: the SATCAT and GCAT code labels,
// the external links and the url parameters a bookmark keeps. Never edit any output by hand; CI checks that rerunning
// this changes nothing.
//
// The web code is loaded through Vite's module runner, because its imports are
// extensionless TypeScript that plain node cannot resolve.

// The pass presentation formats dates, which works in local time.
process.env.TZ = "UTC";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as satellitejs from "satellite.js";
import { createServer, createServerModuleRunner } from "vite";
import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDir = path.join(repoRoot, "ios/SatvisKit/Tests/SatvisCoreTests/Fixtures");
const inputPath = path.join(fixtureDir, "parity-input.json");
const outputPath = path.join(fixtureDir, "parity.json");
const tablesPath = path.join(repoRoot, "ios/SatvisKit/Sources/SatvisCore/Shared/web-tables.json");
const trackingFramesPath = path.join(repoRoot, "ios/SatvisKit/Tests/SatvisRenderTests/Fixtures/tracking-frames.json");
const frameSummariesPath = path.join(repoRoot, "ios/SatvisKit/Tests/SatvisRenderTests/Fixtures/frame-summaries.json");
const sweepPath = path.join(repoRoot, "ios/SatvisKit/Tests/SatvisRenderTests/Fixtures/sweep.json");

/** Containers this long or shorter, and those holding only plain values, are written on one line. */
const INLINE_JSON_LENGTH = 120;

/** JSON indented by two spaces, with short and flat containers kept on one line, so a recording does not take a line a frame nor a table row a line a column. */
function compactJson(value, indent = "") {
  const inline = JSON.stringify(value);
  if (value === null || typeof value !== "object" || inline.length <= INLINE_JSON_LENGTH || Object.values(value).every((item) => item === null || typeof item !== "object")) {
    return inline;
  }
  const inner = `${indent}  `;
  const items = Array.isArray(value)
    ? value.map((item) => `${inner}${compactJson(item, inner)}`)
    : Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => `${inner}${JSON.stringify(key)}: ${compactJson(item, inner)}`);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return items.length === 0 ? `${open}${close}` : `${open}\n${items.join(",\n")}\n${indent}${close}`;
}

const MS_PER_MINUTE = 60_000;
// Around each element set's epoch: back a day, the epoch, half an orbit or so,
// then out to the edge of what a pass window looks at.
const OFFSETS_MINUTES = [-1440, 0, 45, 1440, 4 * 1440];
// Hour-angle instants that probe the arithmetic: J2000 itself, both sides of a
// midnight, a leap second's neighbourhood, and the far future.
const HOUR_ANGLE_INSTANTS = [
  "2000-01-01T12:00:00.000Z",
  "2016-12-31T23:59:59.000Z",
  "2017-01-01T00:00:00.000Z",
  "2026-10-04T11:59:59.999Z",
  "2026-10-04T12:00:00.000Z",
  "2049-06-30T18:30:15.250Z",
];
// Pass prediction: a mid-latitude station with a name, a southern one known by its
// coordinates, and one far enough north to see every polar orbit.
const STATIONS = [
  { name: "Munich", latitude: 48.1351, longitude: 11.582 },
  { name: "", latitude: -33.9249, longitude: 18.4241 },
  { name: "Svalbard", latitude: 78.2232, longitude: 15.6267 },
];
const PASS_WINDOW_DAYS = 2;
// One footprint wider to starboard, so the side a station lies on decides.
const ASYMMETRIC_SWATH = { starboardKm: 900, portKm: 250 };
// The edges the base passes never reach (Orbit.test.ts has them too): a station
// abeam the ground track, km to starboard, under a swath it barely enters, and
// windows that open or close partway through an elevation pass. Of the ISS and
// METOP-C, at their first pass over Munich.
const NARROW_SWATHS = [
  { offsetKm: 0.5, swath: { starboardKm: 1, portKm: 1 } },
  { offsetKm: 28.5, swath: { starboardKm: 30, portKm: 30 } },
  { offsetKm: 2.5, swath: { starboardKm: 5, portKm: 100 } },
];
const EDGE_RECORDS = [0, 1];
const MEAN_EARTH_RADIUS_KM = 6371;

// No dependency scan: nothing here is served to a browser, and on a cold cache the
// scan reports errors for entry points this script never loads.
const server = await createServer({
  root: repoRoot,
  configFile: false,
  appType: "custom",
  // configFile is off, so the @/ path alias from tsconfig.json has to be enabled here.
  resolve: { tsconfigPaths: true },
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false },
});
try {
  const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
  // The web formats for the browser's region (docs/adr/0015-formats-follow-the-device.md);
  // the native tests format en-US to compare.
  const { formatWeekdayDate, setFormatLocale } = await runner.import("/src/modules/util/formats.ts");
  setFormatLocale("en-US");
  const gp = await runner.import("/src/modules/util/gp.ts");
  const { greenwichHourAngle } = await runner.import("/src/modules/util/temeToFixed.ts");
  const { sampleInterval, gridAnchorEpochMs } = await runner.import("/src/modules/util/sgp4Worker.ts");
  const { default: Orbit } = await runner.import("/src/modules/Orbit.ts");
  const entityInfo = await runner.import("/src/modules/util/entityInfo.ts");
  const { VIEWER_PARAMS } = await runner.import("/src/modules/util/bookmarks.ts");
  const satcatCodes = await runner.import("/src/config/satcatCodes.ts");
  const gcatCodes = await runner.import("/src/config/gcatCodes.ts");
  const { externalLinks } = await runner.import("/src/config/externalLinks.ts");

  const input = fs.readFileSync(inputPath, "utf8");
  const records = gp.parseGpPayload(input);

  const parsed = records.map((record) => ({
    name: gp.recordName(record),
    satnum: gp.recordSatnum(record),
    orbitClass: gp.orbitClassOf(record),
    approximatePeriodMinutes: gp.approximatePeriodMinutes(record),
  }));

  const propagation = records.flatMap((record, index) => {
    const satrec = gp.createSatrec(record);
    // Whole minutes, so an instant is exact in every language that reads it back.
    const epochMs = Math.round((satrec.jdsatepoch - 2440587.5) * 1440) * MS_PER_MINUTE;
    return OFFSETS_MINUTES.map((offset) => {
      const instantMs = epochMs + offset * MS_PER_MINUTE;
      const state = satellitejs.propagate(satrec, new Date(instantMs));
      if (!state?.position || !state.velocity) {
        throw new Error(`${parsed[index].name}: no state at ${new Date(instantMs).toISOString()}`);
      }
      const { x, y, z } = state.position;
      // The same rotation the propagation worker applies (sgp4Worker), in metres.
      const angle = greenwichHourAngle(instantMs);
      const [c, s] = [Math.cos(angle), Math.sin(angle)];
      // The Orbit tab's live position.
      const { latitude, longitude, height, velocity } = new Orbit(parsed[index].name, record).positionGeodetic(new Date(instantMs), true);
      return {
        record: index,
        instant: new Date(instantMs).toISOString(),
        geodetic: { latitude, longitude, height, velocity },
        temePositionKm: [x, y, z],
        temeVelocityKmPerSecond: [state.velocity.x, state.velocity.y, state.velocity.z],
        fixedPositionMetres: [(c * x + s * y) * 1000, (-s * x + c * y) * 1000, z * 1000],
      };
    });
  });

  // The grid the web app samples a window on, an hour past each epoch: half an
  // orbit back and one and a half forward, as trajectoryWindow.ts asks for it.
  const grids = records.map((record, index) => {
    const satrec = gp.createSatrec(record);
    const periodMs = ((2 * Math.PI) / satrec.no) * MS_PER_MINUTE;
    const now = gridAnchorEpochMs(satrec) + 60 * MS_PER_MINUTE;
    const chunk = sampleInterval(satrec, now - 0.5 * periodMs, now + 1.5 * periodMs);
    const every = 20;
    return {
      record: index,
      anchorEpochMs: chunk.anchorEpochMs,
      stepSeconds: chunk.stepSeconds,
      samples: Array.from({ length: Math.ceil(chunk.positionsFixed.length / 3 / every) }, (_, k) => ({
        index: chunk.firstIndex + k * every,
        fixedPositionMetres: Array.from(chunk.positionsFixed.subarray(k * every * 3, k * every * 3 + 3)),
      })),
    };
  });

  // The axes Cesium's EntityView holds a tracked satellite's viewFrom in, at each state above:
  // its own code, handed the propagated positions, which it reads again a millisecond on. Its
  // camera is a stand-in that keeps the transform it is given.
  const { JulianDate: TrackingDate } = await runner.import("@cesium/core");
  const { CallbackPositionProperty, Entity, EntityView, SceneMode } = await runner.import("@cesium/engine");
  const trackingFrames = records.flatMap((record, index) => {
    const satrec = gp.createSatrec(record);
    const fixedAt = (ms) => {
      const { x, y, z } = satellitejs.propagate(satrec, new Date(ms)).position;
      const angle = greenwichHourAngle(ms);
      const [c, s] = [Math.cos(angle), Math.sin(angle)];
      return [(c * x + s * y) * 1000, (-s * x + c * y) * 1000, z * 1000];
    };
    return propagation
      .filter((state) => state.record === index)
      .map(({ instant }) => {
        const instantMs = Date.parse(instant);
        const time = TrackingDate.fromDate(new Date(instantMs));
        // Cesium asks for the instant and a millisecond on, which whole milliseconds hold exactly.
        const position = new CallbackPositionProperty((at, result) => {
          const [x, y, z] = fixedAt(instantMs + Math.round(TrackingDate.secondsDifference(at, time) * 1000));
          return Object.assign(result ?? {}, { x, y, z });
        }, false);
        const camera = {
          position: { x: 0, y: 0, z: 1 },
          direction: { x: 0, y: 0, z: -1 },
          up: { x: 0, y: 1, z: 0 },
          right: { x: 1, y: 0, z: 0 },
          _setTransform(transform) {
            this.transform = Array.from(transform);
          },
          lookAtTransform() {},
        };
        const view = new EntityView(new Entity({ position, viewFrom: { x: 1, y: 1, z: 1 } }), { mode: SceneMode.SCENE3D, camera });
        view.update(time);
        const m = camera.transform;
        return {
          record: index,
          instant,
          positionMetres: fixedAt(instantMs),
          millisecondOnMetres: fixedAt(instantMs + 1),
          axes: { x: m.slice(0, 3), y: m.slice(4, 7), z: m.slice(8, 11) },
        };
      });
  });

  // The info panel's Orbit, Spacecraft and Instruments tabs: derived, curated, GCAT, SATCAT
  // and CEOS facts, then the element set as the panel shows it.
  const details = records.map((record, index) => {
    const orbit = new Orbit(parsed[index].name, record);
    const { orbitClass, chips, status, orbitRows, spacecraftRows, instruments } = entityInfo.getSatelliteInfo(orbit, gp.orbitClassOf(record), record.metadata ?? {});
    return { facts: { orbitClass, chips, status, orbitRows, spacecraftRows, instruments }, elements: entityInfo.getElementsInfo(orbit) };
  });

  // Passes over each station from the minute after the epoch, in both modes: the
  // record's own swath (or the default), and an asymmetric one for the satellites
  // that carry a swath at all.
  const { DEFAULT_SWATH_KM, swathExtentsOf } = await runner.import("/src/config/satelliteMetadata.ts");
  const passes = records.flatMap((record, index) => {
    const orbit = new Orbit("", record);
    const startMs = Math.ceil((orbit.julianDate - 2440587.5) * 1440) * MS_PER_MINUTE;
    const start = new Date(startMs);
    const end = new Date(startMs + PASS_WINDOW_DAYS * 1440 * MS_PER_MINUTE);
    const own = swathExtentsOf(record.metadata ?? {});
    const swaths = own ? [own, ASYMMETRIC_SWATH] : [{ starboardKm: DEFAULT_SWATH_KM / 2, portKm: DEFAULT_SWATH_KM / 2 }];
    return STATIONS.flatMap((station, stationIndex) => {
      const position = { latitude: station.latitude, longitude: station.longitude, height: 0 };
      const strip = ({ name: _name, ...pass }) => pass;
      return [
        { record: index, station: stationIndex, startMs, endMs: end.getTime(), mode: "elevation", passes: orbit.computePassesElevation(position, start, end).map(strip) },
        ...swaths.map((swath) => ({
          record: index,
          station: stationIndex,
          startMs,
          endMs: end.getTime(),
          mode: "swath",
          swath,
          passes: orbit.computePassesSwath(position, swath, start, end).map(strip),
        })),
      ];
    });
  });

  // The edge cases, over stations of their own after the named ones.
  const edgeStations = [];
  const passEdges = EDGE_RECORDS.flatMap((index) => {
    const record = records[index];
    const orbit = new Orbit("", record);
    const strip = ({ name: _name, ...pass }) => pass;
    const [first] = passes.find((entry) => entry.record === index && entry.station === 0 && entry.mode === "elevation").passes;
    const munich = { latitude: STATIONS[0].latitude, longitude: STATIONS[0].longitude, height: 0 };
    // Whole milliseconds, so a window's edge is exact in every language.
    const [start, end] = [Math.round(first.start), Math.round(first.end)];
    const middle = Math.round((start + end) / 2);
    const windows = [
      [middle, middle + 180 * MS_PER_MINUTE],
      [start - 30 * MS_PER_MINUTE, middle],
      [start + 20_000, end - 20_000],
    ];
    const elevation = windows.map(([startMs, endMs]) => ({
      record: index,
      station: 0,
      startMs,
      endMs,
      mode: "elevation",
      passes: orbit.computePassesElevation(munich, new Date(startMs), new Date(endMs)).map(strip),
    }));
    // Closest approach 25 s off the minute grid, at that pass's apex.
    const closest = Math.round(first.apex / MS_PER_MINUTE) * MS_PER_MINUTE + 25_000;
    const here = orbit.positionGeodetic(new Date(closest));
    const ahead = orbit.positionGeodetic(new Date(closest + 10_000));
    const rad = Math.PI / 180;
    const [lat1, lon1, lat2, lon2] = [here.latitude * rad, here.longitude * rad, ahead.latitude * rad, ahead.longitude * rad];
    const bearing = Math.atan2(Math.sin(lon2 - lon1) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1));
    const narrow = NARROW_SWATHS.map(({ offsetKm, swath }) => {
      const delta = offsetKm / MEAN_EARTH_RADIUS_KM;
      const starboard = bearing + Math.PI / 2;
      const lat = Math.asin(Math.sin(lat1) * Math.cos(delta) + Math.cos(lat1) * Math.sin(delta) * Math.cos(starboard));
      const lon = lon1 + Math.atan2(Math.sin(starboard) * Math.sin(delta) * Math.cos(lat1), Math.cos(delta) - Math.sin(lat1) * Math.sin(lat));
      const station = { name: "", latitude: lat / rad, longitude: lon / rad };
      edgeStations.push(station);
      const [startMs, endMs] = [closest - 10 * MS_PER_MINUTE, closest + 10 * MS_PER_MINUTE];
      return {
        record: index,
        station: STATIONS.length + edgeStations.length - 1,
        startMs,
        endMs,
        mode: "swath",
        swath,
        passes: orbit.computePassesSwath({ ...station, height: 0 }, swath, new Date(startMs), new Date(endMs)).map(strip),
      };
    });
    return elevation.concat(narrow);
  });

  // How the info panel presents a pass list: the table's rows, the headline's
  // summary, the countdown, and the timeline strip, an hour into the window.
  const { JulianDate } = await runner.import("@cesium/core");
  const passPredictor = await runner.import("/src/modules/PassPredictor.ts");
  const { passTimelineLayout } = await runner.import("/src/modules/util/passTimeline.ts");
  const { compassPoint } = await runner.import("/src/modules/skyGeometry.ts");
  const presentation = passes
    .filter((entry) => entry.passes.length > 0)
    .map((entry) => {
      const nowMs = entry.startMs + 60 * MS_PER_MINUTE;
      const named = entry.passes.map((pass) => ({ ...pass, name: parsed[entry.record].name, groundStationName: STATIONS[entry.station].name || "station" }));
      const now = JulianDate.fromDate(new Date(nowMs));
      return {
        nowMs,
        rows: passPredictor.toPassRows(named, now, "groundStationName", entry.mode).map(({ countdown, startLabel, endLabel, primary, secondary }) => ({
          countdown,
          startLabel,
          endLabel,
          primary,
          secondary,
        })),
        summaries: named.map((pass) => passPredictor.passSummary(pass)),
        visible: passPredictor.filterPasses(named, now, false).length,
        layout: passTimelineLayout(named, nowMs),
      };
    });
  const countdowns = [-1, 0, 999, 1000, 59_999, 60_000, 3_599_999, 3_600_000, 86_399_999, 86_400_000, 200_000_000].map((untilMs) => ({
    untilMs,
    text: passPredictor.formatCountdown(0, { start: untilMs, end: untilMs + 600_000 }),
  }));
  const compassPoints = [-11.25, 0, 11.24, 11.25, 33.75, 180, 348.75, 359.99, 371.25].map((azimuth) => ({ azimuth, point: compassPoint(azimuth) }));

  // Links (ADR 0001): each field kind's answer for awkward input, then whole links
  // decoded onto a preset's defaults and written back, over the parameters and
  // vocabularies the native app honours. The query string goes through
  // vue-router's own parser and serializer, as the web app's does.
  const codec = await runner.import("/src/modules/util/urlCodec.ts");
  const { parseQuery, stringifyQuery } = await runner.import("vue-router");
  const { PIXEL_RATIO_RANGE, FPS_PANELS, BENCHMARK_MODES, offeredPixelRatio, pixelRatioValue, pixelRatiosFor } = await runner.import("/src/config/rendering.ts");
  const { UNSEEN_MODES } = await runner.import("/src/modules/util/visibility.ts");
  const { CAMERA_MODES } = await runner.import("/src/config/viewModes.ts");
  const { STAR_MAPS } = await runner.import("/src/config/starMaps.ts");
  const vocabulary = {
    components: ["Point", "Label", "Orbit", "Orbit track", "Ground track", "Sensor cone", "3D model", "Ground station link"],
    layers: ["NaturalEarth", "VersaTiles", "BlackMarble", "VIIRS"],
    terrain: ["None", "ReEarth"],
    // Whole, Tycho1K included: the app draws it as DeepStar1K, and a link keeps it.
    stars: [...STAR_MAPS],
    overpass: ["elevation", "swath"],
    scenes: ["3D", "2D", "Sky"],
    unseen: [...UNSEEN_MODES],
    cameras: [...CAMERA_MODES],
    pixelRatioRange: [...PIXEL_RATIO_RANGE],
    fpsPanels: [...FPS_PANELS],
    benchmarkModes: [...BENCHMARK_MODES],
  };
  // What a `pixelratio` draws at on a screen, and the Graphics panel's rungs there.
  const sampleRatios = ["1", "1.3", "1.5", "1.75", "2", "2.25", "3", "4", "native"];
  const pixelRatioLadders = [1, 1.25, 1.5, 2, 2.625, 2.75, 3, 3.5].map((screen) => ({
    screen,
    rungs: [...pixelRatiosFor(screen)],
    values: Object.fromEntries(sampleRatios.map((ratio) => [ratio, pixelRatioValue(ratio, screen)])),
    offered: Object.fromEntries(sampleRatios.map((ratio) => [ratio, offeredPixelRatio(ratio, screen) ?? null])),
  }));
  const kinds = {
    plainString: codec.plainString(),
    stringList: codec.stringList(),
    tildeEscapedStringList: codec.tildeEscapedStringList(),
    components: codec.closedStringList(() => vocabulary.components),
    layers: codec.layerList(() => vocabulary.layers),
    groundStationList: codec.groundStationList(),
    timestamp: codec.timestamp(),
    overpass: codec.enumString(vocabulary.overpass),
    // The native app keeps these among the foreign parameters, read with the web's kinds.
    fpsPanel: codec.enumString(vocabulary.fpsPanels),
    benchmarkMode: codec.enumString(vocabulary.benchmarkModes),
    pixelRatio: codec.ratioOrNative(...vocabulary.pixelRatioRange),
  };
  const PARSE_CASES = {
    pixelRatio: ["native", "1", "1.3", "4", "2.0", "01.50", "0.5", "4.01", "", " 2", "+2", "1e0", ".5", "2.", "Infinity", "Native", "١"],
    plainString: ["", "ISS (ZARYA)", "a,b~c"],
    stringList: ["", ",", "Weather", "GNSS,,Weather,", "Space Station,OT"],
    tildeEscapedStringList: ["", "NOAA~19", "ISS (ZARYA),NOAA 19", "A~B~C,,D"],
    components: ["", "Point", "Point,Label,Orbit", "Sensor-cone,Ground-track", "Bogus", "Point,Bogus", "Bogus,Nonsense", "3D model,Label", "Orbit track"],
    layers: [
      "",
      "VersaTiles",
      "NaturalEarth,VersaTiles",
      "VersaTiles_0.5",
      "VersaTiles_.50",
      "VersaTiles_1",
      "VersaTiles_1.0",
      "VersaTiles_0",
      "VersaTiles_2",
      "VersaTiles_",
      "_0.5",
      "VersaTiles_abc",
      "VersaTiles_0x1",
      "VersaTiles_1e-1",
      "VersaTiles_0.0000001",
      "VersaTiles_0.000001",
      "OSM",
      "OSM,BlackMarble",
      "Offline",
      "Tiles,NaturalEarth_0.3",
    ],
    groundStationList: [
      "",
      "48.1351,11.582",
      "46.5935,7.9091",
      "0,11.5",
      "-33.9249,18.4241,Cape Town",
      "48.1,11.5,Munich_47,8",
      "48.1,11.5,",
      "48.1",
      "1,2,3,4",
      "abc,11.5",
      "48.1abc,11.5",
      " 48.1,11.5",
      "1e1,-2.5e-1",
      "Infinity,1",
      "__48,11__",
    ],
    timestamp: [
      "2026-10-04T20:46Z",
      "2026-10-04T20:46:59Z",
      "2026-10-04T20:46:30.999Z",
      "2026-10-04T20:46",
      "2026-10-04",
      "2019-07-15T15:52",
      "2026-10-04T22:46+02:00",
      "Point",
      "",
    ],
    overpass: ["elevation", "swath", "Swath", ""],
    fpsPanel: ["true", "graph", "false", "Graph", ""],
    benchmarkMode: ["true", "run", "send", "false", "RUN", ""],
  };
  const FORMAT_CASES = {
    pixelRatio: ["native", "2", "2.0", "1.75", "9", "bogus"],
    plainString: ["", "ISS (ZARYA)"],
    stringList: [[], ["Weather"], ["GNSS", "Space Station"], ["a,b"]],
    tildeEscapedStringList: [[], ["NOAA 19"], ["A~B"], ["a,b"]],
    components: [[], ["Point", "Label"], ["Sensor cone"], ["Bogus"]],
    layers: [["NaturalEarth"], ["VersaTiles_0.5"], ["OSM"], ["VersaTiles_2"]],
    groundStationList: [
      [],
      [{ lat: 48.1351, lon: 11.582 }],
      [{ lat: 46.59354, lon: 7.90905, name: "Jungfraujoch" }],
      [{ lat: 0, lon: -0.00005 }],
      [{ lat: 1.00005, lon: 2.00015 }],
      [{ lat: 1, lon: 2, name: "a,b" }],
      [{ lat: 1, lon: 2, name: "a_b" }],
      [
        { lat: 1, lon: 2, name: "" },
        { lat: 3, lon: 4, name: "Two" },
      ],
    ],
    timestamp: [null, "2026-10-04T20:46:59.999Z", "2026-10-04T20:46Z"],
    overpass: ["elevation", "swath", "bogus"],
    fpsPanel: ["graph", "true"],
    benchmarkMode: ["run", "send", "true"],
  };
  // `value` is absent where the kind refuses the input.
  const answer = (entry, attempt) => (attempt.ok ? Object.assign(entry, { value: attempt.value }) : entry);
  const fieldKinds = Object.entries(kinds).map(([kind, field]) => ({
    kind,
    parses: PARSE_CASES[kind].map((raw) => answer({ raw }, field.parse(raw))),
    formats: FORMAT_CASES[kind].map((value) => answer({ input: value }, field.format(value))),
  }));

  const schema = [
    { name: "elements", kind: kinds.components },
    { name: "sats", kind: kinds.tildeEscapedStringList },
    { name: "xsats", kind: kinds.tildeEscapedStringList },
    { name: "tags", kind: kinds.stringList },
    { name: "gs", kind: kinds.groundStationList },
    { name: "track", kind: kinds.plainString },
    { name: "overpass", kind: kinds.overpass },
    { name: "layers", kind: kinds.layers },
    { name: "terrain", kind: codec.enumString(vocabulary.terrain) },
    { name: "stars", kind: codec.enumString(vocabulary.stars) },
    { name: "scene", kind: codec.enumString(vocabulary.scenes) },
    { name: "unseen", kind: codec.enumString(vocabulary.unseen) },
    { name: "camera", kind: codec.enumString(vocabulary.cameras) },
    { name: "pixelratio", kind: kinds.pixelRatio },
    { name: "time", kind: kinds.timestamp },
  ];
  const owned = new Set(schema.map((spec) => spec.name));
  const globalDefaults = {
    elements: ["Point", "Label"],
    sats: [],
    xsats: [],
    tags: [],
    gs: [],
    track: "",
    overpass: "elevation",
    layers: ["NaturalEarth"],
    terrain: "None",
    stars: "Tycho1K",
    scene: "3D",
    unseen: "dim",
    camera: "Fixed",
    pixelratio: "native",
    time: null,
  };
  const PRESETS = {
    default: { tags: "Weather" },
    demo: { tags: "GNSS", elements: "Point,Orbit,Ground track", overpass: "swath", layers: "VersaTiles" },
  };
  const LINK_CASES = [
    ["default", ""],
    ["default", "tags=Weather"],
    ["default", "tags="],
    ["default", "tags=&sats=ISS+(ZARYA)&track=ISS+(ZARYA)&elements=Point,Label,Orbit,3D+model&layers=VersaTiles"],
    ["default", "scene=Sky&gs=46.5935,7.9091&terrain=ReEarth&layers=VersaTiles&stars=DeepStar2K&time=2026-10-04T19:22Z&tags=GNSS,Weather,OneWeb&elements=Point,Label"],
    ["default", "sats=NOAA~19,METOP-B&elements=Point,Sensor-cone&xsats=A%2CB"],
    ["default", "layers=Bogus&terrain=CesiumWorldTerrain&overpass=Swath&time=Point&gs=abc,1_2,3"],
    ["default", "embed&tags=Weather&tags=GNSS&bench=true&utm_source=x+y"],
    ["default", "track=&gs=&elements="],
    ["default", "scene=Columbus&gs=46.5935,7.9091"],
    ["default", "scene=2D&tags=Science"],
    ["demo", "scene=2D&track=ISS+(ZARYA)"],
    ["default", "scene=Sky&track=ISS+(ZARYA)"],
    ["default", "scene=Sky&unseen=hide&gs=48.1372,11.5756,Munich"],
    ["default", "unseen=show"],
    ["default", "camera=Inertial&scene=Sky&gs=48.1372,11.5756"],
    ["default", "camera=inertial"],
    ["demo", "camera=Fixed"],
    ["default", "unseen=dim&unseen=Hide"],
    ["default", "stars=Tycho1K&tags=GNSS"],
    ["default", "stars=DeepStar1K"],
    ["default", "stars=deepstar2k&layers=VersaTiles"],
    ["default", "layers=NaturalEarth,VersaTiles_0.50,BlackMarble"],
    ["default", "pixelratio=1.5&tags=Starlink"],
    ["default", "pixelratio=native"],
    ["default", "pixelratio=2&msaa=4"],
    ["default", "sats=Caf%C3%A9+1,%E2%9C%93&track=a%26b%3Dc%23d"],
    ["demo", ""],
    ["demo", "tags=GNSS"],
    ["demo", "tags=Weather&overpass=elevation&layers=NaturalEarth"],
    ["demo", "elements=Point,Label"],
  ];
  // What analytics may see of a link: ground stations to the whole degree.
  const { sanitizePostHogUrl } = await runner.import("/src/modules/util/posthogPrivacy.ts");
  const sanitized = [
    "https://satvis.space/",
    "https://satvis.space/?gs=48.1351,11.5820",
    "https://satvis.space/ot?tags=OT&gs=-33.9249,-0.5,Cape+Town_46.5935,7.9091&time=2026-10-04T08:52Z",
    "https://satvis.space/?sats=NOAA+19&gs=.5,1e1#gs=1.5,2.5",
    "https://satvis.space/?xgs=48.1351,11.5820",
  ].map((url) => ({ url, sanitized: sanitizePostHogUrl(url) }));
  const links = LINK_CASES.map(([preset, query]) => {
    const defaults = codec.decode(PRESETS[preset], schema, globalDefaults).patch;
    const parsedQuery = parseQuery(query);
    const ownedQuery = {};
    const foreign = {};
    for (const [key, value] of Object.entries(parsedQuery)) {
      if (!owned.has(key)) {
        foreign[key] = value;
        continue;
      }
      const first = Array.isArray(value) ? value[0] : value;
      if (typeof first === "string") {
        ownedQuery[key] = first;
      }
    }
    const { patch, invalid } = codec.decode(ownedQuery, schema, defaults);
    return { preset, query, state: patch, invalid, written: stringifyQuery({ ...foreign, ...codec.encode(patch, defaults, schema) }) };
  });

  const hourAngles = HOUR_ANGLE_INSTANTS.map((instant) => ({ instant, radians: greenwichHourAngle(Date.parse(instant)) }));

  // The sky view's verdict on what could be seen (ADR 0010): the sun, Earth's
  // shadow, and the verdict at the edges of its cut-offs.
  const sky = await runner.import("/src/modules/util/visibility.ts");
  const sunDirections = HOUR_ANGLE_INSTANTS.map((instant) => ({ instant, direction: sky.sunDirection(Date.parse(instant), { x: 0, y: 0, z: 0 }) }));
  const shadowSun = sky.sunDirection(Date.parse("2026-10-05T17:45:00Z"), { x: 0, y: 0, z: 0 });
  const shadows = [
    [-7e6, 0, 0],
    [7e6, 0, 0],
    [0, 7e6, 0],
    [-7e6, 6.3e6, 0],
    [-7e6, 6.4e6, 0],
    [-42e6, 0, 1e6],
    [-7e6, 0, 6.5e6],
  ].map(([x, y, z]) => {
    const position = { x, y, z };
    return { position, sun: shadowSun, inShadow: sky.inEarthShadow(position, shadowSun) };
  });
  const verdicts = [
    [sky.DARK_SKY_SUN_ELEVATION, true, 1000],
    [sky.DARK_SKY_SUN_ELEVATION + 0.001, true, 1000],
    [-20, true, sky.MAX_VISIBLE_RANGE_KM],
    [-20, true, sky.MAX_VISIBLE_RANGE_KM + 0.001],
    [-20, false, 1000],
    [-20, false, 36_000],
    [10, false, 1000],
    [10, true, 36_000],
  ].map(([sunElevation, sunlit, rangeKm]) => ({ sunElevation, sunlit, rangeKm, visibility: sky.visibility(sunElevation, sunlit, rangeKm) }));

  // Case, accents and digits, against Swift's `localizedCompare`.
  const GROUP_NAMES = ["Weather", "active", "GNSS", "Guowang", "Éclair", "eutelsat", "IridiumNEXT", "iridium", "OneWeb", "Starlink 2", "Starlink 10"];

  // The sky view's lock card: where to look, rounded and grouped, and the verdict's words.
  const skyCard = await runner.import("/src/modules/skyCard.ts");
  const lockPositions = [
    [0, 0.4, 412.5],
    [-0.4, 12, 999.5],
    [11.25, 30.5, 1540.2],
    [192.3, 47.06, 4999.5],
    [359.6, 89.6, 38_362.4],
    [10, -0.3, 500],
  ].map(([azimuth, elevation, rangeKm]) => {
    const { text, spoken } = skyCard.lockPosition(azimuth, elevation, rangeKm);
    return { azimuth, elevation, rangeKm, text, spoken };
  });

  // The clock deck's day, in regions whose locale data the browser and Apple's write
  // differently ("Sept", "25. Oct"): the one format held to the web in more than en-US.
  const weekdayDates = [
    ["en-US", "2026-10-25T23:30:00Z"],
    ["en-DE", "2026-10-25T23:30:00Z"],
    ["en-GB", "2026-09-06T00:00:00Z"],
    ["en-AU", "2026-06-07T12:00:00Z"],
    ["en-AU", "2026-07-01T23:59:59Z"],
    ["en-CA", "2026-01-05T00:00:00Z"],
    ["en-AT", "2026-12-31T00:00:00Z"],
    ["en-CH", "2026-02-01T00:00:00Z"],
    ["en-IN", "2026-03-15T00:00:00Z"],
  ].map(([locale, at]) => {
    setFormatLocale(locale);
    return { locale, at, text: formatWeekdayDate(Date.parse(at)) };
  });
  setFormatLocale("en-US");

  // Bookmarks (ADR 0011): what a card says of a scene, and the name a scene is given,
  // against the default preset's defaults and the demo preset's, for the default
  // preset's featured bookmarks among others.
  const bookmarks = await runner.import("/src/modules/util/bookmarks.ts");
  const corePresets = parseYaml(fs.readFileSync(path.join(repoRoot, "worker/src/config/satvis.core.yaml"), "utf8")).presets;
  const featured = corePresets.find(({ name }) => name === "default").featured ?? [];
  const BOOKMARK_NOW = "2026-10-08T12:00:00Z";
  const BOOKMARK_CASES = [
    ["default", {}],
    ["default", { tags: "", sats: "ISS (ZARYA)", track: "ISS (ZARYA)", time: "2026-10-04T02:07Z" }],
    ["default", { scene: "Sky", gs: "46.5935,7.9091,Lauterbrunnen_48.1,11.5", tags: "GNSS,Weather,OneWeb" }],
    ["default", { scene: "Sky", gs: "46.5935,7.9091" }],
    ["default", { scene: "Sky", gs: "-33.92495,18.42405" }],
    ["default", { scene: "Sky" }],
    ["default", { scene: "Sky", gs: "" }],
    ["default", { sats: "A,B,C" }],
    ["default", { tags: "", sats: "A,B" }],
    ["default", { tags: "", sats: "A" }],
    ["default", { tags: "" }],
    ["default", { scene: "2D", tags: "Science" }],
    ["default", { scene: "Columbus" }],
    ["default", { scene: "Bogus" }],
    ["default", { track: "NOAA 19" }],
    ["default", { tags: "Stations", track: "ISS (ZARYA)" }],
    ["default", { tags: "GNSS" }],
    ["default", { tags: "OT", sats: "X" }],
    ["default", { time: "2025-12-31T23:59Z" }],
    ["default", { time: "not a time" }],
    ...Array.from({ length: 12 }, (_, month) => ["default", { time: `2026-${String(month + 1).padStart(2, "0")}-09T07:05Z` }]),
    ["demo", {}],
    ["demo", { scene: "Sky", gs: "1,2,Home" }],
    ...featured.map(({ query = {} }) => ["default", query]),
  ];
  const summaries = BOOKMARK_CASES.map(([preset, query]) => {
    const summary = bookmarks.summarize(query, PRESETS[preset]);
    return { preset, query, summary, name: bookmarks.defaultName(summary) };
  });
  const bookmarkNow = Date.parse(BOOKMARK_NOW);
  const ages = [0, 30_000, 59_999, 60_000, 5 * 60_000, 59 * 60_000, 3_600_000, 3 * 3_600_000, 23 * 3_600_000 + 59 * 60_000, 50 * 3_600_000, -60_000].map((ago) => ({
    ago,
    text: bookmarks.timeAgo(bookmarkNow - ago, bookmarkNow),
  }));

  // Lower-detail copies (ADR 0007): the level a model is drawn at, from the size of the
  // level drawn now, either side of each maxPoints and of its hysteresis.
  const { MODEL_LEVEL_HYSTERESIS, modelLevel } = await runner.import("/src/config/modelLevels.ts");
  const LOD_SETS = [
    [],
    [{ file: "a-low.glb", maxPoints: 100 }],
    [
      { file: "a-mid.glb", maxPoints: 300 },
      { file: "a-low.glb", maxPoints: 100 },
    ],
  ];
  const modelLevels = LOD_SETS.flatMap((lods, set) =>
    [10, 79.9, 80, 99, 100, 100.1, 239.9, 240, 300, 300.1, 1000].flatMap((diameter) =>
      [0, 1, 2, 3].map((current) => [set, diameter, current, modelLevel(diameter, current, lods)]),
    ),
  );

  // The benchmark's comparable core (ADR 0016): recordings in, the figures both apps report
  // out. Even and uneven paces, paced, no GPU, overlapping GPU spans, either side over budget,
  // and the smallest counts, where a percentile's rank shows.
  const { summarize } = await runner.import("/src/modules/benchmark/frameSummary.ts");
  const { sceneMetrics } = await runner.import("/src/modules/benchmark/benchmarkReport.ts");
  const HZ60 = 1000 / 60;
  const repeat = (count, value) => Array.from({ length: count }, () => value);
  const FRAME_RECORDINGS = [
    {
      name: "even 60 Hz",
      refreshMs: HZ60,
      recording: { intervals: repeat(100, HZ60), cpu: repeat(101, 4.2), gpu: repeat(101, 9.1), skippedCpu: [], durationMs: 1683.3, gpuActiveMs: 919.1, totalCpuMs: 1130.2 },
    },
    {
      name: "uneven",
      refreshMs: HZ60,
      recording: { intervals: [...repeat(90, 16.7), ...repeat(10, 50.1)], cpu: [1, 3], gpu: [8, 10], skippedCpu: [], durationMs: 2004, gpuActiveMs: 18 },
    },
    { name: "two refreshes at 32.5 ms", refreshMs: HZ60, recording: { intervals: [16.7, 32.5], cpu: [2, 2, 2], gpu: [], skippedCpu: [], durationMs: 49.2 } },
    {
      name: "30 fps chosen",
      refreshMs: 1000 / 30,
      recording: { intervals: [33.3, 33.4, 50.1, 66.7], cpu: [5, 5, 5, 5, 5], gpu: [12, 12, 12, 12, 12], skippedCpu: [], durationMs: 183.5, gpuActiveMs: 60 },
    },
    {
      name: "paced, idle",
      refreshMs: HZ60,
      recording: { intervals: [250, 980, 1000], cpu: [3, 3, 3, 3], gpu: [7, 7, 7, 7], skippedCpu: repeat(120, 0.05), durationMs: 2300, gpuActiveMs: 28, totalCpuMs: 41.5 },
    },
    {
      name: "idle, the GPU clocked down",
      refreshMs: HZ60,
      recording: { intervals: [250, 300], cpu: [3, 3, 3], gpu: [28, 29, 27], skippedCpu: repeat(30, 0.05), durationMs: 600, gpuActiveMs: 84, idle: true },
    },
    { name: "CPU-bound, no GPU timer", refreshMs: HZ60, recording: { intervals: [20, 22, 21], cpu: [18, 19, 20, 19], gpu: [], skippedCpu: [], durationMs: 63 } },
    {
      name: "GPU busier",
      refreshMs: HZ60,
      recording: { intervals: [100, 100], cpu: [30, 30, 20], gpu: [5, 5, 5], skippedCpu: [10, 10], durationMs: 500, gpuActiveMs: 15 },
    },
    { name: "one frame", refreshMs: HZ60, recording: { intervals: [], cpu: [4], gpu: [9], skippedCpu: [], durationMs: 16, gpuActiveMs: 9 } },
    { name: "two frames", refreshMs: HZ60, recording: { intervals: [16.6], cpu: [4, 5], gpu: [], skippedCpu: [], durationMs: 33 } },
    {
      name: "GPU over budget on half",
      refreshMs: HZ60,
      recording: { intervals: [33.3, 16.7, 33.3], cpu: [5, 5, 5, 5], gpu: [20, 20, 10, 10], skippedCpu: [], durationMs: 100, gpuActiveMs: 60 },
    },
    { name: "nothing", refreshMs: HZ60, recording: { intervals: [], cpu: [], gpu: [], skippedCpu: [] } },
    // One frame in 400 over budget is 0.25 %, a tie `toFixed` rounds up and `%f` down.
    {
      name: "one in 400 over",
      refreshMs: HZ60,
      recording: { intervals: repeat(399, HZ60), cpu: [...repeat(399, 2), 20], gpu: [], skippedCpu: [], durationMs: 6650 },
    },
  ];
  // The report's rounded figures too, numbers only, after a load of 1.25 s, itself a tie.
  const reported = (entry, summary) =>
    Object.fromEntries(
      Object.entries(
        sceneMetrics({ id: "x", satellites: 74, loadSeconds: 1.25, timedOut: false, idle: entry.recording.idle ?? false, summary, memoryMb: null, memorySource: null, extras: {} }),
      ).filter(([, value]) => value === null || typeof value === "number"),
    );
  const frameSummaries = FRAME_RECORDINGS.map((entry) => {
    const summary = summarize(entry.recording, entry.refreshMs);
    return Object.assign({}, entry, { summary, metrics: reported(entry, summary) });
  });

  // A sweep's plans and tables (ADR 0016): both apps plan the same steps and read the same
  // tables, csv and pasted text from what they measured. Ties on the rounding digit (0.125,
  // 2.675) pin `toFixed`'s rounding; nulls where an app cannot say.
  const plan = await runner.import("/src/modules/benchmark/benchmarkPlan.ts");
  const sweepReport = await runner.import("/src/modules/benchmark/report.ts");
  const benchmarkStatus = await runner.import("/src/modules/benchmark/benchmarkStatus.ts");
  // Every phase, both kinds, durations either side of the switch to minutes, and drift's signs.
  const STATUSES = [
    { phase: "idle", kind: "scenes", index: 0, total: 10, remainingMs: 120_000 },
    { phase: "idle", kind: "sweep", index: 0, total: 1, remainingMs: 6_400 },
    { phase: "idle", kind: "sweep", index: 0, total: 0, remainingMs: 0 },
    { phase: "loading", kind: "scenes", index: 3, total: 7, remainingMs: 89_499 },
    { phase: "loading", kind: "sweep", index: 0, total: 42, remainingMs: 89_500 },
    { phase: "settling", kind: "sweep", index: 5, total: 42, remainingMs: 245_000 },
    { phase: "measuring", kind: "scenes", index: 6, total: 7, remainingMs: 2_500 },
    { phase: "done", kind: "scenes", index: 0, total: 7, remainingMs: 0, driftPct: 0.04 },
    { phase: "done", kind: "sweep", index: 0, total: 7, remainingMs: 0, driftPct: -12.25 },
    { phase: "done", kind: "sweep", index: 0, total: 7, remainingMs: 0, driftPct: null },
    { phase: "cancelled", kind: "scenes", index: 0, total: 7, remainingMs: 0, measured: 3 },
  ];
  const { DEFAULT_OPTIONS } = await runner.import("/src/modules/benchmark/benchmarkRunner.ts");
  const PLAN_SPECS = [
    { satelliteCounts: [1000, 0, 100, 100, -5, 2.5], componentSets: plan.CUMULATIVE_COMPONENT_SETS.slice(0, 3), clockMultipliers: [1, 100, 0, 100] },
    { satelliteCounts: [0, 50], componentSets: [["Point"]], repeatFirstStep: false },
    { satelliteCounts: [7], componentSets: [[]] },
  ];
  const sweepResult = (fields) =>
    Object.assign(
      {
        clock: 1,
        repeat: false,
        componentInstances: {},
        buildMs: 0,
        clearMs: 0,
        frames: 120,
        fps: 60,
        frameMs: 16.67,
        cpuP95Ms: null,
        gpuMs: null,
        gpuP95Ms: null,
        overBudgetPct: 0,
        loadPct: null,
        cpuBusyPct: null,
        cpuTotalPct: null,
        heapMb: null,
        heapPeakMb: null,
        footprintMb: null,
        footprintTotalMb: null,
        footprintWorkerMb: null,
        extras: {},
      },
      fields,
      { components: fields.components, componentsDrawn: fields.componentsDrawn ?? fields.components, visible: fields.visible ?? fields.satelliteCount },
    );
  const SWEEP_RUNS = [
    {
      name: "web isolated with heap, gpu and a repeat",
      results: [
        [0, ["Point"], 0.64, 52.4, 3.1],
        [100, ["Point"], 0.96, 57.71, 3.3],
        [500, ["Point"], 1.21, 79.3, 3.6],
        [1000, ["Point"], 2.675, 106.125, 4.2],
        [0, ["Point", "Label"], 0.7, 53, 3.2],
        [100, ["Point", "Label"], 1.8, 60.2, 3.5],
        [500, ["Point", "Label"], 4.9, 84.6, 4.1],
        [1000, ["Point", "Label"], 8.125, 112.9, 5.05],
      ]
        .map(([satelliteCount, components, cpuMs, heap, gpu]) =>
          sweepResult({
            satelliteCount,
            components,
            cpuMs,
            cpuP95Ms: cpuMs * 1.3,
            heapMb: heap,
            heapPeakMb: heap + 12.5,
            gpuMs: gpu,
            gpuP95Ms: gpu * 1.25,
            loadPct: gpu * 10,
            cpuBusyPct: cpuMs * 6,
            buildMs: satelliteCount * 1.45,
            clearMs: 3.3,
            extras: { tick_ms: cpuMs / 2, render_ms: cpuMs / 2, entities: satelliteCount },
          }),
        )
        .concat([
          sweepResult({
            satelliteCount: 0,
            components: ["Point"],
            repeat: true,
            cpuMs: 0.71,
            heapMb: 49,
            gpuMs: 3,
            buildMs: 12,
            extras: { tick_ms: 0.3, render_ms: 0.41, entities: 0 },
          }),
        ]),
    },
    {
      name: "native clock sweep, total CPU, absolute memory, no heap",
      results: [1, 10, 100, 1000].flatMap((clock) =>
        [0, 500, 5000].map((satelliteCount) =>
          sweepResult({
            satelliteCount,
            components: ["Point", "Orbit"],
            clock,
            cpuMs: 0.3 + satelliteCount * 0.0001,
            cpuP95Ms: 0.5 + satelliteCount * 0.0001,
            cpuTotalPct: 2 + (satelliteCount / 1000) * Math.log10(clock * 10) * 3.33,
            gpuMs: 3.4 + satelliteCount * 0.0002,
            fps: clock === 1000 && satelliteCount === 5000 ? 44.8 : 60,
            overBudgetPct: clock === 1000 && satelliteCount === 5000 ? 33.9 : 0,
            cpuBusyPct: 2.5,
            footprintMb: 150 + satelliteCount * 0.0525,
            buildMs: 300 + satelliteCount * 0.1,
            extras: { gpu_memory_mb: 80 + satelliteCount / 100, buffer_wait_ms: null },
          }),
        ),
      ),
    },
    {
      name: "a capped component and a thin row",
      results: [
        sweepResult({
          satelliteCount: 0,
          components: ["Point", "Label"],
          componentsDrawn: ["Point"],
          cpuMs: 1,
          gpuMs: 49,
          gpuP95Ms: 52,
          loadPct: 99,
          cpuBusyPct: 7.1,
        }),
        sweepResult({
          satelliteCount: 100,
          components: ["Point", "Label"],
          componentsDrawn: ["Point"],
          visible: 101,
          cpuMs: 1.5,
          gpuMs: 51,
          frames: 7,
        }),
        sweepResult({ satelliteCount: 100, components: ["Point"], cpuMs: 0.125, gpuMs: 2 }),
      ],
    },
    { name: "nothing measured", results: [] },
  ];
  const sweepRunOf = (entry) => ({
    results: entry.results,
    startedAtIso: "2026-11-07T12:00:00.000Z",
    spec: { satelliteCounts: [0, 100], componentSets: [["Point"]] },
    environment: { app_version: "test" },
    options: { warmupMs: 2000, sampleMs: 4000 },
    catalogSize: 16762,
    cancelled: false,
  });
  const sweep = {
    generatedBy: "scripts/parity/generate.mjs",
    defaults: {
      satelliteCounts: plan.DEFAULT_SATELLITE_COUNTS,
      quickSatelliteCounts: plan.QUICK_SATELLITE_COUNTS,
      clockMultipliers: plan.DEFAULT_CLOCK_MULTIPLIERS,
      cumulativeComponentSets: plan.CUMULATIVE_COMPONENT_SETS,
      isolatedComponentSets: plan.ISOLATED_COMPONENT_SETS,
      clockComponentSets: plan.CLOCK_COMPONENT_SETS,
      warmupMs: DEFAULT_OPTIONS.warmupMs,
      sampleMs: DEFAULT_OPTIONS.sampleMs,
      minTrustworthyFrames: sweepReport.MIN_TRUSTWORTHY_FRAMES,
      named: plan.NAMED_SWEEPS,
      groundStation: plan.SWEEP_GROUND_STATION,
    },
    statuses: STATUSES.map((status) => ({ status, line: benchmarkStatus.statusLine(status) })),
    // Either side of the millisecond, both signs, and what has no first step.
    drifts: [
      [0.3, 0.25],
      [10, 11.5],
      [12, 10.9],
      [2, 3],
      [0, 5],
      [null, 4],
    ].map(([first, repeated]) => ({ first, repeated, shown: benchmarkStatus.shownDrift(first, repeated) })),
    plans: PLAN_SPECS.map((spec) => ({ spec, steps: plan.buildPlan(spec), estimateMs: plan.estimateDurationMs(plan.buildPlan(spec), 6000) })),
    runs: SWEEP_RUNS.map((entry) => {
      const run = sweepRunOf(entry);
      return {
        name: entry.name,
        run,
        // Every table, which the csv and the pasted table repeat in their own form.
        report: sweepReport.sweepReport(run),
        thin: sweepReport.thinRows(run).length,
        table: sweepReport.formatTable(run),
        csv: sweepReport.toCsv(run),
      };
    }),
  };

  const output = {
    generatedBy: "scripts/parity/generate.mjs",
    parsed,
    propagation,
    grids,
    details,
    stations: [...STATIONS, ...edgeStations],
    passes,
    passEdges,
    presentation,
    countdowns,
    compassPoints,
    greenwichHourAngle: hourAngles,
    visibility: { sunDirections, shadows, verdicts },
    lockCard: { labels: skyCard.VISIBILITY_LABEL, positions: lockPositions },
    weekdayDates,
    // The Satellites list's groups, A to Z as `localeCompare` has them (useSatelliteBrowser.ts).
    groupOrder: GROUP_NAMES.toSorted((a, b) => a.localeCompare(b)),
    bookmarks: { now: BOOKMARK_NOW, summaries, ages, openedLimit: bookmarks.OPENED_LIMIT },
    // Each case is [lodSets index, diameter, current level, level].
    modelLevels: { hysteresis: MODEL_LEVEL_HYSTERESIS, lodSets: LOD_SETS, cases: modelLevels },
    links: { vocabulary, presets: PRESETS, defaults: globalDefaults, fieldKinds, cases: links, sanitized, pixelRatioLadders },
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  fs.writeFileSync(trackingFramesPath, `${JSON.stringify({ generatedBy: "scripts/parity/generate.mjs", frames: trackingFrames }, null, 2)}\n`);
  fs.writeFileSync(frameSummariesPath, `${compactJson({ generatedBy: "scripts/parity/generate.mjs", cases: frameSummaries })}\n`);
  fs.writeFileSync(sweepPath, `${compactJson(sweep)}\n`);

  const tables = {
    generatedBy: "scripts/parity/generate.mjs",
    satcat: {
      launchSite: satcatCodes.SATCAT_LAUNCH_SITE,
      opsStatus: satcatCodes.SATCAT_OPS_STATUS,
      orbitType: satcatCodes.SATCAT_ORBIT_TYPE,
    },
    gcat: { category: gcatCodes.GCAT_CATEGORY, class: gcatCodes.GCAT_CLASS },
    // `{satnum}` stands where the catalog number goes.
    externalLinks: externalLinks("{satnum}"),
    bookmarks: {
      // The parameters the web app's stores own but the viewer's, which a bookmark keeps
      // and the rest of a link carries past it. Read from the stores' urlsync configs:
      // creating the stores here would need the router and the globe.
      ownedParams: ["sat", "cesium"]
        .flatMap((store) => [...fs.readFileSync(path.join(repoRoot, `src/stores/${store}.ts`), "utf8").matchAll(/\burl: "([a-z]+)"/g)].map((match) => match[1]))
        .filter((param) => !VIEWER_PARAMS.has(param)),
    },
  };
  fs.mkdirSync(path.dirname(tablesPath), { recursive: true });
  fs.writeFileSync(tablesPath, `${JSON.stringify(tables, null, 2)}\n`);
  process.stdout.write(`Wrote ${path.relative(repoRoot, outputPath)} (${records.length} records, ${propagation.length} states)\n`);
  process.stdout.write(`Wrote ${path.relative(repoRoot, trackingFramesPath)} (${trackingFrames.length} frames)\n`);
} finally {
  await server.close();
}
