import * as satellitejs from "satellite.js";
import dayjs from "dayjs";

const deg2rad = Math.PI / 180;
const rad2deg = 180 / Math.PI;

export default class Orbit {
  constructor(name, tle) {
    this.name = name;
    this.tle = tle.split("\n");
    this.satrec = satellitejs.twoline2satrec(this.tle[1], this.tle[2]);
  }

  get satnum() {
    return this.satrec.satnum;
  }

  get error() {
    return this.satrec.error;
  }

  get orbitalPeriod() {
    const meanMotionRad = this.satrec.no;
    const period = (2 * Math.PI) / meanMotionRad;
    return period;
  }

  positionECI(time) {
    return satellitejs.propagate(this.satrec, time).position;
  }

  positionECF(time) {
    const positionEci = this.positionECI(time);
    const gmst = satellitejs.gstime(time);
    const positionEcf = satellitejs.eciToEcf(positionEci, gmst);
    return positionEcf;
  }

  positionGeodetic(timestamp, calculateVelocity = false) {
    const { position: positionEci, velocity: velocityVector } = satellitejs.propagate(this.satrec, timestamp);
    const gmst = satellitejs.gstime(timestamp);
    const positionGd = satellitejs.eciToGeodetic(positionEci, gmst);

    return {
      longitude: positionGd.longitude * rad2deg,
      latitude: positionGd.latitude * rad2deg,
      height: positionGd.height * 1000,
      ...(calculateVelocity && {
        velocity: Math.sqrt(velocityVector.x * velocityVector.x +
          velocityVector.y * velocityVector.y +
          velocityVector.z * velocityVector.z),
      }),
    };
  }

  computePassesElevation(
    groundStationPosition,
    startDate = dayjs().toDate(),
    endDate = dayjs(startDate).add(7, "day").toDate(),
    minElevation = 10,
    maxPasses = 50,
  ) {
    const groundStation = { ...groundStationPosition };
    groundStation.latitude *= deg2rad;
    groundStation.longitude *= deg2rad;
    groundStation.height /= 1000;

    const date = new Date(startDate);
    const passes = [];
    let pass = false;
    let ongoingPass = false;
    let lastElevation = 0;
    while (date < endDate) {
      const positionEcf = this.positionECF(date);
      const lookAngles = satellitejs.ecfToLookAngles(groundStation, positionEcf);
      const elevation = lookAngles.elevation / deg2rad;

      if (elevation > minElevation) {
        if (!ongoingPass) {
          // Start of new pass
          pass = {
            name: this.name,
            start: date.getTime(),
            azimuthStart: lookAngles.azimuth,
            maxElevation: elevation,
            azimuthApex: lookAngles.azimuth,
          };
          ongoingPass = true;
        } else if (elevation > pass.maxElevation) {
          // Ongoing pass
          pass.maxElevation = elevation;
          pass.apex = date.getTime();
          pass.azimuthApex = lookAngles.azimuth;
        }
        date.setSeconds(date.getSeconds() + 5);
      } else if (ongoingPass) {
        // End of pass
        pass.end = date.getTime();
        pass.duration = pass.end - pass.start;
        pass.azimuthEnd = lookAngles.azimuth;
        pass.azimuthStart /= deg2rad;
        pass.azimuthApex /= deg2rad;
        pass.azimuthEnd /= deg2rad;
        passes.push(pass);
        if (passes.length > maxPasses) {
          break;
        }
        ongoingPass = false;
        lastElevation = -180;
        date.setMinutes(date.getMinutes() + this.orbitalPeriod * 0.5);
      } else {
        const deltaElevation = elevation - lastElevation;
        lastElevation = elevation;
        if (deltaElevation < 0) {
          date.setMinutes(date.getMinutes() + this.orbitalPeriod * 0.5);
          lastElevation = -180;
        } else if (elevation < -20) {
          date.setMinutes(date.getMinutes() + 5);
        } else if (elevation < -5) {
          date.setMinutes(date.getMinutes() + 1);
        } else if (elevation < -1) {
          date.setSeconds(date.getSeconds() + 5);
        } else {
          date.setSeconds(date.getSeconds() + 2);
        }
      }
    }
    return passes;
  }
}
