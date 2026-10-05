interface PropertyBag {
  [key: string]: unknown;
}

interface PostHogEventLike {
  properties: PropertyBag;
  $set?: PropertyBag;
  $set_once?: PropertyBag;
}

const GROUND_STATION_PARAMETER = /([?&]gs=)([^&#]*)/g;
const DECIMAL_NUMBER = /([+-]?)(\d*)\.\d+/g;

function stripDecimalPlaces(_decimal: string, sign: string, integer: string): string {
  return `${sign}${integer || "0"}`;
}

function sanitizeGroundStationParameter(_match: string, prefix: string, value: string): string {
  return `${prefix}${value.replace(DECIMAL_NUMBER, stripDecimalPlaces)}`;
}

/** Remove sub-degree precision from ground stations without changing the browser URL. */
export function sanitizePostHogUrl(url: string): string {
  return url.replace(GROUND_STATION_PARAMETER, sanitizeGroundStationParameter);
}

function sanitizePropertyBag(bag: PropertyBag | undefined): void {
  if (!bag) {
    return;
  }
  for (const [key, value] of Object.entries(bag)) {
    if (typeof value === "string" && GROUND_STATION_PARAMETER.test(value)) {
      bag[key] = sanitizePostHogUrl(value);
    }
    GROUND_STATION_PARAMETER.lastIndex = 0;
  }
}

/** PostHog `before_send` hook. */
export function sanitizePostHogEvent<T extends PostHogEventLike>(event: T): T {
  sanitizePropertyBag(event.properties);
  sanitizePropertyBag(event.$set);
  sanitizePropertyBag(event.$set_once);
  return event;
}
