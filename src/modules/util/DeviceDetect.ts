export const DeviceDetect = {
  inIframe(): boolean {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  },

  hasTouch(): boolean {
    return window.matchMedia("(pointer: coarse)").matches;
  },

  canHover(): boolean {
    return !window.matchMedia("(hover: none)").matches;
  },

  /** Guarded, unlike its neighbours: jsdom leaves `matchMedia` undefined until a test stubs it. */
  prefersReducedMotion(): boolean {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  },

  /** Shared by createViewer (which widgets exist) and the Sky panel (whether to offer keyboard hints). */
  minimalUI(): boolean {
    return DeviceDetect.inIframe() || DeviceDetect.isIos();
  },

  isIos(): boolean {
    const userAgent = window.navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod/.test(userAgent);
  },
};
