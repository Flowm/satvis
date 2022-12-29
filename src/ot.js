import satvisSetup from "./app";

const { cc } = satvisSetup({
  sat: {
    enabledTags: ["OT"],
    enabledComponents: ["Point", "Label", "Orbit", "SensorCone"],
  },
  cesium: {
    layers: ["ArcGis"],
    qualityPreset: "high",
  },
});

cc.sats.addFromTleUrls([
  ["data/tle/ext/wfs.txt", ["WFS"]],
  ["data/tle/ext/ot.txt", ["OT"]],
  ["data/tle/norad/spire.txt", ["Spire"]],
  ["data/tle/norad/planet.txt", ["Planet"]],
  ["data/tle/norad/globalstar.txt", ["Globalstar"]],
  ["data/tle/norad/transporter-3.txt", ["Transporter-3"]],
]);
