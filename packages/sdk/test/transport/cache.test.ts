import { describe, expect, it, vi } from 'vitest'

import { CircuitBreaker } from '../../src/transport/breaker'
import { TtlCache } from '../../src/transport/cache'

/** A fully manual, injectable clock — never `vi.useFakeTimers`, so cases never leak
 * fake-timer state across each other (both classes accept an injectable `now()` per
 * the plan's own `<behavior>` requirement). */
function makeClock(start = 0) {
  let time = start
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms
    },
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (err: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Flushes every microtask queued so far (a macrotask boundary) — used instead of
 * `vi.waitFor` to keep this file free of anything but the injected clock. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('TtlCache', () => {
  it('never shares an entry between two instances', () => {
    const a = new TtlCache()
    const b = new TtlCache()
    a.set('k', 'value-a', { ttlMs: 1000, swrMs: 1000 })
    expect(a.peek('k')).toBe('value-a')
    expect(b.peek('k')).toBeUndefined()
  })

  it('50 concurrent get() calls with the same key invoke the loader exactly once, and all resolve to the same value', async () => {
    const clock = makeClock()
    const cache = new TtlCache({ now: clock.now })
    const loader = vi.fn(async () => {
      await Promise.resolve()
      return { value: 42 }
    })

    const calls = Array.from({ length: 50 }, () => cache.get('k', loader, { ttlMs: 1000, swrMs: 1000 }))
    const results = await Promise.all(calls)

    expect(loader).toHaveBeenCalledTimes(1)
    expect(results).toHaveLength(50)
    for (const result of results) {
      expect(result.value.value).toBe(42)
      expect(result.revalidating).toBe(false)
    }
  })

  it('inside the TTL, get returns the cached value and never calls the loader again', async () => {
    const clock = makeClock()
    const cache = new TtlCache({ now: clock.now })
    const loader = vi.fn(async () => 'v1')

    await cache.get('k', loader, { ttlMs: 1000, swrMs: 1000 })
    clock.advance(500)
    const second = await cache.get('k', loader, { ttlMs: 1000, swrMs: 1000 })

    expect(loader).toHaveBeenCalledTimes(1)
    expect(second.value).toBe('v1')
    expect(second.revalidating).toBe(false)
  })

  it('past ttlMs but inside swrMs: returns the stale value immediately, revalidating:true, and triggers exactly one background loader call', async () => {
    const clock = makeClock()
    const cache = new TtlCache({ now: clock.now })
    let loaderCalls = 0
    const gate = deferred<string>()
    const loader = vi.fn(() => {
      loaderCalls += 1
      return loaderCalls === 1 ? Promise.resolve('v1') : gate.promise
    })

    await cache.get('k', loader, { ttlMs: 1000, swrMs: 5000 })
    clock.advance(1500) // past ttlMs, inside swrMs

    const second = await cache.get('k', loader, { ttlMs: 1000, swrMs: 5000 })
    expect(second.value).toBe('v1')
    expect(second.revalidating).toBe(true)

    // A second get() during the same background window does not trigger a second call.
    const third = await cache.get('k', loader, { ttlMs: 1000, swrMs: 5000 })
    expect(third.revalidating).toBe(true)

    expect(loader).toHaveBeenCalledTimes(2) // 1 initial + exactly 1 background revalidation
    gate.resolve('v2')
    await flush()
  })

  it('a background revalidation rejection never poisons the cache and is surfaced to onRevalidateError, never thrown into the caller', async () => {
    const clock = makeClock()
    const onRevalidateError = vi.fn()
    const cache = new TtlCache({ now: clock.now, onRevalidateError })
    let loaderCalls = 0
    const gate = deferred<string>()
    const loader = vi.fn(() => {
      loaderCalls += 1
      return loaderCalls === 1 ? Promise.resolve('v1') : gate.promise
    })

    await cache.get('k', loader, { ttlMs: 1000, swrMs: 5000 })
    clock.advance(1500)

    const second = await cache.get('k', loader, { ttlMs: 1000, swrMs: 5000 })
    expect(second.value).toBe('v1') // stale value still served, no throw
    expect(second.revalidating).toBe(true)

    gate.reject(new Error('revalidation failed'))
    await flush()
    await flush()

    expect(onRevalidateError).toHaveBeenCalledTimes(1)
    expect(onRevalidateError).toHaveBeenCalledWith('k', expect.any(Error))

    // The cache is not poisoned: a later call in the same window still serves v1.
    const third = await cache.get('k', loader, { ttlMs: 1000, swrMs: 5000 })
    expect(third.value).toBe('v1')
  })

  it('size/delete/clear behave as expected and clear() also drops any in-flight bookkeeping', () => {
    const cache = new TtlCache()
    cache.set('a', 1, { ttlMs: 1000, swrMs: 1000 })
    cache.set('b', 2, { ttlMs: 1000, swrMs: 1000 })
    expect(cache.size).toBe(2)

    cache.delete('a')
    expect(cache.size).toBe(1)
    expect(cache.peek('a')).toBeUndefined()
    expect(cache.peek('b')).toBe(2)

    cache.clear()
    expect(cache.size).toBe(0)
  })

  it('accepts an injectable now() so tests control time without vi.useFakeTimers', async () => {
    const clock = makeClock(1_000_000)
    const cache = new TtlCache({ now: clock.now })
    const loader = vi.fn(async () => 'v')

    await cache.get('k', loader, { ttlMs: 100, swrMs: 100 })
    clock.advance(50) // still inside ttlMs relative to the injected clock
    const stillFresh = await cache.get('k', loader, { ttlMs: 100, swrMs: 100 })

    expect(stillFresh.value).toBe('v')
    expect(loader).toHaveBeenCalledTimes(1)
  })
})

describe('CircuitBreaker', () => {
  it('passes fn through while closed', async () => {
    const breaker = new CircuitBreaker()
    const result = await breaker.exec(async () => 'ok')
    expect(result).toBe('ok')
    expect(breaker.state).toBe('closed')
  })

  it('opens after `threshold` consecutive rejections; the next exec rejects UPSTREAM_DEGRADED without invoking fn', async () => {
    const clock = makeClock()
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 60_000, now: clock.now })
    const failing = vi.fn(async () => {
      throw new Error('boom')
    })

    for (let i = 0; i < 3; i++) {
      await expect(breaker.exec(failing)).rejects.toThrow()
    }
    expect(breaker.state).toBe('open')
    failing.mockClear()

    await expect(breaker.exec(failing)).rejects.toMatchObject({ code: 'UPSTREAM_DEGRADED' })
    expect(failing).not.toHaveBeenCalled()
  })

  it('one success while closed resets the consecutive-failure counter to 0', async () => {
    const clock = makeClock()
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 60_000, now: clock.now })
    const failing = async (): Promise<never> => {
      throw new Error('boom')
    }
    const succeeding = async () => 'ok'

    await expect(breaker.exec(failing)).rejects.toThrow()
    await expect(breaker.exec(failing)).rejects.toThrow()
    await breaker.exec(succeeding) // resets the counter to 0
    await expect(breaker.exec(failing)).rejects.toThrow()
    await expect(breaker.exec(failing)).rejects.toThrow()

    // Only 2 consecutive failures since the reset — still closed, never reached 3.
    expect(breaker.state).toBe('closed')
  })

  it('half-opens after cooldownMs and allows exactly one probe; success closes the breaker', async () => {
    const clock = makeClock()
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000, now: clock.now })

    await expect(
      breaker.exec(async (): Promise<never> => {
        throw new Error('boom')
      }),
    ).rejects.toThrow()
    expect(breaker.state).toBe('open')

    clock.advance(60_000)
    expect(breaker.state).toBe('half-open')

    const probe = vi.fn(async () => 'recovered')
    const result = await breaker.exec(probe)
    expect(result).toBe('recovered')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(breaker.state).toBe('closed')
  })

  it('re-opens for another full cooldownMs when the half-open probe fails', async () => {
    const clock = makeClock()
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000, now: clock.now })

    await expect(
      breaker.exec(async (): Promise<never> => {
        throw new Error('boom')
      }),
    ).rejects.toThrow()
    clock.advance(60_000)

    await expect(
      breaker.exec(async (): Promise<never> => {
        throw new Error('probe failed')
      }),
    ).rejects.toThrow()
    expect(breaker.state).toBe('open')

    clock.advance(59_999)
    expect(breaker.state).toBe('open')
    clock.advance(1)
    expect(breaker.state).toBe('half-open')
  })

  it('takes an injectable now() so cooldown timing is controlled without vi.useFakeTimers', () => {
    const clock = makeClock(500_000)
    const breaker = new CircuitBreaker({ now: clock.now, cooldownMs: 1000 })
    expect(breaker.state).toBe('closed')
  })
})
