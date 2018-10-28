import { SatelliteEntity } from "./SatelliteEntity";
import { GroundStationEntity } from "./GroundStationEntity";

export class SatelliteManager {
  constructor(viewer) {
    this.viewer = viewer;

    this.satellites = [];
    this.enabledComponents = ["Point", "Label"];
    this.enabledTags = [];
  }

  addFromTleUrl(url, tags) {
    fetch(url, {
      mode: "no-cors",
    })
      .then(response => {
        if (!response.ok) {
          throw Error(response.statusText);
        }
        return response;
      }).then(response => response.text())
      .then(data => {
        const tles = data.match(/[\s\S]{168}/g); //.*?\n1.*?\n2.*?\n
        for (var tle of tles) {
          this.addFromTle(tle, tags);
        }
      }).catch(function(error) {
        console.log(error);
      });
  }

  addFromTle(tle, tags) {
    const sat = new SatelliteEntity(this.viewer, tle, tags);
    this.add(sat);
  }

  add(satelliteEntity) {
    if (this.satelliteNames.includes(satelliteEntity.props.name)) {
      console.log(`Satellite ${satelliteEntity.props.name} already exists`);
      return;
    }
    satelliteEntity.createEntities();
    this.satellites.push(satelliteEntity);

    if (satelliteEntity.props.tags.some(tag => this.enabledTags.includes(tag))) {
      satelliteEntity.show(this.enabledComponents);
    }
  }

  get taglist() {
    let taglist = {};
    this.satellites.forEach((sat) => {
      sat.props.tags.forEach((tag) => {
        (taglist[tag] = taglist[tag] || []).push(sat.props.name);
      });
    });
    Object.values(taglist).forEach((tag) => {
      tag.sort();
    });
    return taglist;
  }

  get satlist() {
    let satlist = Object.keys(this.taglist).map((tag) => {
      return {
        name: tag,
        list: this.taglist[tag],
      };
    });
    if (satlist.length === 0) {
      satlist = [{name: "", list: []}];
    }
    return satlist;
  }

  get trackedSatellite() {
    for (let sat of this.satellites) {
      if (sat.isTracked) {
        return sat.props.name;
      }
    }
    return "";
  }

  set trackedSatellite(name) {
    let sat = this.getSatellite(name);
    if (sat) {
      sat.track();
    }
  }

  get enabledSatellites() {
    return this.satellites.filter((sat) => sat.enabled).map((sat) => sat.props.name);
  }

  set enabledSatellites(sats) {
    this.satellites.forEach((sat) => {
      if (sats.includes(sat.props.name)) {
        sat.show(this.enabledComponents);
      } else {
        sat.hide();
      }
    });
  }

  get monitoredSatellites() {
    return this.satellites.filter((sat) => sat.props.pm.active).map((sat) => sat.props.name);
  }

  set monitoredSatellites(sats) {
    this.satellites.forEach((sat) => {
      if (sats.includes(sat.props.name)) {
        sat.props.notifyTransits();
      } else {
        sat.props.pm.clearTimers();
      }
    });
  }

  get satelliteNames() {
    return this.satellites.map((sat) => sat.props.name);
  }

  getSatellite(name) {
    for (let sat of this.satellites) {
      if (sat.props.name === name) {
        return sat;
      }
    }
  }

  get tags() {
    const tags = this.satellites.map(sat => sat.props.tags);
    return [...new Set([].concat(...tags))];
  }

  getSatellitesWithTag(tag) {
    return this.satellites.filter((sat) => {
      return sat.props.hasTag(tag);
    });
  }

  showSatsWithEnabledTags() {
    this.satellites.forEach((sat) => {
      if (this.enabledTags.some(tag => sat.props.hasTag(tag))) {
        sat.show(this.enabledComponents);
      } else {
        sat.hide();
      }
    });
  }

  enableTag(tag) {
    this.enabledTags = [...new Set(this.enabledTags.concat(tag))];
    this.showSatsWithEnabledTags();
  }

  disableTag(tag) {
    this.enabledTags = this.enabledTags.filter(enabledTag => enabledTag !== tag);
    this.showSatsWithEnabledTags();
  }

  get components() {
    const components = this.satellites.map(sat => sat.components);
    return [...new Set([].concat(...components))];
  }

  enableComponent(componentName) {
    var index = this.enabledComponents.indexOf(componentName);
    if (index === -1) this.enabledComponents.push(componentName);

    this.enabledSatellites.forEach((sat) => {
      this.getSatellite(sat).enableComponent(componentName);
    });
  }

  disableComponent(componentName) {
    var index = this.enabledComponents.indexOf(componentName);
    if (index !== -1) this.enabledComponents.splice(index, 1);

    this.enabledSatellites.forEach((sat) => {
      this.getSatellite(sat).disableComponent(componentName);
    });
  }

  get groundStationAvailable() {
    return (typeof this.groundStation !== "undefined");
  }

  focusGroundStation() {
    if (this.groundStationAvailable) {
      this.groundStation.track();
    }
  }

  setGroundStation(position) {
    if (this.groundStationAvailable) {
      this.groundStation.hide();
    }
    if (position.height < 1) {
      position.height = 0;
    }

    // Set groundstation for all satellites
    this.satellites.forEach((sat) => {
      sat.groundStation = position;
    });

    // Create groundstation entity
    this.groundStation = new GroundStationEntity(this.viewer, this, position);
    this.groundStation.show();
  }
}
