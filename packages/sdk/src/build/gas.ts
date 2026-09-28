import type { Abi, Address, Hex } from 'viem'
import { BaseError, ContractFunctionRevertedError } from 'viem'

import type { SnfPublicClient } from '../types/client.types'

/**
 * Dynamic gas estimation for NFT-batch Router writes. Ported in
 * behaviour, verbatim, from the production AMM client's own gas-estimation hook — gas for
 * an NFT batch must be ESTIMATED, not a per-chain constant: Arbitrum One measures
 * ~300k/NFT (L1 calldata billing) against Apechain's ~140k/NFT, so a single literal
 * is wrong on at least one side of that gap in both directions.
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

/**
 * A first-time create deposits into a Router that has to deploy the pair — and, if
 * this is the collection's first pool at all, the wrapper too — inline in the same
 * transaction. Fork-measured on Base: `Factory.createPair` (discrete) ~2,029,281 gas,
 * `Factory.createWrapper` ~992,647 gas; rounded up here. Plain per-NFT gas alone
 * badly under-provisions this case.
 */
export const PAIR_CREATION_GAS = 2_100_000n
export const WRAPPER_CREATION_GAS = 1_000_000n

export interface CreationOverheadGasArgs {
  readonly createsPair: boolean
  readonly createsWrapper: boolean
}

/** The extra gas a deposit needs on top of `fallbackGasForNFTBatch` when this SAME
 * transaction is also what creates the pair and/or the wrapper — `0n` for a plain
 * add into an already-existing pool. */
export function creationOverheadGas(args: CreationOverheadGasArgs): bigint {
  let overhead = 0n
  if (args.createsPair) overhead += PAIR_CREATION_GAS
  if (args.createsWrapper) overhead += WRAPPER_CREATION_GAS
  return overhead
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
  /**
   * A later addition: added to the deterministic NFT-batch fallback ONLY — never to
   * a live estimate. A liquidity deposit whose OWN transaction creates the pair
   * and/or wrapper needs this on top of the plain per-NFT fallback; every other
   * caller omits it (defaults to `0n`) and behaves exactly as before.
   */
  readonly extraFallbackGas?: bigint
  /**
   * The ERC-8021 attribution suffix `assemblePlan` will append to this step's calldata
   * — estimated ON the suffixed calldata so the gas limit covers the bytes actually
   * sent. Absent: plain calldata, exactly as before.
   */
  readonly dataSuffix?: Hex | undefined
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
    // same cast this package's own source analog (the production client's gas hook) uses
    // for the identical reason.
    const params = {
      address: args.address,
      abi: args.abi,
      functionName: args.functionName,
      args: args.args,
      account: args.account,
      value: args.value,
      ...(args.dataSuffix !== undefined ? { dataSuffix: args.dataSuffix } : {}),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    const estimated = await args.publicClient.estimateContractGas(params as any)
    return (estimated * 125n) / 100n
  } catch (e) {
    if (isSimulationRevertError(e)) throw e
    return fallbackGasForNFTBatch(args.tokenCount) + (args.extraFallbackGas ?? 0n)
  }
}

export interface ResolvedStepGas {
  readonly gas: bigint
  /** Present ONLY when `gas` is the deterministic NFT-batch fallback because this
   * step's own live simulation was never attempted (see `resolveGasForStep` below) —
   * additive, absent for every other step (a live estimate, or an RPC-failure
   * fallback with no approval blocking it), so existing `Step`/`UnsignedTx` shapes
   * are unaffected. `'fallback-pending-step'` (a later addition): this step depends
   * on an EARLIER, still-unconfirmed step of the SAME plan rather than on its own
   * pending approval — a multi-step liquidity plan (e.g. a seed split across several
   * add steps) needs to tell the two reasons apart. */
  readonly gasSource?: 'fallback-pending-approval' | 'fallback-pending-step'
}

/**
 * `resolveGasForStep` — the missing-approval-aware wrapper every `build*` function
 * calls instead of `estimateGasWithBuffer` directly (Finding 2, ;
 * fixed in). When THIS step's own plan already carries an approval it
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
  args: EstimateGasWithBufferArgs & {
    readonly hasPendingApproval: boolean
    /** A later addition: this step depends on an EARLIER, still-unconfirmed step of
     * the same plan (rather than on its own pending approval) — same fallback
     * behaviour, distinct `gasSource` label. */
    readonly dependsOnPriorStep?: boolean
  },
): Promise<ResolvedStepGas> {
  if (args.hasPendingApproval || args.dependsOnPriorStep) {
    const gas = fallbackGasForNFTBatch(args.tokenCount) + (args.extraFallbackGas ?? 0n)
    return { gas, gasSource: args.dependsOnPriorStep ? 'fallback-pending-step' : 'fallback-pending-approval' }
  }
  return { gas: await estimateGasWithBuffer(args) }
}
