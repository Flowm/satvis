/**
 * CSS pixels under which the screen is a phone's: the menu column starts folded and folds
 * beside a panel, and the entity info panel sits under the top row rather than in the
 * top-right corner. `main.css` and `EntityInfoPanel.vue` repeat it, as a media query cannot
 * read a variable.
 */
export const PHONE_WIDTH = 640;

/** Whether the window is known to be a phone's. A hidden tab can report a width of 0. */
export const isPhoneWidth = (): boolean => window.innerWidth > 0 && window.innerWidth < PHONE_WIDTH;

/**
 * Milliseconds a still finger on the globe holds before its menu opens: iOS's long press.
 * Cesium's own default is 1.5 s.
 */
export const TOUCH_HOLD_MS = 500;
