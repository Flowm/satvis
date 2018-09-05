import { Orbit } from "./Orbit";
import Cesium from "Cesium";

export class SatelliteOrbit {
  constructor(satelliteTLE) {
    this.orbit = new Orbit(satelliteTLE);
  }

  computeOrbitTrack(julianDate) {
    return this.orbit.computeOrbitTrack(Cesium.JulianDate.toDate(julianDate));
  }

  computePositionCartesian3(julianDate) {
    // Check if Position for current timestap is already computed
    if (typeof this.lastPosition !== "undefined" &&
      this.lastPosition.julianDate === julianDate) {
      return this.lastPosition.position;
    }

    const {longitude, latitude, height} = this.orbit.computeGeodeticPosition(Cesium.JulianDate.toDate(julianDate));
    const position = Cesium.Cartesian3.fromRadians(longitude, latitude, height);

    this.lastPosition = {
      julianDate: julianDate,
      position: position,
    };

    return position;
  }
}
