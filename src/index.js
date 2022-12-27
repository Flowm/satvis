import satvisSetup from "./app";

const { cc, state } = satvisSetup();

cc.sats.addFromTleUrls([
  // ["data/tle/norad/active.txt", ["Active"]],
  ["data/tle/norad/spire.txt", ["Spire"]],
  ["data/tle/norad/planet.txt", ["Planet"]],
  ["data/tle/norad/starlink.txt", ["Starlink"]],
  ["data/tle/norad/globalstar.txt", ["Globalstar"]],
  ["data/tle/norad/resource.txt", ["Resource"]],
  ["data/tle/norad/science.txt", ["Science"]],
  ["data/tle/norad/stations.txt", ["Stations"]],
  ["data/tle/norad/weather.txt", ["Weather"]],
  ["data/tle/norad/tle-new.txt", ["New"]],
  ["data/tle/ext/move.txt", ["MOVE"]],
]);

window.addEventListener("load", () => {
  if (cc.sats.visibleSatellites.length === 0) {
    state.sat.enabledTags = ["MOVE"];
  }
});
