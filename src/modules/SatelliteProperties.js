import * as Cesium from "@cesium/engine";
import dayjs from "dayjs";
import { useToast } from "vue-toastification";
import Orbit from "./Orbit";
import { PushManager } from "./PushManager";

import satvisIcon from "../assets/android-chrome-192x192.png";

export class SatelliteProperties {
  constructor(tle, tags = []) {
    this.name = tle.split("\n")[0].trim();
    if (tle.startsWith("0 ")) {
      this.name = this.name.substring(2);
    }
    this.orbit = new Orbit(this.name, tle);
    this.satnum = this.orbit.satnum;
    this.tags = tags;

    this.groundStationPosition = undefined;
    this.passes = [];
    this.passInterval = undefined;
    this.passIntervals = new Cesium.TimeIntervalCollection();
    this.pm = new PushManager({
      icon: satvisIcon,
    });
  }

  hasTag(tag) {
    return this.tags.includes(tag);
  }

  addTags(tags) {
    this.tags = [...new Set(this.tags.concat(tags))];
  }

  position(time) {
    return this.sampledPosition.getValue(time);
  }

  computePositionInertial(time, constprop = false) {
    const eci = this.orbit.positionECI(Cesium.JulianDate.toDate(time));
    const position = new Cesium.Cartesian3(eci.x * 1000, eci.y * 1000, eci.z * 1000);
    if (constprop) {
      return new Cesium.ConstantPositionProperty(position, Cesium.ReferenceFrame.INERTIAL);
    }
    return position;
  }

  createSampledPosition(clock, callback) {
    // Determine sampling interval and number of samples based on orbital period
    // For improved performance use 180 sampled positions per orbit
    const samplingInterval = (this.orbit.orbitalPeriod * 60) / 180;
    const samplingRefreshRate = 60 * 15;
    // Propagate a full orbit forward and half an orbit backwards
    const samplesFwd = Math.ceil((this.orbit.orbitalPeriod * 60) / samplingInterval);
    const samplesBwd = Math.ceil(((this.orbit.orbitalPeriod * 60) / 2 + samplingRefreshRate) / samplingInterval);
    // console.log("createSampledPosition", this.name, this.orbit.orbitalPeriod, samplesFwd, samplesBwd, interval);

    let lastUpdated;
    lastUpdated = this.updateSampledPosition(clock.currentTime, samplesFwd, samplesBwd, samplingInterval);
    callback(this.sampledPosition, this.sampledPositionInertial);
    clock.onTick.addEventListener((onTickClock) => {
      const dt = Math.abs(Cesium.JulianDate.secondsDifference(onTickClock.currentTime, lastUpdated));
      if (dt >= samplingRefreshRate) {
        lastUpdated = this.updateSampledPosition(onTickClock.currentTime, samplesFwd, samplesBwd, samplingInterval);
        callback(this.sampledPosition, this.sampledPositionInertial);
      }
    });
  }

  updateSampledPosition(julianDate, samplesFwd = 240, samplesBwd = 120, interval = 30) {
    const sampledPosition = new Cesium.SampledPositionProperty();
    sampledPosition.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    sampledPosition.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    sampledPosition.setInterpolationOptions({
      interpolationDegree: 5,
      interpolationAlgorithm: Cesium.LagrangePolynomialApproximation,
    });

    const sampledPositionInertial = new Cesium.SampledPositionProperty(Cesium.ReferenceFrame.INERTIAL);
    sampledPositionInertial.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    sampledPositionInertial.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    sampledPositionInertial.setInterpolationOptions({
      interpolationDegree: 5,
      interpolationAlgorithm: Cesium.LagrangePolynomialApproximation,
    });

    // Spread sampledPosition updates
    const randomOffset = Math.random() * 60 * 15;
    const reference = Cesium.JulianDate.addSeconds(julianDate, randomOffset, new Cesium.JulianDate());

    const startTime = -samplesBwd * interval;
    const stopTime = samplesFwd * interval;
    for (let time = startTime; time <= stopTime; time += interval) {
      const timestamp = Cesium.JulianDate.addSeconds(reference, time, new Cesium.JulianDate());

      const positionInertialTEME = this.computePositionInertial(timestamp);
      const temeToFixed = Cesium.Transforms.computeTemeToPseudoFixedMatrix(timestamp);
      if (!Cesium.defined(temeToFixed)) {
        console.error("Reference frame transformation data failed to load");
      }
      const positionFixed = new Cesium.Cartesian3();
      Cesium.Matrix3.multiplyByVector(temeToFixed, positionInertialTEME, positionFixed);
      sampledPosition.addSample(timestamp, positionFixed);

      const fixedToIcrf = Cesium.Transforms.computeFixedToIcrfMatrix(timestamp);
      const positionICRF = new Cesium.Cartesian3();
      if (!Cesium.defined(fixedToIcrf)) {
        console.error("Reference frame transformation data failed to load");
      }
      Cesium.Matrix3.multiplyByVector(fixedToIcrf, positionFixed, positionICRF);
      sampledPositionInertial.addSample(timestamp, positionICRF);

      // Show computed sampled position
      // window.cc.viewer.entities.add({
      //  position : positionFixed,
      //  point : {
      //    pixelSize : 8,
      //    color : Cesium.Color.TRANSPARENT,
      //    outlineColor : Cesium.Color.YELLOW,
      //    outlineWidth : 3
      //  }
      // });
    }

    this.sampledPosition = sampledPosition;
    this.sampledPositionInertial = sampledPositionInertial;
    return reference;
  }

