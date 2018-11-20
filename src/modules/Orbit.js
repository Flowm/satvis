import * as satellitejs from "satellite.js";
import * as jspredict from "jspredict-move2";
import dayjs from "dayjs";

export class Orbit {
  constructor(tle) {
    this.tle = tle.split("\n");
    this.satrec = satellitejs.twoline2satrec(this.tle[1], this.tle[2]);
  }

  get satnum() {
    return this.satrec.satnum;
  }

  get orbitalPeriod() {
    const meanMotionRad = this.satrec.no;
    const period = 2 * Math.PI / meanMotionRad;
    return period;
  }

  positionECI(time) {
    return satellitejs.propagate(this.satrec, time).position;
  }

  positionGeodetic(time) {
    const positionEci = this.positionECI(time);
    const gmst = satellitejs.gstime(time);
    const positionGd = satellitejs.eciToGeodetic(positionEci, gmst);

    return {
      longitude: positionGd.longitude,
      latitude: positionGd.latitude,
      height: positionGd.height * 1000,
    };
  }

  computeGeodeticPositionVelocity(timestamp) {
    const positionAndVelocity = satellitejs.propagate(this.satrec, timestamp);
    const positionEci = positionAndVelocity.position;
    const velocityEci = positionAndVelocity.velocity;

    const gmst = satellitejs.gstime(timestamp);
    const positionGd = satellitejs.eciToGeodetic(positionEci, gmst);
    const velocityGd = satellitejs.eciToGeodetic(velocityEci, gmst);
    const velocity = Math.sqrt(velocityGd.longitude * velocityGd.longitude +
      velocityGd.latitude * velocityGd.latitude +
      velocityGd.height * velocityGd.height);

    return {
      longitude: positionGd.longitude,
      latitude: positionGd.latitude,
      height: positionGd.height * 1000,
      velocity
    };
  }

  computePasses(satName,
    groundPosition,
    startDate = new Date(),
    endDate = dayjs(startDate).add(7, "day").toDate(),
    minElevation = 10,
    maxPasses = 50) {
    let passes = jspredict.transits(this.tle.join("\n"), groundPosition, startDate, endDate, minElevation, maxPasses);
    passes.map((pass) => {
      pass.name = satName;
      return pass;
    });
    return passes;
  }
}
