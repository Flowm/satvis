import { SatelliteEntity } from "./SatelliteEntity";

export class SatelliteManager {
  constructor(viewer) {
    this.viewer = viewer;

    this.satellites = {};
    this.availableComponents = [
      "Point",
      "Box",
      "Model",
      "Label",
      "Orbit",
      "Ground",
      "Cone",
    ];
    this.enabledComponents = ["Point", "Label"];
    this.pickerEnabled = false;
  }

  addFromTle(tle) {
    const sat = new SatelliteEntity(this.viewer, tle);
    this.add(sat);
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

  add(satelliteEntity) {
    if (satelliteEntity.name in this.satellites) {
      console.log("Satellite ${satelliteEntity.name} already exists");
      return;
    }
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

  showComponent(componentName) {
    var index = this.enabledComponents.indexOf(componentName);
    if (index === -1) this.enabledComponents.push(componentName);

    for (var sat in this.satellites) {
      this.satellites[sat].showComponent(componentName);
      // XXX: Test
      if (this.groundStationAvailable) {
        this.satellites[sat].orbit.orbit.computeTransits(this.latlonalt);
      }
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

  setGroundStation(position) {
    if (!this.pickerEnabled) {
      return;
    }
    if (this.groundStationAvailable) {
      this.viewer.entities.remove(this.groundStation);
    }

    // Set groundstation for all satellites
    this.latlonalt = [position.lat, position.lon, position.height/1000];
    for (var sat in this.satellites) {
      this.satellites[sat].groundStation = this.latlonalt;
    }

    this.groundStation = {
      id: "Groundstation",
      name: "Groundstation",
      position: new Cesium.Cartesian3.fromDegrees(position.lon, position.lat),
      billboard: {
        image: require("../../node_modules/cesium/Build/Apps/Sandcastle/images/facility.gif"),
      }
    };
    this.viewer.entities.add(this.groundStation);
  }
}
