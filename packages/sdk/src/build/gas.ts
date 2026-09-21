import type { Abi, Address, PublicClient } from 'viem'
import { BaseError, ContractFunctionRevertedError } from 'viem'

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
  readonly publicClient: PublicClient
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
