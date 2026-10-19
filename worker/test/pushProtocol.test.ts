import { describe, expect, it } from "vitest";

import { readReport, reportHeaders } from "../src/gp/pushProtocol.ts";

describe("a table report", () => {
  it("carries a new file's ETag", () => {
    expect(readReport(new Headers(reportHeaders({ ms: 1, status: 200, body: "x", etag: '"a"' })))).toEqual({ etag: '"a"' });
  });

  it("says upstream answered 304", () => {
    expect(readReport(new Headers(reportHeaders({ ms: 1, status: 304, notModified: true })))).toEqual({ notModified: true });
  });

  it("carries a failure as one ASCII line", () => {
    expect(readReport(new Headers(reportHeaders({ ms: 1, error: "reset\nby peer – again" })))).toEqual({ error: "reset?by peer ? again" });
  });
});
