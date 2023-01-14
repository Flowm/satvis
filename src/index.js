import satvisSetup from "./app";

const { cc } = satvisSetup({
  sat: {
    enabledTags: ["Weather"],
  },
});

cc.sats.addFromTleUrls([
  ["data/tle/groups/last-30-days.txt", ["New"]],
  ["data/tle/groups/cubesat.txt", ["Cubesat"]],
  ["data/tle/groups/spire.txt", ["Spire"]],
  ["data/tle/groups/planet.txt", ["Planet"]],
  ["data/tle/groups/starlink.txt", ["Starlink"]],
  ["data/tle/groups/oneweb.txt", ["OneWeb"]],
  ["data/tle/groups/globalstar.txt", ["Globalstar"]],
  ["data/tle/groups/resource.txt", ["Resource"]],
  ["data/tle/groups/science.txt", ["Science"]],
  ["data/tle/groups/stations.txt", ["Stations"]],
  ["data/tle/groups/weather.txt", ["Weather"]],
  // ["data/tle/groups/active.txt", ["Active"]],
]);
