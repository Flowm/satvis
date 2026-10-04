#!/usr/bin/env node
// Write the parity fixtures the native app's tests are held to
// (docs/adr/0007-native-ios-app.md): what the web app's own code answers for the
// element sets in parity-input.json. Also write the tables the native app reads
// as they are rather than keeping a copy of its own: the SATCAT code labels and
// the external links. Never edit either output by hand; CI checks that rerunning
// this changes nothing.
//
// The web code is loaded through Vite's module runner, because its imports are
// extensionless TypeScript that plain node cannot resolve.

// `Orbit` steps its pass search with Date.setMinutes, which works in local time.
process.env.TZ = "UTC";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as satellitejs from "satellite.js";
import { createServer, createServerModuleRunner } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDir = path.join(repoRoot, "ios/SatvisKit/Tests/SatvisCoreTests/Fixtures");
const inputPath = path.join(fixtureDir, "parity-input.json");
const outputPath = path.join(fixtureDir, "parity.json");
const tablesPath = path.join(repoRoot, "ios/SatvisKit/Sources/SatvisCore/Shared/web-tables.json");

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

// No dependency scan: nothing here is served to a browser, and on a cold cache the
// scan reports errors for entry points this script never loads.
const server = await createServer({
  root: repoRoot,
  configFile: false,
  appType: "custom",
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false },
});
try {
  const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
  const gp = await runner.import("/src/modules/util/gp.ts");
  const { greenwichHourAngle } = await runner.import("/src/modules/util/temeToFixed.ts");
  const { sampleInterval, gridAnchorEpochMs } = await runner.import("/src/modules/util/sgp4Worker.ts");
  const { default: Orbit } = await runner.import("/src/modules/Orbit.ts");
  const entityInfo = await runner.import("/src/modules/util/entityInfo.ts");
  const satcatCodes = await runner.import("/src/config/satcatCodes.ts");
  const { externalLinks } = await runner.import("/src/config/externalLinks.ts");

  const input = fs.readFileSync(inputPath, "utf8");
  const records = gp.parseGpPayload(input);

  const parsed = records.map((record) => ({
    name: gp.recordName(record),
    satnum: gp.recordSatnum(record),
    orbitClass: record.metadata.orbitClass,
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
      // The info panel's live strip.
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
    const chunk = sampleInterval(satrec, parsed[index].satnum, now - 0.5 * periodMs, now + 1.5 * periodMs);
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

  // The info panel's Details tab: derived, curated and SATCAT facts, then the
  // element set as the panel shows it.
  const details = records.map((record, index) => {
    const orbit = new Orbit(parsed[index].name, record);
    return { facts: entityInfo.getSatelliteInfo(orbit, record.metadata.orbitClass, record.metadata), elements: entityInfo.getElementsInfo(orbit) };
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
    const own = swathExtentsOf(record.metadata);
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

  // How the info panel presents a pass list: the table's rows, the headline's
  // summary, the countdown, and the timeline strip, an hour into the window.
  const { JulianDate } = await runner.import("@cesium/engine");
  const passPredictor = await runner.import("/src/modules/PassPredictor.ts");
  const { passTimelineLayout } = await runner.import("/src/modules/util/passTimeline.ts");
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
  const compassPoints = [-11.25, 0, 11.24, 11.25, 33.75, 180, 348.75, 359.99, 371.25].map((azimuth) => ({ azimuth, point: passPredictor.compassPoint(azimuth) }));

  const hourAngles = HOUR_ANGLE_INSTANTS.map((instant) => ({ instant, radians: greenwichHourAngle(Date.parse(instant)) }));

  const output = {
    generatedBy: "scripts/parity/generate.mjs",
    parsed,
    propagation,
    grids,
    details,
    stations: STATIONS,
    passes,
    presentation,
    countdowns,
    compassPoints,
    greenwichHourAngle: hourAngles,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

  const tables = {
    generatedBy: "scripts/parity/generate.mjs",
    satcat: {
      owner: satcatCodes.SATCAT_OWNER,
      launchSite: satcatCodes.SATCAT_LAUNCH_SITE,
      opsStatus: satcatCodes.SATCAT_OPS_STATUS,
      orbitType: satcatCodes.SATCAT_ORBIT_TYPE,
    },
    // `{satnum}` stands where the catalog number goes.
    externalLinks: externalLinks("{satnum}"),
  };
  fs.mkdirSync(path.dirname(tablesPath), { recursive: true });
  fs.writeFileSync(tablesPath, `${JSON.stringify(tables, null, 2)}\n`);
  process.stdout.write(`Wrote ${path.relative(repoRoot, outputPath)} (${records.length} records, ${propagation.length} states)\n`);
} finally {
  await server.close();
}
