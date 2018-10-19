import { SatelliteEntity } from "./SatelliteEntity";
import { GroundStationEntity } from "./GroundStationEntity";

export class SatelliteManager {
  constructor(viewer) {
    this.viewer = viewer;

    this.satellites = {};
    this.enabledComponents = ["Point", "Label"];
  }

  addFromTleUrl(url) {
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
          this.addFromTle(tle);
        }
      }).catch(function(error) {
        console.log(error);
      });
  }

  addFromTle(tle) {
    const sat = new SatelliteEntity(this.viewer, tle);
    this.add(sat);
  }

  add(satelliteEntity) {
    if (satelliteEntity.name in this.satellites) {
      console.log("Satellite ${satelliteEntity.name} already exists");
      return;
    }
    satelliteEntity.createEntities();
    this.satellites[satelliteEntity.name] = satelliteEntity;

    for (let componentName of this.enabledComponents) {
      satelliteEntity.showComponent(componentName);
    }
  }

  getSatellite(name) {
    if (name in this.satellites) {
      return this.satellites[name];
    }
  }

  show(name) {
    if (name in this.satellites) {
      this.satellites[name].show();
    }
  }

  hide(name) {
    if (name in this.satellites) {
      this.satellites[name].hide();
    }
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
