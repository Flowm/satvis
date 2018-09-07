import { SatelliteEntity } from "./SatelliteEntity";

export class SatelliteManager {
  constructor(viewer) {
    this.viewer = viewer;

    this.satellites = {};
    this.availableComponents = [
      "Model",
      "Label",
      "Path",
      "GroundTrack",
      "OrbitTrack",
      "Cone",
    ];
    this.enabledComponents = ["Model"];
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
    }
  }

  hideComponent(componentName) {
    var index = this.enabledComponents.indexOf(componentName);
    if (index !== -1) this.enabledComponents.splice(index, 1);

    for (var sat in this.satellites) {
      this.satellites[sat].hideComponent(componentName);
    }
  }
}
