// Augmentations for Cesium widget internals that are used at runtime but not
// exposed in the published `.d.ts`. Restricting these to a single declaration
// file keeps the rest of the codebase honest about what's "real" Cesium API.

declare module "@cesium/widgets" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Viewer {
    /** Absent under `minimalUI`, which is why the accessor guards it. */
    _fullscreenButton?: { _container: HTMLElement };
    /** Container holding the Cesium credit and bottom UI. */
    _bottomContainer: HTMLElement;
  }
}

declare module "@cesium/engine" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Scene {
    /** Drives the component visibility updates. */
    frameState: unknown;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface EntityCluster {
    /** Created with the first label, then kept for the cluster's life. */
    _labelCollection?: LabelCollection;
  }
}
