import * as satellitejs from "satellite.js";
import * as jspredict from "jspredict-move2";
import dayjs from "dayjs";

export class Orbit {
  constructor(tle) {
    this.tle = tle.split("\n");
    this.satrec = satellitejs.twoline2satrec(this.tle[1], this.tle[2]);
  }

  computeGeodeticPosition(timestamp) {
    const positionEci = satellitejs.propagate(this.satrec, timestamp).position;
    const gmst = satellitejs.gstime(timestamp);
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

  computeTransits(satName,
    groundPosition,
    startDate = new Date(),
    endDate = dayjs(startDate).add(7, "day").toDate(),
    minElevation = 10,
    maxTransits = 50) {
    let transits = jspredict.transits(this.tle.join("\n"), groundPosition, startDate, endDate, minElevation, maxTransits);
    transits.map((transit) => {
      transit.name = satName;
      return transit;
    });
    return transits;
  }
}
