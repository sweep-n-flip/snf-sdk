import { decodeFunctionData } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { ROUTER02_COLLECTION_ABI } from '../../src/abis/UniswapV2Router02Collection'
import { encodeDynamic, simulateDynamic } from '../../src/build/dynamicCall'
import type { SnfPublicClient } from '../../src/types/client.types'

const ROUTER = '0x000000000000000000000000000000000000BEEF' as `0x${string}`
const ACCOUNT = '0x000000000000000000000000000000000000dEaD' as `0x${string}`

describe('encodeDynamic', () => {
  it('encodes a runtime-chosen function name that decodes back to the same name and args', () => {
    const collection = '0x000000000000000000000000000000000000c011' as `0x${string}`
    const args = [[1n, 2n], 0n, ACCOUNT, 1_800_000_000n] as const
    const data = encodeDynamic(ROUTER02_COLLECTION_ABI, 'addLiquidityETHCollection', [
      collection,
      args[0],
      args[1],
      args[2],
      args[3],
    ])
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data })
    expect(decoded.functionName).toBe('addLiquidityETHCollection')
    expect(decoded.args).toEqual([collection, args[0], args[1], args[2], args[3]])
  })
})

describe('simulateDynamic', () => {
  it('forwards blockNumber, account and value to publicClient.simulateContract and returns its result', async () => {
    const simulateContract = vi.fn(async (_params: unknown) => ({ result: 42n }))
    const publicClient = { simulateContract } as unknown as SnfPublicClient

    const result = await simulateDynamic(publicClient, {
      address: ROUTER,
      abi: ROUTER02_COLLECTION_ABI,
      functionName: 'quote',
      args: [1n, 2n, 3n],
      account: ACCOUNT,
      value: 5n,
      blockNumber: 999_999n,
    })

    expect(result).toBe(42n)
    expect(simulateContract).toHaveBeenCalledTimes(1)
    const callArg = simulateContract.mock.calls[0]?.[0] as {
      readonly address: string
      readonly functionName: string
      readonly account: string
      readonly value: bigint
      readonly blockNumber: bigint
    }
    expect(callArg.address).toBe(ROUTER)
    expect(callArg.functionName).toBe('quote')
    expect(callArg.account).toBe(ACCOUNT)
    expect(callArg.value).toBe(5n)
    expect(callArg.blockNumber).toBe(999_999n)
  })
})
