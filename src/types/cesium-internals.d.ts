// Cesium internals used at runtime but missing from the published `.d.ts`, kept in one file.

declare module "@cesium/widgets" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Viewer {
    /** Absent under `minimalUI`, which is why the accessor guards it. */
    _fullscreenButton?: { _container: HTMLElement };
    /** Holds the credit line and the bottom UI. */
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
