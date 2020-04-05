import dayjs from "dayjs";
import Orbit from "../modules/Orbit";

const tle = "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";
const orbit = new Orbit("ISS", tle);
const start = dayjs("2018-12-09");

const positionECI = orbit.positionECI(start.toDate());
const positionECF = orbit.positionGeodetic(start.toDate());
console.log("PositionECI", positionECI);
console.log("PositionECF", positionECF);

const gs = {
  latitude: 48.1770,
  longitude: 11.7476,
  height: 0
};

console.log("Passes");
let passes = orbit.computePassesElevation(gs, start.toDate());
//passes.forEach((pass, i) => {
//  console.log(`Pass ${i} start ${dayjs(pass.start).format()} maxElevation ${pass.maxElevation.toFixed(2)}`);
//});
console.log(passes);
