// Cesium-free, shared by the url schema and CesiumController. "Sky" renders in 3D, so the
// store and `viewer.scene.mode` disagree there; SCENE3D tests use Cesium's enum (ADR 0003).
// No `SceneMode` alias: @cesium/engine exports an enum of that name.

export const SCENE_MODES = ["3D", "2D", "Columbus", "Sky"] as const;
export const CAMERA_MODES = ["Fixed", "Inertial"] as const;

/** The one scene mode that is not a Cesium projection. */
export const SKY_MODE = "Sky";
