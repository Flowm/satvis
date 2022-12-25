import * as Cesium from "@cesium/engine";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

export class DescriptionHelper {
  /** cachedCallbackProperty
   * Caches the results of a callback property to prevent unnecessary recalculation.
   * @param {function} callback - The amount of simulation time to use the calculated result
   * @param {number} updateTreshold - The amount of simulation time to use the calculated result
   * @param {number} usageTreshold - The number of invocations to serve the same result
   */
  static cachedCallbackProperty(callback, updateTreshold = 1, usageTreshold = 1000) {
    let cache;
    return new Cesium.CallbackProperty((time) => {
      if (cache && Cesium.JulianDate.equalsEpsilon(time, cache.time, updateTreshold) && cache.usage < usageTreshold) {
        // console.log("Cached callback", time, cache.usage);
        cache.usage += 1;
        return cache.content;
      }
      const content = callback(time);
      cache = {
        time,
        content,
        usage: 0,
      };
      return content;
    }, false);
  }

  static renderDescription(time, name, position, passes, isGroundStation, tle) {
    const description = `
      <div class="ib">
        <h3>Position</h3>
        <table class="ibt">
          <thead>
            <tr>
              <th>Name</th>
              <th>Latitude</th>
              <th>Longitude</th>
              ${isGroundStation ? "" : "<th>Altitude</th>"}
              ${isGroundStation ? "" : "<th>Velocity</th>"}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>${name}</td>
              <td>${position.latitude.toFixed(2)}&deg</td>
              <td>${position.longitude.toFixed(2)}&deg</td>
              ${isGroundStation ? "" : `<td>${(position.height / 1000).toFixed(2)} km</td>`}
              ${isGroundStation ? "" : `<td>${position.velocity.toFixed(2)} km/s</td>`}
            </tr>
          </tbody>
        </table>
        ${this.renderPasses(passes, time, isGroundStation)}
        ${typeof tle === "undefined" ? "" : this.renderTLE(tle)}
      </div>
    `;
    return description;
  }

  static renderPasses(passes, time, isGroundStation) {
    if (passes.length === 0) {
      if (isGroundStation) {
        return `
          <h3>Passes</h3>
          <div class="ib-text">No passes available</div>
          `;
      }
      return `
        <h3>Passes</h3>
        <div class="ib-text">No ground station set</div>
        `;
    }

    const start = dayjs(time);
    const upcomingPassIdx = passes.findIndex((pass) => dayjs(pass.end).isAfter(start));
    if (upcomingPassIdx < 0) {
      return "";
    }
    const upcomingPasses = passes.slice(upcomingPassIdx);

    const showPassName = isGroundStation;
    const htmlName = showPassName ? "<th>Name</th>\n" : "";
    const html = `
      <h3>Passes</h3>
      <table class="ibt">
        <thead>
          <tr>
            ${htmlName}
            <th>Countdown</th>
            <th>Start</th>
            <th>End</th>
            <th>El</th>
            <th>Az</th>
          </tr>
        </thead>
        <tbody>
          ${upcomingPasses.map((pass) => this.renderPass(start, pass, showPassName)).join("")}
        </tbody>
      </table>
    `;
    return html;
  }

  static renderPass(time, pass, showPassName) {
    function pad2(num) {
      return String(num).padStart(2, "0");
    }
    let countdown = "ONGOING";
    if (dayjs(pass.end).diff(time) < 0) {
      countdown = "PREVIOUS";
    } else if (dayjs(pass.start).diff(time) > 0) {
      countdown = `${pad2(dayjs(pass.start).diff(time, "days"))}:${pad2(dayjs(pass.start).diff(time, "hours") % 24)}:${pad2(dayjs(pass.start).diff(time, "minutes") % 60)}:${pad2(dayjs(pass.start).diff(time, "seconds") % 60)}`;
    }
    const htmlName = showPassName ? `<td>${pass.name}</td>\n` : "";
    const html = `
      <tr>
        ${htmlName}
        <td>${countdown}</td>
        <td>${dayjs(pass.start).format("DD.MM HH:mm:ss")}</td>
        <td>${dayjs(pass.end).format("HH:mm:ss")}</td>
        <td class="ibt-right">${pass.maxElevation.toFixed(0)}&deg</td>
        <td class="ibt-right">${pass.azimuthApex.toFixed(2)}&deg</td>
      </tr>
    `;
    return html;
  }

  static renderTLE(tle) {
    const html = `
      <h3>TLE</h3>
      <div class="ib-code"><code>${tle.slice(1, 3).join("\n")}</code></div>`;
    return html;
  }
}
