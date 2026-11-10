import type { Fetcher, FetchResult } from "./types.js";

const USER_AGENT = "CAS/0.1 (personal job search tool; one request per second, once daily)";

export interface PoliteFetcherOptions {
  minIntervalMs?: number;
  timeoutMs?: number;
  /** Retries for network errors, 429, and 5xx. */
  retries?: number;
  backoffMs?: number;
}

/**
 * Sequential, rate-limited JSON fetcher for public job board APIs.
 * Network errors return status 0 with the error message instead of throwing,
 * so one bad board cannot stop a run.
 */
export function politeFetcher(opts: PoliteFetcherOptions = {}): Fetcher {
  const minInterval = opts.minIntervalMs ?? 1000;
  const timeout = opts.timeoutMs ?? 60000;
  const retries = opts.retries ?? 2;
  const backoff = opts.backoffMs ?? 5000;
  let last = 0;
  let chain: Promise<unknown> = Promise.resolve();

  const once = async (url: string): Promise<FetchResult> => {
    const wait = last + minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } };
      return { status: 0, json: null, error: [err.name, err.message, err.cause?.code ?? err.cause?.message].filter(Boolean).join(": ") };
    } finally {
      last = Date.now();
    }
  };

  const withRetry = async (url: string): Promise<FetchResult> => {
    let r = await once(url);
    for (let i = 0; i < retries && (r.status === 0 || r.status === 429 || r.status >= 500); i++) {
      await sleep(backoff * (i + 1));
      r = await once(url);
    }
    return r;
  };

  return (url: string) => {
    const p = chain.then(() => withRetry(url), () => withRetry(url));
    chain = p;
    return p;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
