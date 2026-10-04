// The satellite components a user can switch on independently. Kept here, free
// of Cesium, because both SatelliteManager (which renders them) and the URL
// codec (which resolves legacy hyphen-escaped names against this list) need it.
//
// Order is the order they appear in the toolbar.
export const SATELLITE_COMPONENTS = ["Point", "Label", "Orbit", "Orbit track", "Ground track", "Sensor cone", "3D model", "Ground station link"] as const;
