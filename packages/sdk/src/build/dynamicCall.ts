import { encodeFunctionData } from 'viem'
import type { Abi, Address } from 'viem'

import type { SnfPublicClient } from '../types/client.types'

/**
 * The ONE place a liquidity builder encodes/simulates a Router call whose function
 * name is chosen at RUNTIME (by `ctx.chain.routerVariant`, by add/create/remove
 * mode, by native-vs-ERC-20 base) rather than known at compile time. viem's own
 * overload resolution cannot narrow a dynamically-assembled `{ abi, functionName,
 * args }` triple to one specific function signature — the exact class of problem
 * `build/gas.ts`'s `estimateGasWithBuffer` and `build/buildSell.ts`'s own
 * (now-duplicated) `encodeDynamic` already worked around individually. Liquidity
 * builders import these two functions instead of adding their own copies, so the
 * number of narrowly-scoped lint-suppressing casts for this one, well-understood
 * reason stops growing with every new builder.
 */

/** Encodes calldata for a Router function chosen at runtime. */
export function encodeDynamic(abi: Abi, functionName: string, args: readonly unknown[]): `0x${string}` {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
  return encodeFunctionData({ abi, functionName, args } as any)
}

export interface SimulateDynamicArgs {
  readonly address: Address
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
  readonly account: Address
  readonly value?: bigint
  readonly blockNumber?: bigint
}

/**
 * Simulates a Router function chosen at runtime and returns viem's own `result` —
 * never the whole `simulateContract` return shape, so a caller never has to know
 * viem's per-function result typing to read the one value it needs.
 */
export async function simulateDynamic(publicClient: SnfPublicClient, args: SimulateDynamicArgs): Promise<unknown> {
  const params = {
    address: args.address,
    abi: args.abi,
    functionName: args.functionName,
    args: args.args,
    account: args.account,
    value: args.value,
    blockNumber: args.blockNumber,
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
  const { result } = await publicClient.simulateContract(params as any)
  return result
}
