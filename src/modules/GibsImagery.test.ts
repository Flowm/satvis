import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { gibsFrames, type GibsOptions } from "./GibsImagery";

const GEOCOLOR: GibsOptions = { layer: "GOES-East_ABI_GeoColor", maximumLevel: 7, format: "png", daily: false };
const DOMAIN = "2026-10-04T20:00:00Z/2026-10-04T23:50:00Z/PT10M,2026-10-05T01:00:00Z/2026-10-05T11:20:00Z/PT10M";

const domainResponse = (domain: string) => new Response(`<Domains><DimensionDomain><Domain>${domain}</Domain></DimensionDomain></Domains>`);
const signal = () => new AbortController().signal;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => domainResponse(DOMAIN));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gibsFrames", () => {
  test("lists the frames of the layer's time domain, for its tile set", async () => {
    const ranges = await gibsFrames(GEOCOLOR).fetchRanges(signal());
    expect(fetchMock.mock.calls[0]![0]).toContain("/GOES-East_ABI_GeoColor/default/GoogleMapsCompatible_Level7/all/all.xml");
    expect(ranges).toHaveLength(2);
    expect(ranges!.at(-1)!.end).toBe(Date.parse("2026-10-05T11:20:00Z"));
  });

  test("lists a daily layer's frames without the day GIBS is still imaging", async () => {
    fetchMock.mockResolvedValueOnce(domainResponse("2026-09-01/2026-10-05/P1D"));
    const ranges = await gibsFrames({ ...GEOCOLOR, daily: true }).fetchRanges(signal());
    expect(ranges!.at(-1)!.end).toBe(Date.parse("2026-10-04"));
  });

  test.each([
    ["cannot be reached", () => Promise.reject(new TypeError("offline"))],
    ["refuses", () => Promise.resolve(new Response("", { status: 503 }))],
    ["lists nothing", () => Promise.resolve(domainResponse(""))],
  ])("has no frames when GIBS %s", async (_, answer) => {
    fetchMock.mockImplementationOnce(answer);
    expect(await gibsFrames(GEOCOLOR).fetchRanges(signal())).toBeUndefined();
  });

  test('names a frame as GIBS does, and its latest one "default"', () => {
    const frames = gibsFrames(GEOCOLOR);
    const frame = Date.parse("2026-10-05T09:40:00Z");
    expect(frames.show(frame).dimensions).toEqual({ Time: "2026-10-05T09:40:00Z" });
    expect(frames.show().dimensions).toEqual({ Time: "default" });
    expect(gibsFrames({ ...GEOCOLOR, daily: true }).show(frame).dimensions).toEqual({ Time: "2026-10-05" });
  });
});
