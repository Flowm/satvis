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
  ["data/tle/custom/wfs.txt", ["WFS"]],
  ["data/tle/custom/ot.txt", ["OT"]],
  ["data/tle/groups/spire.txt", ["Spire"]],
  ["data/tle/groups/planet.txt", ["Planet"]],
  ["data/tle/groups/globalstar.txt", ["Globalstar"]],
]);
