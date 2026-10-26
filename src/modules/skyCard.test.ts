import { describe, expect, test } from "vitest";

import { lockPosition } from "./skyCard";

describe("lockPosition", () => {
  test("rounds to whole degrees, wrapping north", () => {
    expect(lockPosition(359.6, 47.06, 1540.2).text).toBe("0° N · 47° up · 1,540 km away");
  });

  test("groups as en-US whatever the locale", () => {
    expect(lockPosition(178.3, 32.8, 38_362.4).text).toBe("178° S · 33° up · 38,362 km away");
  });

  test("names each angle for a screen reader", () => {
    expect(lockPosition(192.3, 47.06, 412).spoken).toBe("Azimuth 192° SSW, elevation 47°, 412 km away");
  });
});
