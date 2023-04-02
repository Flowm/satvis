// Paste into browser console in a clean session without satellites visible
cc.enablePerformanceStats();
const satelliteTag = "Active";
const satelliteCounts = [0, 10, 50, 100, 500, 1000, 5000];
const componentTests = [
  ["Point"],
  ["Point", "Label"],
  ["Point", "Label", "Orbit"],
  ["Point", "Orbit"],
  // ["Point", "Label", "Orbit", "Orbit track"],
  // ["Point", "Label", "Orbit", "Orbit track", "Ground track", "Sensor cone"],
];

function sleep(s) {
  return new Promise((r) => { setTimeout(r, s * 1000); });
}

async function logPerformance() {
  cc.performanceStats.reset();
  // Wait for performance to settle and stats to be updated
  while (cc.performanceStats.getStats().avgFps === 0) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(1);
  }
  console.log(
    cc.performanceStats.formatStats(),
    `Satellites: ${cc.sats.visibleSatellites.length.toString().padStart(5)}; Components: ${cc.sats.enabledComponents};`,
    `Memory: ${((performance.memory?.usedJSHeapSize || 0) / 1024 / 1024).toFixed(2)};`,
  );
}

async function test() {
  // eslint-disable-next-line no-restricted-syntax
  for (const components of componentTests) {
    // eslint-disable-next-line no-restricted-syntax
    for (const satelliteCount of satelliteCounts) {
      cc.sats.enabledComponents = components;
      cc.sats.enabledSatellites = cc.sats.getSatellitesWithTag(satelliteTag).slice(0, satelliteCount).map((sat) => sat.props.name);
      console.log(cc.sats.enabledSatellites, cc.sats.getSatellitesWithTag(satelliteTag));
      // eslint-disable-next-line no-await-in-loop
      await logPerformance();
    }
    cc.sats.enabledSatellites = [];
  }
}
test();
