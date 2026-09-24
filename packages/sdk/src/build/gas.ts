import type { Abi, Address } from 'viem'
import { BaseError, ContractFunctionRevertedError } from 'viem'

import type { SnfPublicClient } from '../types/client.types'

/**
 * Dynamic gas estimation for NFT-batch Router writes (R13; 54-SPEC.md). Ported in
 * behaviour, verbatim, from `snf-client/src/hooks/contracts/nftBatchGas.ts` — gas for
 * an NFT batch must be ESTIMATED, not a per-chain constant: Arbitrum One measures
 * ~300k/NFT (L1 calldata billing) against Apechain's ~140k/NFT, so a single literal
 * is wrong on at least one side of that gap in both directions (workspace memory
 * `feedback_nft_gas_dynamic`).
 */

/**
 * Last-resort fallback ONLY for a genuine RPC/network failure (`estimateContractGas`
 * itself could not run) — 300k/NFT + 1.5M overhead clears the worst chain measured.
 * Over-provisioning here is free: gas is a cap the wallet simulates against, the user
 * only pays what is actually consumed.
 */
export function fallbackGasForNFTBatch(tokenCount: number): bigint {
  return BigInt(tokenCount) * 300_000n + 1_500_000n
}

/**
 * True when `error`'s full causal chain (via viem's `BaseError.walk`, not just the
 * outer error's own constructor — `estimateContractGas` wraps a revert inside a
 * `ContractFunctionExecutionError`) contains a `ContractFunctionRevertedError` — i.e.
 * the node actually SIMULATED the call and the contract reverted. This is a genuine
 * on-chain failure, categorically different from an RPC/network failure (timeout,
 * connection refused, rate limit) where the call was never simulated at all.
 */
export function isSimulationRevertError(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false
  return error.walk((e) => e instanceof ContractFunctionRevertedError) !== null
}

export interface EstimateGasWithBufferArgs {
  readonly publicClient: SnfPublicClient
  readonly address: Address
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
  readonly account: Address
  readonly value?: bigint
  readonly tokenCount: number
}

/**
 * Estimates gas for one NFT-batch write, widened by a 25% buffer. Falls back to
 * `fallbackGasForNFTBatch` ONLY on an RPC/network failure. A genuine simulated
 * revert is RE-THROWN, never swallowed — the write is certain to fail on-chain
 * (insufficient allowance, stale tokenIds, an expired deadline, …), and surfacing
 * that through `describeError` BEFORE the wallet popup is strictly better than
 * making the user pay gas for a guaranteed revert.
 */
export async function estimateGasWithBuffer(args: EstimateGasWithBufferArgs): Promise<bigint> {
  try {
    // viem's overload resolution cannot narrow a dynamically-assembled
    // { abi, functionName, args } triple to one specific function signature — the
    // same cast this package's own source analog (snf-client/nftBatchGas.ts) uses
    // for the identical reason.
    const params = {
      address: args.address,
      abi: args.abi,
      functionName: args.functionName,
      args: args.args,
      account: args.account,
      value: args.value,
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    const estimated = await args.publicClient.estimateContractGas(params as any)
    return (estimated * 125n) / 100n
  } catch (e) {
    if (isSimulationRevertError(e)) throw e
    return fallbackGasForNFTBatch(args.tokenCount)
  }
}

export interface ResolvedStepGas {
  readonly gas: bigint
  /** Present ONLY when `gas` is the deterministic NFT-batch fallback because this
   * step's own live simulation was never attempted (see `resolveGasForStep` below) —
   * additive, absent for every other step (a live estimate, or an RPC-failure
   * fallback with no approval blocking it), so existing `Step`/`UnsignedTx` shapes
   * are unaffected. */
  readonly gasSource?: 'fallback-pending-approval'
}

/**
 * `resolveGasForStep` — the missing-approval-aware wrapper every `build*` function
 * calls instead of `estimateGasWithBuffer` directly (Finding 2, snf-54-18-SUMMARY.md;
 * fixed in snf-54-18F). When THIS step's own plan already carries an approval it
 * depends on (the caller has not granted it on-chain yet), the step's swap
 * simulation is GUARANTEED to revert against CURRENT state — attempting it anyway
 * hits `estimateGasWithBuffer`'s own by-design re-throw ("a genuine simulated revert
 * is RE-THROWN, never swallowed") BEFORE the caller ever receives the very
 * `ExecutionPlan` that contains the approval step that would fix it. That inverts the
 * whole point of returning an approval step in the first place.
 *
 * Skip the live estimate entirely in that case — same deterministic
 * `fallbackGasForNFTBatch` this module already uses for a genuine RPC failure,
 * marked `gasSource: 'fallback-pending-approval'` so a caller/observability layer can
 * tell the two fallback reasons apart. When no approval is pending, behavior is
 * byte-for-byte unchanged: a live estimate is attempted and a genuine simulated
 * revert (for a reason OTHER than this exact missing approval — stale tokenIds, an
 * expired deadline, …) still propagates, exactly as before.
 */
export async function resolveGasForStep(
  args: EstimateGasWithBufferArgs & { readonly hasPendingApproval: boolean },
): Promise<ResolvedStepGas> {
  if (args.hasPendingApproval) {
    return { gas: fallbackGasForNFTBatch(args.tokenCount), gasSource: 'fallback-pending-approval' }
  }
  return { gas: await estimateGasWithBuffer(args) }
}
