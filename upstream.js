import { randomInt } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

export class WorkerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function requestJson(url, options, signal, { fetcher = fetch, attempts = 3 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    signal.throwIfAborted();
    const controller = AbortSignal.timeout(6000);
    const requestSignal = AbortSignal.any([signal, controller]);
    let response;
    try {
      response = await fetcher(url, { ...options, redirect: "error", signal: requestSignal });
      if (response.ok) return await response.json();
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof TypeError) && !controller.aborted) {
        throw new WorkerError(502, "The upstream returned an invalid response");
      }
    }

    const status = response?.status;
    const retryAfter = response?.headers.get("retry-after");
    await response?.body?.cancel().catch(() => {});
    if (status === 401 || status === 403) {
      throw new WorkerError(502, "The upstream denied access");
    }
    if (status && status !== 429 && ![500, 502, 503, 504].includes(status)) {
      throw new WorkerError(502, "The upstream rejected the request");
    }
    if (attempt + 1 === attempts || [429, 503].includes(status) && retryAfter && !/^\d$/.test(retryAfter)) {
      if (status === 429) throw new WorkerError(503, "The upstream is rate limited");
      if (controller.aborted) throw new WorkerError(504, "The upstream timed out");
      throw new WorkerError(502, "The upstream is temporarily unavailable");
    }
    await wait(Math.max(Number(retryAfter) * 1000 || 0, 400 * 2 ** attempt + randomInt(200)), undefined, { signal });
  }
}

export function resultLimit(value, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new WorkerError(400, `Maximum results must be an integer from 1 to ${max}`);
  }
  return value;
}
