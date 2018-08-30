import moment from 'moment'
import * as satellitejs from 'satellite.js'

export class SatelliteOrbit {
  constructor(satelliteTLE) {
    this.tle = satelliteTLE.split('\n');
    this.satrec = satellitejs.twoline2satrec(this.tle[1], this.tle[2]);
  }

  computeGeodeticPosition(timestamp) {
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
      heightInMeters: positionGd.height * 1000,
      velocity
    };
  }

  computeOrbitTrack(timestamp, steps = 120, interval = 1) {
    // Orbit calculation crashes if year is before 1900
    if (timestamp.getFullYear() < 1900) {
      return [];
    }

    var trackArray = [];
    const momentTimestamp = moment(timestamp);
    for (let step = 0; step < steps; step++) {
      const {longitude, latitude, heightInMeters} =
        this.computeGeodeticPosition(momentTimestamp.toDate());
      momentTimestamp.add(interval, 'm');
      trackArray.push(longitude, latitude, heightInMeters);
    }

    return trackArray;
  }
}
