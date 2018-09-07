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
    this.lastPosition = new Cesium.Cartesian3.fromRadians(longitude, latitude, height);
    //console.log(`TS ${julianDate} POS ${this.lastPosition}`);

    return this.lastPosition;
  }

  computeSampledPosition(julianDate, duration = 3600, interval = 30) {
    const sampledPosition = new Cesium.SampledPositionProperty();
    sampledPosition.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    sampledPosition.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    sampledPosition.setInterpolationOptions({
      interpolationDegree : 2,
      interpolationAlgorithm : Cesium.HermitePolynomialApproximation
    });

    for (let time = -duration; time < duration; time += interval) {
      const timestamp = Cesium.JulianDate.addSeconds(julianDate, time, new Cesium.JulianDate());
      const position = this.computePositionCartesian3(timestamp);
      sampledPosition.addSample(timestamp, position);

      // Show computed sampled position
      //viewer.entities.add({
      //  position : position,
      //  point : {
      //    pixelSize : 8,
      //    color : Cesium.Color.TRANSPARENT,
      //    outlineColor : Cesium.Color.YELLOW,
      //    outlineWidth : 3
      //  }
      //});
    }
    return sampledPosition;
  }
}
