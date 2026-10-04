import { Cartesian3, type Camera, type Entity } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

export interface CameraPose {
  destination: Cartesian3;
  direction: Cartesian3;
  up: Cartesian3;
}

/** The tracking flight under way on a viewer, and the clock state it owes back. */
const flights = new WeakMap<Viewer, { clockWasRunning: boolean }>();

/** Where the camera was when tracking began, through any switches since. */
const viewsBeforeTracking = new WeakMap<Viewer, CameraPose>();

function currentView(camera: Camera): CameraPose {
  return { destination: Cartesian3.clone(camera.positionWC), direction: Cartesian3.clone(camera.directionWC), up: Cartesian3.clone(camera.upWC) };
}

function flyTo(viewer: Viewer, pose: CameraPose, callbacks?: { complete: () => void; cancel: () => void }): void {
  viewer.camera.flyTo({ destination: pose.destination, orientation: { direction: pose.direction, up: pose.up }, ...callbacks });
}

/**
 * Fly back to the view tracking began from once it stops, however it began. Not
 * when a tracking flight clears `trackedEntity` on its way to the next one.
 */
export function returnAfterTracking(viewer: Viewer): void {
  viewer.trackedEntityChanged.addEventListener(() => {
    if (viewer.trackedEntity) {
      if (!viewsBeforeTracking.has(viewer)) {
        viewsBeforeTracking.set(viewer, currentView(viewer.camera));
      }
      return;
    }
    const view = viewsBeforeTracking.get(viewer);
    if (view && !flights.has(viewer)) {
      viewsBeforeTracking.delete(viewer);
      flyTo(viewer, view);
    }
  });
}

/**
 * Track `target()`, flying to `pose` first when there is one.
 *
 * The clock holds for the flight, so the entity is still where the pose was taken
 * when it lands. A later call supersedes the flight, and the clock goes back to how
 * the first flight in a chain found it. Anything else setting `trackedEntity`
 * mid-flight cancels it.
 */
export function trackEntity(viewer: Viewer, target: () => Entity | undefined, pose?: CameraPose): void {
  const previous = flights.get(viewer);
  flights.delete(viewer);
  viewer.camera.cancelFlight();
  const clockWasRunning = previous?.clockWasRunning ?? viewer.clock.shouldAnimate;

  if (!pose) {
    viewer.clock.shouldAnimate = clockWasRunning;
    viewer.trackedEntity = target();
    return;
  }

  if (!viewsBeforeTracking.has(viewer)) {
    viewsBeforeTracking.set(viewer, currentView(viewer.camera));
  }
  const flight = { clockWasRunning };
  flights.set(viewer, flight);
  viewer.trackedEntity = undefined;
  viewer.clock.shouldAnimate = false;
  const removeTracked = viewer.trackedEntityChanged.addEventListener(() => viewer.camera.cancelFlight());
  const finish = (landed: boolean) => {
    removeTracked();
    if (flights.get(viewer) !== flight) {
      return;
    }
    flights.delete(viewer);
    viewer.clock.shouldAnimate = flight.clockWasRunning;
    if (landed) {
      viewer.trackedEntity = target();
    } else if (!viewer.trackedEntity) {
      // Cancelled with nothing tracked, so whatever cancelled it has the camera.
      viewsBeforeTracking.delete(viewer);
    }
  };
  flyTo(viewer, pose, { complete: () => finish(true), cancel: () => finish(false) });
}
