import { Cartesian3, NearFarScalar } from "@cesium/core";
import { BillboardGraphics, Entity, HeightReference, HorizontalOrigin, VerticalOrigin } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import icon from "../images/icons/pin.svg";
import { formatCoordinates } from "./util/formats";

export interface GroundStationPositionData {
  latitude: number;
  longitude: number;
  height: number;
  cartesian: Cartesian3;
}

/** A station's name, or its coordinates to two decimals where it has none. */
export function stationLabel(name: string | undefined, latitude: number, longitude: number): string {
  return name || formatCoordinates(latitude, longitude);
}

/** A named position on the ground, drawn as one pin. */
export class GroundStationEntity {
  readonly #viewer: Viewer;

  readonly #entity: Entity;

  position: GroundStationPositionData;

  givenName: string;

  /** Its place in the store's list, which every station edit and the observer designation name it by. */
  readonly index: number;

  constructor(viewer: Viewer, position: GroundStationPositionData, givenName: string, index: number) {
    this.#viewer = viewer;
    this.position = position;
    this.givenName = givenName;
    this.index = index;

    const billboard = new BillboardGraphics({
      image: icon,
      horizontalOrigin: HorizontalOrigin.CENTER,
      verticalOrigin: VerticalOrigin.BOTTOM,
      // The station's height is 0, so the surface (terrain or a tileset) would bury it.
      heightReference: HeightReference.CLAMP_TO_GROUND,
      // The pin image is 96 px square: about 38 px up close, 21 px from orbit.
      scaleByDistance: new NearFarScalar(1e2, 0.4, 4e7, 0.22),
    });
    this.#entity = new Entity({
      name: this.name,
      position: position.cartesian,
      viewFrom: new Cartesian3(0, -3600000, 4200000),
      billboard,
    });
  }

  show(): void {
    if (!this.#viewer.entities.contains(this.#entity)) {
      this.#viewer.entities.add(this.#entity);
    }
  }

  hide(): void {
    this.#viewer.entities.remove(this.#entity);
  }

  get isSelected(): boolean {
    return this.#viewer.selectedEntity === this.#entity;
  }

  get isTracked(): boolean {
    return this.#viewer.trackedEntity === this.#entity;
  }

  track(): void {
    this.#viewer.trackedEntity = this.#entity;
  }

  /** Editing a station rebuilds every station entity, so a caller re-selects the replacement. */
  select(): void {
    this.#viewer.selectedEntity = this.#entity;
  }

  get name(): string {
    return stationLabel(this.givenName, this.position.latitude, this.position.longitude);
  }
}
