import { SatelliteEntity } from "./SatelliteEntity";
import { GroundStationEntity } from "./GroundStationEntity";

export class SatelliteManager {
  constructor(viewer) {
    this.viewer = viewer;

    this.satellites = {};
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
    if (satelliteEntity.props.name in this.satellites) {
      console.log(`Satellite ${satelliteEntity.props.name} already exists`);
      return;
    }
    satelliteEntity.createEntities();
    this.satellites[satelliteEntity.props.name] = satelliteEntity;

    if (satelliteEntity.props.tags.some(tag => this.enabledTags.includes(tag))) {
      satelliteEntity.show(this.enabledComponents);
    }
  }

  get satlist() {
    let satlist = Object.values(this.satellites).map((sat) => {
      return {
        id: sat.props.name,
        name: sat.props.name
      }
    });
    if (satlist.length === 0) {
      satlist = [];
    }
    return satlist;
  }

  get enabledSatellites() {
    return Object.values(this.satellites).filter((sat) => sat.enabled).map((sat) => sat.props.name);
  }

  set enabledSatellites(sats) {
    Object.values(this.satellites).forEach((sat) => {
      if (sats.includes(sat.props.name)) {
        sat.show(this.enabledComponents);
      } else {
        sat.hide();
      }
    });
  }

  get enabledSatellitesString() {
    return this.enabledSatellites.join(",");
  }

  set enabledSatellitesString(sats) {
    return this.enabledSatellites = sats.split(",");
  }

  getSatellite(name) {
    if (name in this.satellites) {
      return this.satellites[name];
    }
  }

  get tags() {
    const tags = Object.values(this.satellites).map(sat => sat.props.tags);
    return [...new Set([].concat(...tags))];
  }

  getSatellitesWithTag(tag) {
    return Object.values(this.satellites).filter((sat) => {
      return sat.props.hasTag(tag);
    });
  }

  showSatsWithEnabledTags() {
    Object.values(this.satellites).forEach((sat) => {
      if (this.enabledTags.some(tag => sat.props.hasTag(tag))) {
        sat.show(this.enabledComponents);
      } else {
        sat.hide();
      }
    });
  }

  showTag(tag) {
    this.enabledTags = [...new Set(this.enabledTags.concat(tag))];
    this.showSatsWithEnabledTags();
  }

  hideTag(tag) {
    this.enabledTags = this.enabledTags.filter(enabledTag => enabledTag !== tag);
    this.showSatsWithEnabledTags();
  }

  get components() {
    const components = Object.values(this.satellites).map(sat => sat.components);
    return [...new Set([].concat(...components))];
  }

  showComponent(componentName) {
    var index = this.enabledComponents.indexOf(componentName);
    if (index === -1) this.enabledComponents.push(componentName);

    for (var sat in this.satellites) {
      this.satellites[sat].showComponent(componentName);
    }
  }

  hideComponent(componentName) {
    var index = this.enabledComponents.indexOf(componentName);
    if (index !== -1) this.enabledComponents.splice(index, 1);

    for (var sat in this.satellites) {
      this.satellites[sat].hideComponent(componentName);
    }
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
    for (var sat in this.satellites) {
      this.satellites[sat].groundStation = position;
    }

    // Create groundstation entity
    this.groundStation = new GroundStationEntity(this.viewer, this, position);
    this.groundStation.show();
  }
}
