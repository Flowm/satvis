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
  vi.useFakeTimers({ now: Date.parse("2026-10-05T12:00:00Z") });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const AROUND = Date.parse("2026-10-05T11:37:00Z");

describe("gibsFrames", () => {
  test("lists a day either side of the clock, on the hour, for the layer's tile set", async () => {
    const listed = await gibsFrames(GEOCOLOR).fetchRanges(signal(), AROUND);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toContain("/GOES-East_ABI_GeoColor/default/GoogleMapsCompatible_Level7/all/2026-10-04T11:00:00Z--2026-10-06T11:00:00Z.xml");
    expect(listed!.covers).toEqual({ start: Date.parse("2026-10-04T11:00:00Z"), end: Date.parse("2026-10-06T11:00:00Z") });
    expect(listed!.ranges).toHaveLength(2);
    expect(listed!.ranges.at(-1)!.end).toBe(Date.parse("2026-10-05T11:20:00Z"));
  });

  test("lists every frame of a layer with none that near, as one that ended", async () => {
    fetchMock.mockResolvedValueOnce(domainResponse(""));
    const listed = await gibsFrames(GEOCOLOR).fetchRanges(signal(), AROUND);
    expect(fetchMock.mock.calls[1]![0]).toContain("/all/all.xml");
    expect(listed).toEqual({ ranges: expect.any(Array) });
  });

  test.each([
    ["the day GIBS is still imaging", "2026-10-05", "2026-10-04"],
    // Its last swaths arrive hours into the next day.
    ["yesterday, while today is not listed yet", "2026-10-04", "2026-10-03"],
  ])("lists all of a daily layer's frames, without %s", async (_, latest, shown) => {
    fetchMock.mockResolvedValueOnce(domainResponse(`2026-09-01/${latest}/P1D`));
    const listed = await gibsFrames({ ...GEOCOLOR, daily: true }).fetchRanges(signal(), AROUND);
    expect(fetchMock.mock.calls[0]![0]).toContain("/all/all.xml");
    expect(listed!.ranges.at(-1)!.end).toBe(Date.parse(shown));
  });

  test("keeps the last day of a daily layer that ended", async () => {
    fetchMock.mockResolvedValueOnce(domainResponse("2000-02-24/2022-10-12/P1D"));
    const listed = await gibsFrames({ ...GEOCOLOR, daily: true }).fetchRanges(signal(), AROUND);
    expect(listed!.ranges.at(-1)!.end).toBe(Date.parse("2022-10-12"));
  });

  test.each([
    ["cannot be reached", () => Promise.reject(new TypeError("offline")), 1],
    ["refuses", () => Promise.resolve(new Response("", { status: 503 })), 1],
    // Then the whole list is asked for, which lists nothing either.
    ["lists nothing", () => Promise.resolve(domainResponse("")), 2],
  ])("has no frames when GIBS %s, and asks for the whole list only when the day around the clock has none", async (_, answer, asked) => {
    fetchMock.mockImplementation(answer);
    expect(await gibsFrames(GEOCOLOR).fetchRanges(signal(), AROUND)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(asked);
  });

  test('names a frame as GIBS does, and its latest one "default"', () => {
    const frames = gibsFrames(GEOCOLOR);
    const frame = Date.parse("2026-10-05T09:40:00Z");
    expect(frames.show(frame).dimensions).toEqual({ Time: "2026-10-05T09:40:00Z" });
    expect(frames.show().dimensions).toEqual({ Time: "default" });
    const daily = gibsFrames({ ...GEOCOLOR, daily: true });
    expect(daily.show(frame).dimensions).toEqual({ Time: "2026-10-05" });
    // Without its list a daily layer shows yesterday, not the day still filling in.
    expect(daily.show().dimensions).toEqual({ Time: "2026-10-04" });
  });
});
