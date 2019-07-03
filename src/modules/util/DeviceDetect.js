export class DeviceDetect {
  static inIframe() {
    try {
      return window.self !== window.top;
    } catch (e) {
      return true;
    }
  }

  static isIos() {
    const userAgent = window.navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod/.test(userAgent);
  }

  static isSafari() {
    const userAgent = window.navigator.userAgent.toLowerCase();
    return /safari/.test(userAgent);
  }

  static isInStandaloneMode() {
    return ("standalone" in window.navigator) && (window.navigator.standalone);
  }

  static isiPhoneWithNotch() {
    return this.isIos() && /iPhone X/.test(this.getiPhoneModel());
  }

  static isiPhoneWithNotchVisible() {
    return this.isiPhoneWithNotch() && (this.isInStandaloneMode() || !this.isSafari());
  }

  static getiPhoneModel() {
    // Detect iPhone model
    // Based on: https://51degrees.com/blog/website-optimisation-for-apple-devices-ipad-and-iphone
    const ratio = window.devicePixelRatio;
    if (window.screen.height / window.screen.width === 896 / 414) {
      switch (ratio) {
      default:
        return "iPhone XR, iPhone XS Max";
      case 2:
        return "iPhone XR";
      case 3:
        return "iPhone XS Max";
      }
    } else if (window.screen.height / window.screen.width === 812 / 375) {
      return "iPhone X, iPhone XS";
    } else if (window.screen.height / window.screen.width === 736 / 414) {
      return "iPhone 6 Plus, 6s Plus, 7 Plus or 8 Plus";
    } else if (window.screen.height / window.screen.width === 667 / 375) {
      if (ratio === 2) {
        return "iPhone 6, 6s, 7 or 8";
      } else {
        return "iPhone 6 Plus, 6s Plus , 7 Plus or 8 Plus (display zoom)";
      }
    } else if (window.screen.height / window.screen.width === 1.775) {
      return "iPhone 5, 5C, 5S, SE or 6, 6s, 7 and 8 (display zoom)";
    } else if ((window.screen.height / window.screen.width === 1.5) && (ratio === 2)) {
      return "iPhone 4 or 4s";
    } else if ((window.screen.height / window.screen.width === 1.5) && (ratio === 1)) {
      return "iPhone 1, 3G or 3GS";
    } else {
      return "Not an iPhone";
    }
  }
}
