import * as Cesium from "@cesium/engine";

/** CesiumComponentCollection
  *
  * A wrapper class for Cesium entities and primitives that all belong to a common object being represented.
  * The individual entities or primitives are created on demand and are added
  * to a common entity collection or primitive collection shared between all
  * ComponentCollections.
 */
export class CesiumComponentCollection {
  #components = {};

  constructor(viewer) {
    this.viewer = viewer;
  }

  get components() {
    return this.#components;
  }

  get componentNames() {
    return Object.keys(this.#components);
  }

  get enabledComponents() {
    return Object.values(this.#components).filter((component) => {
      if (component instanceof Cesium.Entity) {
        return this.viewer.entities.contains(component);
      }
      if (component instanceof Cesium.Primitive) {
        return this.viewer.scene.primitives.contains(component);
      }
      return false;
    });
  }

  get created() {
    return this.componentNames.length > 0;
  }

  get enabled() {
    return this.enabledComponents.length > 0;
  }

  show(componentNames = this.componentNames) {
    componentNames.forEach((componentName) => {
      this.enableComponent(componentName);
    });
  }

  hide(componentNames = this.componentNames) {
    componentNames.forEach((componentName) => {
      this.disableComponent(componentName);
    });
  }

  enableComponent(name) {
    if (!(name in this.#components)) {
      return;
    }
    const component = this.#components[name];
    if (component instanceof Cesium.Entity && !this.viewer.entities.contains(component)) {
      this.viewer.entities.add(component);
    } else if (component instanceof Cesium.Primitive && !this.viewer.scene.primitives.contains(component)) {
      this.viewer.scene.primitives.add(component);
    }
  }

  disableComponent(name) {
    if (!(name in this.#components)) {
      return;
    }
    const component = this.#components[name];
    if (component instanceof Cesium.Entity) {
      this.viewer.entities.remove(component);
    } else if (component instanceof Cesium.Primitive) {
      this.viewer.scene.primitives.remove(component);
    }
    delete this.#components[name];
  }

  get isSelected() {
    return Object.values(this.#components).some((entity) => this.viewer.selectedEntity === entity);
  }

  get isTracked() {
    return Object.values(this.#components).some((entity) => this.viewer.trackedEntity === entity);
  }

  track(animate = false) {
    if (!this.defaultEntity) {
      return;
    }
    if (!animate) {
      this.viewer.trackedEntity = this.defaultEntity;
      return;
    }

    this.viewer.trackedEntity = undefined;
    const clockRunning = this.viewer.clock.shouldAnimate;
    this.viewer.clock.shouldAnimate = false;

    this.viewer.flyTo(this.defaultEntity, {
      offset: new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_FOUR, 1580000),
    }).then((result) => {
      if (result) {
        this.viewer.trackedEntity = this.defaultEntity;
        this.viewer.clock.shouldAnimate = clockRunning;
      }
    });
  }

  setSelectedOnTickCallback(onTickCallback = () => {}, onUnselectCallback = () => {}) {
    const onTickEventRemovalCallback = this.viewer.clock.onTick.addEventListener((clock) => {
      onTickCallback(clock);
    });
    const onSelectedEntityChangedRemovalCallback = this.viewer.selectedEntityChanged.addEventListener(() => {
      onTickEventRemovalCallback();
      onSelectedEntityChangedRemovalCallback();
      onUnselectCallback();
    });
  }

  setTrackedOnTickCallback(onTickCallback = () => {}, onUntrackCallback = () => {}) {
    const onTickEventRemovalCallback = this.viewer.clock.onTick.addEventListener((clock) => {
      onTickCallback(clock);
    });
    const onTrackedEntityChangedRemovalCallback = this.viewer.trackedEntityChanged.addEventListener(() => {
      onTickEventRemovalCallback();
      onTrackedEntityChangedRemovalCallback();
      onUntrackCallback();
    });
  }

  artificiallyTrack(onTickCallback = () => {}, onUntrackCallback = () => {}) {
    const cameraTracker = new Cesium.EntityView(this.defaultEntity, this.viewer.scene, this.viewer.scene.globe.ellipsoid);
    this.setTrackedOnTickCallback((clock) => {
      cameraTracker.update(clock.currentTime);
      onTickCallback();
    }, () => {
      onUntrackCallback();
      // Restore default view angle if no new entity is tracked
      if (typeof this.viewer.trackedEntity === "undefined") {
        this.viewer.flyTo(this.defaultEntity, {
          offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-90.0), 2000000),
        });
      }
    });
  }

  createCesiumEntity(componentName, entityKey, entityValue, name, description, position, moving) {
    const entity = new Cesium.Entity({
      name,
      description,
      position,
      viewFrom: new Cesium.Cartesian3(0, -3600000, 4200000),
    });

    if (moving) {
      entity.orientation = new Cesium.VelocityOrientationProperty(position);
    }

    entity[entityKey] = entityValue;
    this.#components[componentName] = entity;
  }
}
