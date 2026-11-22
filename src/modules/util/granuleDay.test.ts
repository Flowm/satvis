import { describe, expect, test } from "vitest";

import { sunElevation, sunlit } from "./granuleDay";

describe("sunElevation", () => {
  test("is the sun's height over the equator at noon at an equinox, and below the horizon at midnight", () => {
    expect(sunElevation({ latitude: 0, longitude: 0 }, Date.parse("2026-03-20T12:07:00Z"))).toBeGreaterThan(89);
    expect(sunElevation({ latitude: 0, longitude: 0 }, Date.parse("2026-03-20T00:07:00Z"))).toBeLessThan(-89);
  });

  test("is the June solstice's noon height at Munich: 90° less its latitude, plus the tilt", () => {
    expect(sunElevation({ latitude: 48.14, longitude: 11.58 }, Date.parse("2026-06-21T11:16:00Z"))).toBeCloseTo(90 - 48.14 + 23.44, 0);
  });
});

describe("sunlit", () => {
  const square = (latitude: number, longitude: number) => [
    { latitude, longitude },
    { latitude, longitude: longitude + 10 },
    { latitude: latitude + 10, longitude: longitude + 10 },
    { latitude: latitude + 10, longitude },
    { latitude, longitude },
  ];

  test("is a granule with the sun up over any corner", () => {
    const noonAtZero = Date.parse("2026-11-21T12:00:00Z");
    expect(sunlit(square(0, 0), noonAtZero, noonAtZero + 600_000)).toBe(true);
    expect(sunlit(square(0, 170), noonAtZero, noonAtZero + 600_000)).toBe(false);
  });
});
