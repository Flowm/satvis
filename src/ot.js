import satvisSetup from "./app";

const { cc } = satvisSetup({
  sat: {
    enabledTags: ["OT"],
    enabledComponents: ["Point", "Label", "Orbit", "Sensor cone"],
  },
  cesium: {
    layers: ["ArcGis"],
  },
});

cc.sats.addFromTleUrls([
  ["data/tle/wfs.txt", ["WFS"]],
  ["data/tle/ot.txt", ["OT"]],
  ["data/tle/groups/spire.txt", ["Spire"]],
  ["data/tle/groups/planet.txt", ["Planet"]],
  ["data/tle/groups/globalstar.txt", ["Globalstar"]],
]);
