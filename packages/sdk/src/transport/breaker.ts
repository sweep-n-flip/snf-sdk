import { SnfError } from '../errors'
import type { BreakerState } from './subgraph.types'

export interface CircuitBreakerOptions {
  readonly threshold?: number
  readonly cooldownMs?: number
  readonly now?: () => number
}

/**
 * `N` consecutive failures open the circuit for `cooldownMs`; the open state issues NO
 * request at all — the whole point of a breaker over a client-side retry loop
 *. After the cooldown it half-opens for exactly one probe: success closes
 * it, failure re-opens it for another full `cooldownMs`. Entirely instance-scoped
 * — never a module-level breaker shared across two clients (this rule's multi-page
 * test).
 */
export class CircuitBreaker {
  private readonly threshold: number
  private readonly cooldownMs: number
  private readonly now: () => number
  private stateValue: BreakerState = 'closed'
  private failures = 0
  private openedAt = 0
  /** Guards the half-open window so two overlapping calls right after the cooldown
   * elapses can't both slip through as "the one probe" — only the first wins. */
  private probing = false

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.threshold ?? 3
    this.cooldownMs = opts.cooldownMs ?? 60_000
    this.now = opts.now ?? Date.now
  }

  /** `'open'` only while inside `cooldownMs`; past it, reads as `'half-open'` without
   * mutating internal state — `exec` is what actually consumes the one allowed probe. */
  get state(): BreakerState {
    if (this.stateValue === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
      return 'half-open'
    }
    return this.stateValue
  }

  /** Resets to `closed` with a zeroed failure count — test-only escape hatch. */
  reset(): void {
    this.stateValue = 'closed'
    this.failures = 0
    this.openedAt = 0
    this.probing = false
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.state

    if (current === 'open' || (current === 'half-open' && this.probing)) {
      throw new SnfError('UPSTREAM_DEGRADED', 'Circuit breaker open — upstream is degraded.', {
        details: {
          state: current,
          failures: this.failures,
          retryAfterMs: Math.max(0, this.cooldownMs - (this.now() - this.openedAt)),
        },
      })
    }

    if (current === 'half-open') this.probing = true
    try {
      const result = await fn()
      this.stateValue = 'closed'
      this.failures = 0
      return result
    } catch (err) {
      this.failures += 1
      if (current === 'half-open' || this.failures >= this.threshold) {
        this.stateValue = 'open'
        this.openedAt = this.now()
      }
      throw err
    } finally {
      this.probing = false
    }
  }
}
