import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
dayjs.extend(relativeTime);

export class DescriptionHelper {
  static renderDescription(time, name, position, transits) {
    let description = `
      <div class="ib">
        <h3>Position</h3>
        <table class="ibt">
          <thead>
            <tr>
              <th>Name</th>
              <th>Latitude</th>
              <th>Longitude</th>
              <th>Elevation</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>${name}</td>
              <td>${position.latitude.toFixed(2)}&deg</td>
              <td>${position.longitude.toFixed(2)}&deg</td>
              <td>${(position.height / 1000).toFixed(2)} km</td>
            </tr>
          </tbody>
        </table>
        ${this.renderTransits(transits, time)}
      </div>
    `;
    return description;
  }

  static renderTransits(transits, time) {
    if (transits.length == 0) {
      return "";
    }

    const start = dayjs(time);
    const upcomingTransitIdx = transits.findIndex(transit => {
      return dayjs(transit.end).isAfter(start);
    });
    if (upcomingTransitIdx < 0) {
      return "";
    }
    const upcomingTransits = transits.slice(upcomingTransitIdx);

    const htmlName = transits[0].name ? "<th>Name</th>\n" : "";
    const html = `
      <h3>Transits</h3>
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
          ${upcomingTransits.map(transit => this.renderTransit(start, transit)).join("")}
        </tbody>
      </table>
    `;
    return html;
  }

  static renderTransit(time, transit) {
    function pad2(num) {
      return String(num).padStart(2, "0");
    }
    let timeUntil = "ONGOING";
    if (dayjs(transit.start).diff(time) > 0) {
      timeUntil = `${pad2(dayjs(transit.start).diff(time, "days"))}:${pad2(dayjs(transit.start).diff(time, "hours")%24)}:${pad2(dayjs(transit.start).diff(time, "minutes")%60)}:${pad2(dayjs(transit.start).diff(time, "seconds")%60)}`;
    }
    const htmlName = transit.name ? `<td>${transit.name}</td>\n` : "";
    const html = `
      <tr>
        ${htmlName}
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
