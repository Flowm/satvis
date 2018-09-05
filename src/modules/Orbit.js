import moment from "moment";
import * as satellitejs from "satellite.js";

export class Orbit {
  constructor(satelliteTLE) {
    this.tle = satelliteTLE.split("\n");
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

  computeOrbitTrack(timestamp, steps = 120, interval = 1) {
    // Check if track for current timestap is already computed
    if (typeof this.lastTrack !== "undefined" &&
        this.lastTrack.steps >= steps &&
        this.lastTrack.interval == interval &&
        this.lastTrack.timestamp.getTime() === timestamp.getTime()) {
      return this.lastTrack.orbitTrack;
    }

    // Orbit calculation crashes for years before 1900
    if (timestamp.getFullYear() < 1900) {
      return [];
    }

    var orbitTrack = [];
    const momentTimestamp = moment(timestamp);
    for (let step = 0; step < steps; step++) {
      const {longitude, latitude, height} = this.computeGeodeticPosition(momentTimestamp.toDate());
      momentTimestamp.add(interval, "m");
      orbitTrack.push(longitude, latitude, height);
    }
    if (orbitTrack.length < 3) {
      console.log("Error in satellite orbit calculation");
      return [0, 0, 0];
    }

    this.lastTrack = {
      timestamp: timestamp,
      steps: steps,
      interval: interval,
      orbitTrack: orbitTrack,
    };

    return orbitTrack;
  }
}
