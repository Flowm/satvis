export class DeviceDetect {
  static inIframe(): boolean {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  }

  static hasTouch(): boolean {
    return window.matchMedia("(pointer: coarse)").matches;
  }

  static canHover(): boolean {
    return !window.matchMedia("(hover: none)").matches;
  }

  /** Guarded, unlike its neighbours: jsdom leaves `matchMedia` undefined until a test stubs it. */
  static prefersReducedMotion(): boolean {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }

  /** Shared by createViewer (which widgets exist) and the Sky panel (whether to offer keyboard hints). */
  static minimalUI(): boolean {
    return this.inIframe() || this.isIos();
  }

  static isIos(): boolean {
    const userAgent = window.navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod/.test(userAgent);
  }
}
