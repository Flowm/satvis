import { describe, expect, it } from "vitest";

import { download, type FetchImpl, USER_AGENT } from "../src/gp/download.ts";

/** Answers only when its signal aborts, as a stalled connection would. */
const stalled: FetchImpl = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

/** Answers at once, then stalls on the body. */
const stalledBody: FetchImpl = async (url, init) => ({ status: 200, text: () => stalled(url, init).then(() => "") });

const emptyBody: FetchImpl = async () => ({ status: 200, text: async () => "" });

describe("download", () => {
  it("sends the user agent beside the caller's headers", async () => {
    let sent: Record<string, string> | undefined;
    const fetchImpl: FetchImpl = async (_url, init) => {
      sent = init?.headers;
      return { status: 200, text: async () => "ok" };
    };
    const result = await download(fetchImpl, "https://example.test/", { timeoutMs: 1000, headers: { "If-None-Match": '"a"' } }, (res) => res.text());
    expect(result.value).toBe("ok");
    expect(sent).toEqual({ "User-Agent": USER_AGENT, "If-None-Match": '"a"' });
  });

  it("aborts a stalled request after the timeout", async () => {
    const result = await download(stalled, "https://example.test/", { timeoutMs: 10 }, (res) => res.text());
    expect(result).toMatchObject({ error: "timed out after 10ms" });
    expect(result.value).toBeUndefined();
  });

  it("aborts a body that stalls after the headers", async () => {
    const result = await download(stalledBody, "https://example.test/", { timeoutMs: 10 }, (res) => res.text());
    expect(result).toMatchObject({ error: "timed out after 10ms" });
  });

  it("reports a failure in read as the error", async () => {
    const result = await download(emptyBody, "https://example.test/", { timeoutMs: 1000 }, () => Promise.reject(new Error("bad body")));
    expect(result).toMatchObject({ error: "bad body" });
  });
});
