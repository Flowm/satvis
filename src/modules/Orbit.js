import * as satellitejs from "satellite.js";
import * as jspredict from "jspredict-move2";
import dayjs from "dayjs";

export class Orbit {
  constructor(name, tle) {
    this.name = name;
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

  positionECF(time) {
    const positionEci = this.positionECI(time);
    const gmst = satellitejs.gstime(time);
    const positionEcf = satellitejs.eciToEcf(positionEci, gmst);
    return positionEcf;
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

  computePasses(groundStation,
    startDate = dayjs().toDate(),
    endDate = dayjs(startDate).add(7, "day").toDate(),
    minElevation = 4,
    maxPasses = 50) {

    const deg2rad = (Math.PI/180);
    groundStation.latitude *= deg2rad;
    groundStation.longitude *= deg2rad;
    groundStation.height /= 1000;
    minElevation *= deg2rad;
    let date = startDate;
    let passes = []

    let ongoingPass = false;
    let pass = false;
    while (date < endDate) {
      let positionEcf = this.positionECF(date);
      let lookAngles = satellitejs.ecfToLookAngles(groundStation, positionEcf);

      if (lookAngles.elevation > 0) {
        if (!ongoingPass) {
          // Start of new pass
          pass = {
            name: this.name,
            start: date.getTime(),
            azimuthStart: lookAngles.azimuth,
            maxElevation: lookAngles.elevation,
            azimuthApex: lookAngles.azimuth,
          }
          ongoingPass = true;
        } else {
          // Ongoing pass
          if (lookAngles.elevation > pass.maxElevation) {
            pass.maxElevation = lookAngles.elevation;
            pass.azimuthApex = lookAngles.azimuth;
          }
        }
        date.setSeconds(date.getSeconds() + 1);
      } else {
        if (ongoingPass) {
          // End of pass
          if (pass.maxElevation > minElevation) {
            pass.end = date.getTime();
            pass.duration = pass.end - pass.start;
            pass.azimuthEnd = lookAngles.azimuth;
            pass.azimuthStart /= deg2rad;
            pass.azimuthApex /= deg2rad;
            pass.azimuthEnd /= deg2rad;
            pass.maxElevation /= deg2rad;
            passes.push(pass);
            if (passes.length > maxPasses) {
              break;
            }
          }
          ongoingPass = false;
          date.setMinutes(date.getMinutes() + 60);
        } else {
          date.setSeconds(date.getSeconds() + 1);
        }
      }
    }
    return passes;
  }

  computePassesJspredict(groundStation,
    startDate = dayjs().toDate(),
    endDate = dayjs(startDate).add(7, "day").toDate(),
    minElevation = 1,
    maxPasses = 50) {

    if (typeof groundStation === "undefined") {
      return [];
    }
    const latlonalt = [groundStation.latitude, groundStation.longitude, groundStation.height/1000];
    let passes = jspredict.transits(this.tle.join("\n"), latlonalt, startDate, endDate, minElevation, maxPasses);
    passes.map((pass) => {
      pass.name = this.name;
      pass.azimuthApex = pass.apexAzimuth;
      return pass;
    });
    return passes;
  }
}
