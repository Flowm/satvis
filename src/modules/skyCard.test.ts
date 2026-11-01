import { afterEach, describe, expect, test } from "vitest";

import { lockPosition } from "./skyCard";
import { setFormatLocale } from "./util/formats";

afterEach(() => setFormatLocale("en-US"));

describe("lockPosition", () => {
  test("rounds to whole degrees, wrapping north", () => {
    expect(lockPosition(359.6, 47.06, 1540.2).text).toBe("0° N · 47° up · 1,540 km away");
  });

  test.each([
    ["en-US", "38,362"],
    ["en-DE", "38.362"],
    ["en-FR", "38\u202f362"],
  ])("groups the range as %s does", (tag, range) => {
    setFormatLocale(tag);
    expect(lockPosition(178.3, 32.8, 38_362.4).text).toBe(`178° S · 33° up · ${range} km away`);
  });

  test("reads just under the horizon as 0° up, not -0°", () => {
    expect(lockPosition(10, -0.3, 500).text).toBe("10° N · 0° up · 500 km away");
  });

  test("names each angle for a screen reader", () => {
    expect(lockPosition(192.3, 47.06, 412).spoken).toBe("Azimuth 192° SSW, elevation 47°, 412 km away");
  });
});
