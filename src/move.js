import satvisSetup from "./app";

const { app, cc } = satvisSetup();

cc.sats.addFromTleUrl("data/tle/ext/move.txt", ["MOVE"]);
if (cc.sats.enabledTags.length === 0) {
  cc.sats.enableTag("MOVE");
}
