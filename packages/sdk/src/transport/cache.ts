/**
 * `TtlCache` — TTL + stale-while-revalidate + single-flight in-flight dedupe, entirely
 * instance-scoped (no mutable `let`/`Map` at module scope — this class
 * IS the state that rule requires to live inside `createSnfClient`, never at module scope).
 * `local/no-module-global-state` only bans mutable state at Program (module top-level)
 * scope, so these `Map`s as private class fields — constructed fresh per
 * `new TtlCache()` call, one per `createSubgraphTransport()` instance — are exactly the
 * sanctioned shape.
 */

interface TtlCacheEntry {
  readonly value: unknown
  readonly expiresAt: number
  readonly swrExpiresAt: number
}

export interface TtlCacheOptions {
  readonly now?: () => number
  readonly onRevalidateError?: (key: string, err: unknown) => void
}

export interface TtlCacheGetOptions {
  readonly ttlMs: number
  readonly swrMs: number
}

export interface TtlCacheGetResult<T> {
  readonly value: T
  readonly revalidating: boolean
}

export class TtlCache {
  private readonly entries = new Map<string, TtlCacheEntry>()
  private readonly inFlight = new Map<string, Promise<unknown>>()
  private readonly now: () => number
  private readonly onRevalidateError: ((key: string, err: unknown) => void) | undefined

  constructor(opts: TtlCacheOptions = {}) {
    this.now = opts.now ?? Date.now
    this.onRevalidateError = opts.onRevalidateError
  }

  get size(): number {
    return this.entries.size
  }

  peek<T>(key: string): T | undefined {
    const entry = this.entries.get(key)
    return entry === undefined ? undefined : (entry.value as T)
  }

  set<T>(key: string, value: T, opts: TtlCacheGetOptions): void {
    const now = this.now()
    this.entries.set(key, {
      value,
      expiresAt: now + opts.ttlMs,
      swrExpiresAt: now + opts.ttlMs + opts.swrMs,
    })
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
    this.inFlight.clear()
  }

  /**
   * Inside `ttlMs`: returns the cached value, never calls `loader`. Past `ttlMs` but
   * inside `ttlMs + swrMs`: returns the cached value immediately with
   * `revalidating: true` and fires exactly one background `loader` call (a concurrent
   * `get` during that window observes the same in-flight background call and does not
   * trigger a second one). Past both: dedupes concurrent callers onto a single
   * `loader` call via `inFlight` — 50 synchronous calls with a cold cache invoke
   * `loader` exactly once.
   */
  get<T>(key: string, loader: () => Promise<T>, opts: TtlCacheGetOptions): Promise<TtlCacheGetResult<T>> {
    const now = this.now()
    const entry = this.entries.get(key)

    if (entry !== undefined && now < entry.expiresAt) {
      return Promise.resolve({ value: entry.value as T, revalidating: false })
    }

    if (entry !== undefined && now < entry.swrExpiresAt) {
      if (!this.inFlight.has(key)) {
        const revalidation = this.load(key, loader, opts)
        revalidation.catch((err: unknown) => this.onRevalidateError?.(key, err))
      }
      return Promise.resolve({ value: entry.value as T, revalidating: true })
    }

    const existing = this.inFlight.get(key)
    if (existing !== undefined) {
      return existing.then((value) => ({ value: value as T, revalidating: false }))
    }

    return this.load(key, loader, opts).then((value) => ({ value, revalidating: false }))
  }

  /**
   * Calls `loader()` immediately — synchronously, from the caller's perspective — so
   * 50 concurrent callers all observe the SAME in-flight promise before any of them
   * awaits anything. Writes the result to the cache on success. Always removes itself
   * from `inFlight` in a `finally`, so a rejection can never pin a dead promise there;
   * a background (SWR) rejection is routed to `onRevalidateError` by the caller in
   * `get()` above and never poisons the still-served stale value.
   */
  private load<T>(key: string, loader: () => Promise<T>, opts: TtlCacheGetOptions): Promise<T> {
    const promise = loader().then((value) => {
      this.set(key, value, opts)
      return value
    })
    this.inFlight.set(key, promise)
    promise
      .catch(() => {
        // Handled here so this internal reference is never an unhandled rejection —
        // the real propagation is the caller's own `await` above, or
        // `onRevalidateError` for a background call.
      })
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key)
      })
    return promise
  }
}
