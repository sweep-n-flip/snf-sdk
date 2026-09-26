import { useCallback } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { ExecutionPlan, SnfClient, SnfError } from '@sweepnflip/sdk'
import { useSnfContext } from '../context'

/**
 * Internal wiring shared by the four liquidity build hooks (`useSnfAddLiquidity`,
 * `useSnfCreatePool`, `useSnfRemoveLiquidity`, `useSnfSeed`) — NOT part of this
 * package's public surface (not exported from `hooks/index.ts`/`src/index.ts`).
 * `useMutation`, never `useQuery`: building reads the chain and estimates gas, so
 * it must only run when the partner calls `build(args)` — never on render, never
 * on a timer, never from an effect. The resulting plan is meant for
 * `useSnfCheckout(plan)`, which is the ONE place any of these steps is ever
 * dispatched to a wallet; nothing in this file (or any of its four callers) ever
 * sends a transaction.
 */
export interface UseSnfBuildResult<TArgs> {
  readonly build: (args: TArgs) => Promise<ExecutionPlan>
  readonly plan: ExecutionPlan | undefined
  readonly isBuilding: boolean
  readonly error: SnfError | null
  readonly reset: () => void
}

/**
 * `buildFn` is always one of `SnfClient`'s own `build*` methods, applied with the
 * live client from context — never a caller-supplied function, so every liquidity
 * build hook stays a single-line composition of this wrapper.
 */
export function useSnfBuild<TArgs>(
  buildFn: (client: SnfClient, args: TArgs) => Promise<ExecutionPlan>,
): UseSnfBuildResult<TArgs> {
  const { client } = useSnfContext()

  const mutation = useMutation<ExecutionPlan, SnfError, TArgs>({
    mutationFn: (args: TArgs) => buildFn(client, args),
  })

  // `client.describeError` is idempotent on an `SnfError` (same instance back
  // unchanged), so this never double-wraps a build that already rejected with a
  // proper `SnfError` — it only upgrades a build that didn't. `build()` itself
  // (not just `.error`) rejects with the described error, so a caller's own
  // `try/catch` around `build(args)` sees the same `SnfError` `.error` reports.
  const build = useCallback(
    async (args: TArgs): Promise<ExecutionPlan> => {
      try {
        return await mutation.mutateAsync(args)
      } catch (err) {
        throw client.describeError(err)
      }
    },
    [mutation, client],
  )

  return {
    build,
    plan: mutation.data,
    isBuilding: mutation.isPending,
    error: mutation.error ? client.describeError(mutation.error) : null,
    reset: mutation.reset,
  }
}
