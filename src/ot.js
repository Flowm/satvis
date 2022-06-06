import satvisSetup from "./app";

const { cc } = satvisSetup();

cc.sats.addFromTleUrl("data/tle/ext/wfs.txt", ["WFS"]);
cc.sats.addFromTleUrl("data/tle/ext/wfsf.txt", ["WFSF"]);
cc.sats.addFromTleUrl("data/tle/ext/ot.txt", ["OT"]);
cc.sats.addFromTleUrl("data/tle/norad/spire.txt", ["Spire"]);
cc.sats.addFromTleUrl("data/tle/norad/planet.txt", ["Planet"]);
cc.sats.addFromTleUrl("data/tle/norad/starlink.txt", ["Starlink"]);
cc.sats.addFromTleUrl("data/tle/norad/globalstar.txt", ["Globalstar"]);
cc.sats.addFromTleUrl("data/tle/norad/transporter-3.txt", ["Transporter-3"]);

if (cc.sats.enabledTags.length === 0) {
  cc.sats.enableTag("OT");
  cc.sats.enableComponent("Orbit");
  cc.sats.enableComponent("SensorCone");
  cc.imageryProvider = "ArcGis";
}
