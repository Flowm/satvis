import satvisSetup from "./app";

const { cc, state } = satvisSetup();

cc.sats.addFromTleUrl("data/tle/ext/move.txt", ["MOVE"]);

window.addEventListener("load", () => {
  state.sat.setIfDefault("enabledTags", ["MOVE"]);
});
