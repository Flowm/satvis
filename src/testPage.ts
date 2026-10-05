import dayjs from "dayjs";

import Orbit, { type GroundStationPosition } from "./modules/Orbit";
import { parseGpPayload, type GpRecord } from "./modules/util/gp";

const tle = "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";
const orbit = new Orbit("ISS", parseGpPayload(tle)[0] as GpRecord);
const start = dayjs("2018-12-09");

const positionECI = orbit.positionECI(start.toDate());
const positionECF = orbit.positionGeodetic(start.toDate());
console.log("PositionECI", positionECI);
console.log("PositionECF", positionECF);

const gs: GroundStationPosition = {
  latitude: 48.177,
  longitude: 11.7476,
  height: 0,
};

console.log("Passes");
const passes = orbit.computePassesElevation(gs, start.toDate());
console.log(passes);
