import type { Cartesian3, Entity } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

export interface CameraPose {
  destination: Cartesian3;
  direction: Cartesian3;
  up: Cartesian3;
}

/** The tracking flight under way on a viewer, and the clock state it owes back. */
const flights = new WeakMap<Viewer, { clockWasRunning: boolean }>();

/** Whether `trackedEntity` is clear only because a tracking flight is under way. */
export function trackFlightPending(viewer: Viewer): boolean {
  return flights.has(viewer);
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
    }
  };
  viewer.camera.flyTo({ destination: pose.destination, orientation: { direction: pose.direction, up: pose.up }, complete: () => finish(true), cancel: () => finish(false) });
}
