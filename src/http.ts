import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";

const context = new AsyncLocalStorage<AbortSignal>();
export function operationSignal(): AbortSignal | undefined { return context.getStore(); }
export function checkCancelled(): void { operationSignal()?.throwIfAborted(); }
export async function withBudget<T>(fn: () => Promise<T> | T, signal?: AbortSignal, ms = 45_000): Promise<T> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(new Error("Operation timed out")), ms);
  const abort = () => ac.abort(signal?.reason ?? new Error("Operation cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try { return await context.run(ac.signal, fn); }
  finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}
export async function wait(ms: number): Promise<void> {
  checkCancelled();
  await delay(ms, undefined, { signal: operationSignal() });
}

// truncate: keep the first maxBytes of an oversized body instead of failing.
// Podcast feeds need only their newest items, but popular ones exceed 20MB.
interface HttpOptions { timeoutMs?: number; budgetMs?: number; retries?: number; maxBytes?: number; truncate?: boolean; probe?: boolean; }
// Buffer small API/feed bodies inside the request deadline. Returning fetch's
// raw Response would let a server stall .text()/.json() after headers forever.
export async function request(url: string, init: RequestInit = {}, options: HttpOptions = {}): Promise<Response> {
  const deadline = Date.now() + (options.budgetMs ?? 15_000);
  const method = (init.method ?? "GET").toUpperCase();
  const retries = ["GET", "HEAD"].includes(method) ? options.retries ?? 1 : 0;
  const parent = init.signal ?? operationSignal();
  for (let attempt = 0; ; attempt++) {
    parent?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("HTTP retry budget exhausted");
    const ac = new AbortController();
    const abort = () => ac.abort(parent?.reason ?? new Error("Request cancelled"));
    parent?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => ac.abort(new Error("HTTP request timed out")), Math.min(options.timeoutMs ?? 8_000, remaining));
    let retryDelay = 200 * (attempt + 1);
    try {
      const response = await fetch(url, { ...init, signal: ac.signal });
      if (attempt < retries && [429, 502, 503, 504].includes(response.status)) {
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          retryDelay = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
        }
        await response.body?.cancel();
      } else {
        if (options.probe || method === "HEAD" || [204, 205, 304].includes(response.status)) {
          await response.body?.cancel();
          return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              const limit = options.maxBytes ?? 4 * 1024 * 1024;
              if (size + part.value.length > limit) {
                if (!options.truncate) throw new Error("HTTP response exceeds size limit");
                chunks.push(part.value.subarray(0, limit - size));
                await reader.cancel().catch(() => {});
                break;
              }
              size += part.value.length;
              chunks.push(part.value);
            }
          } catch (e) { await reader.cancel().catch(() => {}); throw e; }
          finally { reader.releaseLock(); }
        }
        return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
      }
    } catch (e) {
      parent?.throwIfAborted();
      if (attempt >= retries) throw e;
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    }
    if (!Number.isFinite(retryDelay) || retryDelay >= deadline - Date.now()) throw new Error("HTTP retry budget exhausted");
    await delay(Math.max(0, retryDelay), undefined, { signal: parent ?? undefined });
  }
}
