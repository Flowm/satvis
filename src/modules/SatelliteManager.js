import { SatelliteEntityWrapper } from "./SatelliteEntityWrapper";
import { GroundStationEntity } from "./GroundStationEntity";
/* global app */

import { useSatStore } from "../stores/sat";

export class SatelliteManager {
  #enabledComponents;

  #enabledTags;

  constructor(viewer) {
    this.viewer = viewer;

    this.satellites = [];
    this.#enabledComponents = ["Point", "Label"];
    this.#enabledTags = [];

    this.viewer.trackedEntityChanged.addEventListener(() => {
      const trackedSatelliteName = this.trackedSatellite;
      if (trackedSatelliteName) {
        this.getSatellite(trackedSatelliteName).show(this.#enabledComponents);
      }
      if ("app" in window) {
        app.$emit("updateTracked");
      }
    });
  }

  addFromTleUrl(url, tags) {
    fetch(url, {
      mode: "no-cors",
    })
      .then((response) => {
        if (!response.ok) {
          throw Error(response.statusText);
        }
        return response;
      }).then((response) => response.text())
      .then((data) => {
        const lines = data.split(/\r?\n/);
        for (let i = 3; i < lines.length; i + 3) {
          const tle = lines.splice(i - 3, i).join("\n");
          this.addFromTle(tle, tags);
        }
      })
      .catch((error) => {
        console.log(error);
      });
  }

  addFromTle(tle, tags) {
    const sat = new SatelliteEntityWrapper(this.viewer, tle, tags);
    this.add(sat);
  }

  add(newSat) {
    const existingSat = this.satellites.find((sat) => sat.props.satnum === newSat.props.satnum && sat.props.name === newSat.props.name);
    if (existingSat) {
      existingSat.props.addTags(newSat.props.tags);
      if (newSat.props.tags.some((tag) => this.#enabledTags.includes(tag))) {
        existingSat.show(this.#enabledComponents);
      }
      return;
    }
    if (this.groundStationAvailable) {
      newSat.groundStation = this.groundStation.position;
    }
    this.satellites.push(newSat);

    if (newSat.props.tags.some((tag) => this.#enabledTags.includes(tag))) {
      newSat.show(this.#enabledComponents);
      if (this.pendingTrackedSatellite === newSat.props.name) {
        this.trackedSatellite = newSat.props.name;
      }
    }
    const satStore = useSatStore();
    satStore.availableTags = this.tags;
  }

  get taglist() {
    const taglist = {};
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
    let satlist = Object.keys(this.taglist).sort().map((tag) => ({
      name: tag,
      list: this.taglist[tag],
    }));
    if (satlist.length === 0) {
      satlist = [{ name: "", list: [] }];
    }
    return satlist;
  }

  get selectedSatellite() {
    const satellite = this.satellites.find((sat) => sat.isSelected);
    return satellite ? satellite.props.name : "";
  }

  get trackedSatellite() {
    const satellite = this.satellites.find((sat) => sat.isTracked);
    return satellite ? satellite.props.name : "";
  }

  set trackedSatellite(name) {
    if (!name) {
      if (this.trackedSatellite) {
        this.viewer.trackedEntity = undefined;
      }
      return;
    } if (name === this.trackedSatellite) {
      return;
    }

    const sat = this.getSatellite(name);
    if (sat) {
      sat.track();
      this.pendingTrackedSatellite = undefined;
    } else {
      // Satellite does not exist (yet?)
      this.pendingTrackedSatellite = name;
    }
  }

  get enabledSatellites() {
    return this.satellites.filter((sat) => sat.enabled);
  }

  get enabledSatellitesByName() {
    return this.enabledSatellites.map((sat) => sat.props.name);
  }

  set enabledSatellitesByName(sats) {
    this.satellites.forEach((sat) => {
      if (sats.includes(sat.props.name)) {
        sat.show(this.#enabledComponents);
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
        sat.props.notifyPasses();
      } else {
        sat.props.pm.clearTimers();
      }
    });
  }

  get satelliteNames() {
    return this.satellites.map((sat) => sat.props.name);
  }

  getSatellite(name) {
    return this.satellites.find((sat) => sat.props.name === name);
  }

  get tags() {
    const tags = this.satellites.map((sat) => sat.props.tags);
    return [...new Set([].concat(...tags))];
  }

  getSatellitesWithTag(tag) {
    return this.satellites.filter((sat) => sat.props.hasTag(tag));
  }

  showSatsWithEnabledTags() {
    this.satellites.forEach((sat) => {
      if (this.#enabledTags.some((tag) => sat.props.hasTag(tag))) {
        sat.show(this.#enabledComponents);
      } else {
        sat.hide();
      }
    });
  }

  get enabledTags() {
    return this.#enabledTags;
  }

  set enabledTags(newTags) {
    this.#enabledTags = newTags;
    this.showSatsWithEnabledTags();

    const satStore = useSatStore();
    satStore.enabledTags = newTags;
  }

  get components() {
    const components = this.satellites.map((sat) => sat.components);
    return [...new Set([].concat(...components))];
  }

  get enabledComponents() {
    return this.#enabledComponents;
  }

  set enabledComponents(newComponents) {
    const oldComponents = this.#enabledComponents;
    const add = newComponents.filter((x) => !oldComponents.includes(x));
    const del = oldComponents.filter((x) => !newComponents.includes(x));
    add.forEach((component) => {
      this.enableComponent(component);
    });
    del.forEach((component) => {
      this.disableComponent(component);
    });
  }

  enableComponent(componentName) {
    const index = this.#enabledComponents.indexOf(componentName);
    if (index === -1) this.#enabledComponents.push(componentName);

    this.enabledSatellites.forEach((sat) => {
      sat.enableComponent(componentName);
    });
  }

  disableComponent(componentName) {
    const index = this.#enabledComponents.indexOf(componentName);
    if (index !== -1) this.#enabledComponents.splice(index, 1);

    this.enabledSatellites.forEach((sat) => {
      sat.disableComponent(componentName);
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

    // Create groundstation entity
    this.groundStation = new GroundStationEntity(this.viewer, this, position);
    this.groundStation.show();

    // Set groundstation for all satellites
    this.satellites.forEach((sat) => {
      sat.groundStation = this.groundStation.position;
    });

    if ("app" in window) {
      const latlon = `${position.latitude.toFixed(4)},${position.longitude.toFixed(4)}`;
      if (app.$route.query.gs !== latlon) {
        app.$router.push({ query: { ...app.$route.query, gs: latlon } });
      }
    }
  }
}
