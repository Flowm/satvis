// One HTTP download, for the GP sources and the upstream tables alike. No Cloudflare APIs:
// the scripts import it through node type stripping.

/** Sent with every upstream download, GP sources and tables alike. */
export const USER_AGENT = "satvis.space (https://github.com/Flowm/satvis)";

export type FetchImpl = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponse>;

/** The part of a Response the pipeline reads. */
export interface FetchResponse {
  status: number;
  /**
   * Optional, so a replayed bundle (bundleFetch) can omit it. Only the upstream tables read it, for the ETag.
   */
  headers?: { get: (name: string) => string | null };
  text: () => Promise<string>;
}

/** `ms` covers the request and `read`; exactly one of `value` and `error` is set. */
export type Download<T> = { ms: number } & ({ value: T; error?: undefined } | { value?: undefined; error: string });

/**
 * Never throws. `read` runs before the timer stops, so a body that stalls is aborted
 * too; its error, a DNS, TLS or connection failure, and the timeout all become `error`.
 */
export async function download<T>(
  fetchImpl: FetchImpl,
  url: string,
  options: { timeoutMs: number; headers?: Record<string, string> },
  read: (res: FetchResponse) => Promise<T>,
): Promise<Download<T>> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, ...options.headers }, signal: controller.signal });
    const value = await read(res);
    return { ms: Date.now() - started, value };
  } catch (err) {
    return { ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