  groundTrack(julianDate, samplesFwd = 0, samplesBwd = 120, interval = 30) {
    const groundTrack = [];

    const startTime = -samplesBwd * interval;
    const stopTime = samplesFwd * interval;
    for (let time = startTime; time <= stopTime; time += interval) {
      const timestamp = Cesium.JulianDate.addSeconds(julianDate, time, new Cesium.JulianDate());
      const cartographic = Cesium.Cartographic.fromCartesian(this.position(timestamp));
      const groudPosition = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, 1000);
      groundTrack.push(groudPosition);
    }
    return groundTrack;
  }

  get groundStationAvailable() {
    return (typeof this.groundStationPosition !== "undefined");
  }

  updatePasses(time) {
    if (!this.groundStationAvailable) {
      return false;
    }
    // Check if still inside of current pass interval
    if (typeof this.passInterval !== "undefined" &&
        Cesium.TimeInterval.contains(new Cesium.TimeInterval({ start: this.passInterval.start, stop: this.passInterval.stop }), time)) {
      return false;
    }
    this.passInterval = {
      start: Cesium.JulianDate.addDays(time, -1, Cesium.JulianDate.clone(time)),
      stop: Cesium.JulianDate.addDays(time, 1, Cesium.JulianDate.clone(time)),
      stopPrediction: Cesium.JulianDate.addDays(time, 4, Cesium.JulianDate.clone(time)),
    };

    const passes = this.orbit.computePassesElevation(
      this.groundStationPosition,
      Cesium.JulianDate.toDate(this.passInterval.start),
      Cesium.JulianDate.toDate(this.passInterval.stopPrediction),
    );
    if (!passes) {
      return false;
    }

    this.passes = passes;
    this.computePassIntervals();
    return true;
  }

  clearPasses() {
    this.passInterval = undefined;
    this.passes = [];
    this.passIntervals = new Cesium.TimeIntervalCollection();
  }

  computePassIntervals() {
    const passIntervalArray = this.passes.map((pass) => {
      const startJulian = Cesium.JulianDate.fromDate(new Date(pass.start));
      const endJulian = Cesium.JulianDate.fromDate(new Date(pass.end));
      return new Cesium.TimeInterval({
        start: startJulian,
        stop: endJulian,
      });
    });
    this.passIntervals = new Cesium.TimeIntervalCollection(passIntervalArray);
  }

  notifyPasses(aheadMin = 5) {
    const toast = useToast();

    if (!this.groundStationAvailable) {
      toast.warning("Ground station required to notify for passes");
      return;
    }
    const passes = this.orbit.computePassesElevation(this.groundStationPosition);
    if (!passes) {
      toast.info(`No passes for ${this.name}`);
      return;
    }

    passes.forEach((pass) => {
      const start = dayjs(pass.start).startOf("second");
      this.pm.notifyAtDate(start.subtract(aheadMin, "minute"), `${pass.name} pass in ${aheadMin} minutes`);
      this.pm.notifyAtDate(start, `${pass.name} pass starting now`);
      // this.pm.notifyAtDate(dayjs().add(5, "second"), `${pass.name} test pass in ${aheadMin} minutes`);
    });
    toast.success(`Notifying for ${passes.length} passes of ${this.name}`);
  }
}
