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
    if (typeof this.lastPosition !== "undefined" && Cesium.JulianDate.compare(this.lastDate, julianDate) == 0) {
      return this.lastPosition;
    }

    this.lastDate = julianDate;
    const {longitude, latitude, height} = this.orbit.computeGeodeticPosition(Cesium.JulianDate.toDate(julianDate));
    this.lastPosition = Cesium.Cartesian3.fromRadians(longitude, latitude, height);

    return this.lastPosition;
  }
}
