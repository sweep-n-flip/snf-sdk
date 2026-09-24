import { buildConfirmLabel } from '../checkout/labels'
import { NEXT_READY_BY_KIND } from '../checkout/reducer'
import { runPreflight } from './preflight'
import type { SnfClientContext } from '../types/client.types'
import type { ExecutionPlan, Step } from '../types/plan.types'

/**
 * `assemblePlan` — the shared final step of every `build*` function. Takes the raw,
 * not-yet-ordered `steps[]` a builder assembled (from
 * `build/approvals.ts`'s `buildApprovalStep` plus its own swap step(s)) and returns
 * the frozen `ExecutionPlan` a partner actually consumes: canonically ordered,
 * chain-stamped, labeled from the one shared vocabulary `checkout/labels.ts` also
 * uses, and carrying a bound `preflight()` closure so a caller never has to thread
 * `ctx` back in to call it.
 */

/**
 * Canonical step ordering: every `'approval'` step precedes every non-approval step,
 * each group's OWN relative order preserved (a stable partition, not a re-sort) — a
 * builder that already emits `[approval(sell)?, swap-sell, swap-buy,
 * swap-buy-wnft?]` gets that exact order back; nothing here re-derives NFT×NFT's
 * leg ordering, it only guarantees approvals never trail behind the swap(s) they
 * unblock. Exported as its own pure function so this module's four `build*` functions
 * share ONE ordering rule instead of four independently-written ones.
 */
export function orderSteps(rawSteps: readonly Step[]): readonly Step[] {
  const approvals = rawSteps.filter((step) => step.kind === 'approval')
  const rest = rawSteps.filter((step) => step.kind !== 'approval')
  return [...approvals, ...rest]
}

/**
 * Assembles the final `ExecutionPlan`. `chainId` is stamped into EVERY step's `tx`
 * from `ctx.chain.chainId` — never inherited implicitly from whatever the caller's
 * `step.tx.chainId` already said (SPEC Constraint: "chainId explícito em toda tx").
 * `label` is likewise always overwritten via `buildConfirmLabel`, keyed by
 * `NEXT_READY_BY_KIND[step.kind]` — the exact same lookup `checkout/reducer.ts` uses
 * to pick the next `ready-*` state, so a partner's button copy and the checkout
 * machine's own state labels can never drift apart from each other.
 *
 * `steps` is never empty by construction: a `build*` function that found nothing
 * missing simply calls this with a one-element array (the swap alone) — this
 * function does not itself guard against an empty input because doing so here would
 * hide a genuine builder bug (an operation that resolved to literally nothing to
 * sign) behind a silent no-op plan.
 */
export function assemblePlan(
  ctx: SnfClientContext,
  steps: readonly Step[],
  expiresAt: string,
): ExecutionPlan {
  const ordered = orderSteps(steps).map((step) =>
    Object.freeze({
      ...step,
      tx: Object.freeze({ ...step.tx, chainId: ctx.chain.chainId }),
      label: buildConfirmLabel(NEXT_READY_BY_KIND[step.kind], step),
    }),
  )
  const frozenSteps = Object.freeze(ordered)

  const plan: ExecutionPlan = Object.freeze({
    chainId: ctx.chain.chainId,
    steps: frozenSteps,
    expiresAt,
    // Closes over `ctx` and `plan` itself — a caller holding only the returned
    // `ExecutionPlan` can call `.preflight()` without ever threading `ctx` back in.
    preflight: () => runPreflight(ctx, plan),
  })
  return plan
}
