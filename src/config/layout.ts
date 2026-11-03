/**
 * CSS pixels under which the screen is a phone's: the menu column starts folded and folds
 * beside a panel, and the entity info panel sits under the top row rather than in the
 * top-right corner. `main.css` and `EntityInfoPanel.vue` repeat it, as a media query cannot
 * read a variable.
 */
export const PHONE_WIDTH = 640;

/**
 * Milliseconds a still finger on the globe holds before its menu opens: iOS's long press.
 * Cesium's own default is 1.5 s.
 */
export const TOUCH_HOLD_MS = 500;
