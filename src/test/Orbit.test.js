import test from "ava";
import dayjs from "dayjs";
import { Orbit } from "../modules/Orbit";

test.beforeEach(t => {
  const tle = "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";
  t.context.orbit = new Orbit("ISS", tle);
});

test("Can calculate satellite position", t => {
  const orbit = t.context.orbit;
  const time = dayjs("2018-12-01");

  const positionECI = orbit.positionECI(time.toDate());
  //console.log("PositionECI", positionECI);
  t.true(positionECI.x.toFixed(2) == -990.91);
  t.true(positionECI.y.toFixed(2) == -6651.59);
  t.true(positionECI.z.toFixed(2) == -906.03);

  const positionECF = orbit.positionGeodetic(time.toDate());
  //console.log("PositionECF", positionECF);
  t.true(positionECF.longitude.toFixed(2) == -2.67);
  t.true(positionECF.latitude.toFixed(2) == -0.13);
  t.true(positionECF.height.toFixed(2) == 408000.64);
});

test("Can calculate passes", t => {
  const orbit = t.context.orbit;
  const gs = {
    latitude: 48.1770,
    longitude: 11.7476,
    height: 0
  };
  const start = dayjs("2018-12-08");
  const end = dayjs("2018-12-22");

  const passes = orbit.computePassesElevation(gs, start.toDate(), end.toDate(), 1, 500);
  //passes.forEach((pass, i) => {
  //  console.log(`Pass ${i} start ${dayjs(pass.start).format()} maxElevation ${pass.maxElevation.toFixed(2)}`);
  //});
  t.true(passes.length == 87);
});
