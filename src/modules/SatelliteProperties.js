import Cesium from "Cesium";
import dayjs from "dayjs";
import { Orbit } from "./Orbit";
import { PushManager } from "./PushManager";

export class SatelliteProperties {
  constructor(tle, tags = []) {
    this.name = tle.split("\n")[0].trim();
    if (tle.startsWith("0 ")) {
      this.name = this.name.substring(2);
    }
    this.orbit = new Orbit(tle);
    this.tags = tags;

    this.groundStationPosition = undefined;
    this.passes = [];
    this.passInterval = undefined;
    this.passIntervals = new Cesium.TimeIntervalCollection();
    this.pm = new PushManager({
      icon: require("../assets/android-chrome-192x192.png"),
    });
  }

  hasTag(tag) {
    return this.tags.includes(tag);
  }

  position(time) {
    return this.sampledPosition.getValue(time);
  }

  positionCartographic(time) {
    return Cesium.Cartographic.fromCartesian(this.position(time));
  }

  positionCartographicDegrees(time) {
    const cartographic = this.positionCartographic(time);
    const cartographicDegrees = {
      longitude: Cesium.Math.toDegrees(cartographic.longitude),
      latitude: Cesium.Math.toDegrees(cartographic.latitude),
      height: cartographic.height,
    };
    return cartographicDegrees;
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

  createSampledPosition(clock, callback) {
    let lastUpdated;
    lastUpdated = this.updateSampledPosition(clock.currentTime);
    clock.onTick.addEventListener((clock) => {
      const dt = Math.abs(Cesium.JulianDate.secondsDifference(clock.currentTime, lastUpdated));
      if (dt >= 60 * 15) {
        lastUpdated = this.updateSampledPosition(clock.currentTime);
        callback(this.sampledPosition);
      }
    });
  }

  updateSampledPosition(julianDate, samplesFwd = 240, samplesBwd = 120, interval = 30) {
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
      const cartographic = this.positionCartographic(timestamp);
      const groudPosition = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, 1000);
      groundTrack.push(groudPosition);
    }
    return groundTrack;
  }

  updatePasses(time, updateCallback = ()=>{}) {
    if (typeof this.groundStationPosition === "undefined") {
      return false;
    }
    // Check if still inside of current pass interval
    if (typeof this.passInterval !== "undefined" &&
        Cesium.TimeInterval.contains(new Cesium.TimeInterval({start: this.passInterval.start, stop: this.passInterval.stop}), time)) {
      return false;
    }
    this.passInterval = {
      start: new Cesium.JulianDate.addDays(time, -1, Cesium.JulianDate.clone(time)),
      stop: new Cesium.JulianDate.addDays(time, 1, Cesium.JulianDate.clone(time)),
      stopPrediction: new Cesium.JulianDate.addDays(time, 3, Cesium.JulianDate.clone(time)),
    };

    let passes = this.computePasses(Cesium.JulianDate.toDate(this.passInterval.start), Cesium.JulianDate.toDate(this.passInterval.stopPrediction));
    if (passes) {
      this.passes = passes;
      this.computePassIntervals();
      updateCallback();
    }

    return true;
  }

  clearPasses() {
    this.passInterval = undefined;
    this.passes = [];
    this.passIntervals = new Cesium.TimeIntervalCollection();
  }

  computePasses(start, stop) {
    if (typeof this.groundStationPosition === "undefined") {
      return false;
    }

    const latlonalt = [this.groundStationPosition.latitude, this.groundStationPosition.longitude, this.groundStationPosition.height/1000];
    return this.orbit.computePasses(
      this.name,
      latlonalt,
      start,
      stop
    );
  }

  computePassIntervals() {
    const passIntervalArray = [];
    for (const pass of this.passes) {
      const startJulian = new Cesium.JulianDate.fromDate(new Date(pass.start));
      const endJulian = new Cesium.JulianDate.fromDate(new Date(pass.end));
      passIntervalArray.push(new Cesium.TimeInterval({
        start: startJulian,
        stop: endJulian
      }));
    }
    this.passIntervals = new Cesium.TimeIntervalCollection(passIntervalArray);
  }

  notifyPasses(aheadMin = 5) {
    let passes = this.computePasses(dayjs().toDate(), dayjs().add(7, "day").toDate());
    if (!passes) {
      return;
    }

    passes.forEach((pass) => {
      let start = dayjs(pass.start).startOf("second");
      this.pm.notifyAtDate(start.subtract(aheadMin, "minute"), `${pass.name} pass in ${aheadMin} minutes`);
      this.pm.notifyAtDate(start, `${pass.name} pass starting now`);
      //this.pm.notifyAtDate(dayjs().add(5, "second"), `${pass.name} test pass in ${aheadMin} minutes`);
    });
  }
}
