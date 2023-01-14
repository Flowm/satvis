import satvisSetup from "./app";

const { cc } = satvisSetup({
  sat: {
    enabledTags: ["MOVE"],
  },
});

cc.sats.addFromTleUrl("data/tle/custom/move.txt", ["MOVE"]);
