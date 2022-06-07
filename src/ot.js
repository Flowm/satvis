import satvisSetup from "./app";

const { cc, state } = satvisSetup();

cc.sats.addFromTleUrls([
  ["data/tle/ext/wfs.txt", ["WFS"]],
  ["data/tle/ext/wfsf.txt", ["WFSF"]],
  ["data/tle/ext/ot.txt", ["OT"]],
  ["data/tle/norad/spire.txt", ["Spire"]],
  ["data/tle/norad/planet.txt", ["Planet"]],
  ["data/tle/norad/globalstar.txt", ["Globalstar"]],
  ["data/tle/norad/transporter-3.txt", ["Transporter-3"]],
]);

window.addEventListener("load", () => {
  cc.sats.updateStore();
  if (cc.sats.visibleSatellites.length === 0) {
    state.sat.enabledTags = ["OT"];
    state.sat.enabledComponents = ["Point", "Label", "Orbit", "SensorCone"];
    state.cesium.layers = ["ArcGis"];
  }
});
