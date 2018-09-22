import { Orbit } from "./Orbit";
import Cesium from "Cesium";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
dayjs.extend(relativeTime);

export class SatelliteOrbit {
  constructor(satelliteTLE, clock) {
    this.orbit = new Orbit(satelliteTLE);
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

    const latlonalt = [this.groundStationPosition.lat, this.groundStationPosition.lon, this.groundStationPosition.alt/1000];
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

  renderTransits(time) {
    if (this.transits.length == 0) {
      return "";
    }

    const start = dayjs(time);
    const upcomingTransitIdx = this.transits.findIndex(transit => {
      return dayjs(transit.end).isAfter(start);
    });
    if (upcomingTransitIdx < 0) {
      return "";
    }
    const upcomingTransits = this.transits.slice(upcomingTransitIdx);

    const html = `
      <table class="ibt">
        <thead>
          <tr>
            <th>Transits</th>
            <th>Start</th>
            <th>End</th>
            <th>El</th>
            <th>Az</th>
          </tr>
        </thead>
        <tbody>
          ${upcomingTransits.map(transit => this.renderTransit(transit, start)).join("")}
        </tbody>
      </table>
    `;
    return html;
  }

  renderTransit(transit, time) {
    function pad2(num) {
      return String(num).padStart(2, "0");
    }
    let timeUntil = "ONGOING";
    if (dayjs(transit.start).diff(time) > 0) {
      timeUntil = `${pad2(dayjs(transit.start).diff(time, "days"))}:${pad2(dayjs(transit.start).diff(time, "hours")%24)}:${pad2(dayjs(transit.start).diff(time, "minutes")%60)}:${pad2(dayjs(transit.start).diff(time, "seconds")%60)}`;
    }
    const html = `
      <tr>
        <td>${timeUntil}</td>
        <td>${dayjs(transit.start).format("DD.MM HH:mm:ss")}</td>
        <td>${dayjs(transit.end).format("HH:mm:ss")}</td>
        <td class="ibt-right">${transit.maxElevation.toFixed(0)}&deg</td>
        <td class="ibt-right">${transit.minAzimuth.toFixed(2)}&deg</td>
      </tr>
    `;
    return html;
  }
}
