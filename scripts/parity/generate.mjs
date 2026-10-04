#!/usr/bin/env node
// Write the parity fixtures the native app's tests are held to
// (docs/adr/0007-native-ios-app.md): what the web app's own code answers for the
// element sets in parity-input.json. Never edit the output by hand; CI checks that
// rerunning this changes nothing.
//
// The web code is loaded through Vite's module runner, because its imports are
// extensionless TypeScript that plain node cannot resolve.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as satellitejs from "satellite.js";
import { createServer, createServerModuleRunner } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDir = path.join(repoRoot, "ios/SatvisKit/Tests/SatvisCoreTests/Fixtures");
const inputPath = path.join(fixtureDir, "parity-input.json");
const outputPath = path.join(fixtureDir, "parity.json");

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

const server = await createServer({ root: repoRoot, configFile: false, appType: "custom", logLevel: "error", server: { middlewareMode: true, hmr: false } });
try {
  const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
  const gp = await runner.import("/src/modules/util/gp.ts");
  const { greenwichHourAngle } = await runner.import("/src/modules/util/temeToFixed.ts");
  const { sampleInterval, gridAnchorEpochMs } = await runner.import("/src/modules/util/sgp4Worker.ts");

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
      return {
        record: index,
        instant: new Date(instantMs).toISOString(),
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

  const hourAngles = HOUR_ANGLE_INSTANTS.map((instant) => ({ instant, radians: greenwichHourAngle(Date.parse(instant)) }));

  const output = { generatedBy: "scripts/parity/generate.mjs", parsed, propagation, grids, greenwichHourAngle: hourAngles };
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`Wrote ${path.relative(repoRoot, outputPath)} (${records.length} records, ${propagation.length} states)\n`);
} finally {
  await server.close();
}
