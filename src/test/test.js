import dayjs from "dayjs";
import { Orbit } from "../modules/Orbit";

const tle = "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";
const orbit = new Orbit(tle);
const start = dayjs("2018-12-08");
const end = dayjs("2018-12-15");

const positionECI = orbit.positionECI(start.toDate());
const positionECF = orbit.positionGeodetic(start.toDate());
console.log("PositionECI", positionECI);
console.log("PositionECF", positionECF);

const latlonalt = [48.1770, 11.7476, 0];
const passes = orbit.computePasses("ISS", latlonalt, start.toDate(), end.toDate());
console.log("Passes jspredict");
passes.forEach((pass, i) => {
  console.log(`Pass ${i} start ${dayjs(pass.start).format()} maxElevation ${pass.maxElevation.toFixed(2)}`);
});

const gs = {
  latitude: 48.1770 * (Math.PI/180),
  longitude: 11.7476 * (Math.PI/180),
  height: 0
};
