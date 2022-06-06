import satvisSetup from "./app";

const { cc } = satvisSetup();

cc.sats.addFromTleUrl("data/tle/ext/move.txt", ["MOVE"]);

window.addEventListener("load", () => {
  cc.sats.updateStore();
  if (cc.sats.enabledTags.length === 0) {
    cc.sats.enabledTags = ["MOVE"];
  }
});
