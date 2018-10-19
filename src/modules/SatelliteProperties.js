import { Orbit } from "./Orbit";
import Cesium from "Cesium";

export class SatelliteProperties {
  constructor(clock, tle) {
    this.name = tle.split("\n")[0].trim();
    if (tle.startsWith("0 ")) {
      this.name = this.name.substring(2);
    }

    this.orbit = new Orbit(tle);
    this.clock = clock;

    this.groundStationPosition = undefined;
    this.transits = [];
    this.transitIntervals = new Cesium.TimeIntervalCollection();
  }

  get position() {
    return this.sampledPosition.getValue(this.clock.currentTime);
  }

  get cartographic() {
    return Cesium.Cartographic.fromCartesian(this.position);
  }

  get height() {
    return this.cartographic.height;
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

  createSampledPosition(callback) {
    let lastUpdated;
    lastUpdated = this.updateSampledPosition(this.clock.currentTime);
    this.clock.onTick.addEventListener((clock) => {
      const dt = Math.abs(Cesium.JulianDate.secondsDifference(clock.currentTime, lastUpdated));
      if (dt >= 60 * 15) {
        lastUpdated = this.updateSampledPosition(clock.currentTime);
        callback(this.sampledPosition);
      }
    });
  }

  updateSampledPosition(julianDate, samplesFwd = 150, samplesBwd = 120, interval = 30) {
    const sampledPosition = new Cesium.SampledPositionProperty();
    sampledPosition.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    sampledPosition.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    sampledPosition.setInterpolationOptions({
      interpolationDegree : 2,
      interpolationAlgorithm : Cesium.HermitePolynomialApproximation
    });

    // Spread sampledPosition updates
    const randomOffset = Math.random() * 60 * 15;
    let reference = Cesium.JulianDate.addSeconds(julianDate, randomOffset, new Cesium.JulianDate());

    const startTime = -samplesBwd * interval;
    const stopTime = samplesFwd * interval;
    for (let time = startTime; time <= stopTime; time += interval) {
      const timestamp = Cesium.JulianDate.addSeconds(reference, time, new Cesium.JulianDate());
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

    this.sampledPosition = sampledPosition;
    return reference;
  }

  groundTrack(julianDate, samplesFwd = 0, samplesBwd = 120, interval = 30) {
    const groundTrack = [];

    const startTime = -samplesBwd * interval;
    const stopTime = samplesFwd * interval;
    for (let time = startTime; time <= stopTime; time += interval) {
      const timestamp = Cesium.JulianDate.addSeconds(julianDate, time, new Cesium.JulianDate());
      const position = this.sampledPosition.getValue(timestamp);
      const cartographic = Cesium.Cartographic.fromCartesian(position);
      const groudPosition = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, 1000);
      groundTrack.push(groudPosition);
    }
    return groundTrack;
  }

  updateTransits(start, stop) {
    if (typeof this.groundStationPosition === "undefined") {
      return;
    }

    const latlonalt = [this.groundStationPosition.latitude, this.groundStationPosition.longitude, this.groundStationPosition.height/1000];
    this.transits = this.orbit.computeTransits(
      latlonalt,
      Cesium.JulianDate.toDate(start),
      Cesium.JulianDate.toDate(stop));

    this.updateTransitIntervals();
  }

  updateTransitIntervals() {
    const transitIntervalArray = [];
    for (const transit of this.transits) {
      const startJulian = new Cesium.JulianDate.fromDate(new Date(transit.start));
      const endJulian = new Cesium.JulianDate.fromDate(new Date(transit.end));
      transitIntervalArray.push(new Cesium.TimeInterval({
        start: startJulian,
        stop: endJulian
      }));
    }
    this.transitIntervals = new Cesium.TimeIntervalCollection(transitIntervalArray);
  }
}
