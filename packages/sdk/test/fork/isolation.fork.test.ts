import { afterEach, describe, expect, it } from 'vitest'

import { FORK_LANES, FORK_PORTS, anvilMissingMessage, resolveAnvilBinary, startAnvil } from './anvil'
import type { AnvilInstance } from './anvil'

/**
 * The R20 backstop edge (Task 1; 54-SPEC.md): fork lanes run in isolated jobs on
 * distinct ports, and a sanity test proves two lanes never share chain state.
 *
 * Also the skip-guard contract every other `*.fork.test.ts` file relies on: when
 * `resolveAnvilBinary()` finds nothing, every lane (including this one) SKIPS with a
 * message naming both remedies, instead of throwing an opaque spawn error.
 */

const anvilBin = resolveAnvilBinary()

describe('fork lane isolation (Task 1, R20)', () => {
  it('FORK_PORTS are pairwise distinct — no lane ever shares a port', () => {
    expect(new Set(FORK_PORTS).size).toBe(FORK_PORTS.length)
    expect(FORK_PORTS.length).toBe(4)
  })

  it('chains.fork.json declares exactly the four required lanes, each with a chainId', () => {
    const keys = FORK_LANES.map((l) => l.key).sort()
    expect(keys).toEqual(['arbitrum', 'arc', 'base', 'robinhood'])
    for (const lane of FORK_LANES) {
      expect(typeof lane.chainId).toBe('number')
      expect(lane.forkBlockNumber === null || typeof lane.forkBlockNumber === 'number').toBe(true)
    }
  })

  const describeOrSkip = anvilBin ? describe : describe.skip
  if (!anvilBin) {
    // eslint-disable-next-line no-console
    console.warn(anvilMissingMessage())
  }

  describeOrSkip('live isolation (requires anvil — resolved at: ' + String(anvilBin) + ')', () => {
    let baseAnvil: AnvilInstance | undefined
    let arbitrumAnvil: AnvilInstance | undefined

    afterEach(async () => {
      await baseAnvil?.stop()
      await arbitrumAnvil?.stop()
      baseAnvil = undefined
      arbitrumAnvil = undefined
    })

    it('two anvils started simultaneously on distinct ports do not share state — mining on one leaves the other unchanged', async () => {
      const baseLane = FORK_LANES.find((l) => l.key === 'base')
      const arbitrumLane = FORK_LANES.find((l) => l.key === 'arbitrum')
      if (!baseLane || !arbitrumLane) throw new Error('base/arbitrum lanes missing from chains.fork.json')

      ;[baseAnvil, arbitrumAnvil] = await Promise.all([startAnvil(baseLane), startAnvil(arbitrumLane)])

      expect(baseAnvil.port).not.toBe(arbitrumAnvil.port)
      expect(baseAnvil.chainId).toBe(8453)
      expect(arbitrumAnvil.chainId).toBe(42161)

      const blockBefore = await Promise.all([
        fetchBlockNumber(baseAnvil.url),
        fetchBlockNumber(arbitrumAnvil.url),
      ])

      // Mine a block on the Base anvil only.
      await rpcCall(baseAnvil.url, 'evm_mine', [])

      const blockAfter = await Promise.all([
        fetchBlockNumber(baseAnvil.url),
        fetchBlockNumber(arbitrumAnvil.url),
      ])

      expect(blockAfter[0]).toBe(blockBefore[0] + 1n) // Base advanced by exactly one block.
      expect(blockAfter[1]).toBe(blockBefore[1]) // Arbitrum's head is unchanged — no shared state.
    })

    it("each lane's own anvil reports the chainId declared in chains.fork.json — a lane cannot be silently pointed at the wrong fork", async () => {
      const baseLane = FORK_LANES.find((l) => l.key === 'base')
      if (!baseLane) throw new Error('base lane missing from chains.fork.json')
      baseAnvil = await startAnvil(baseLane)
      const chainIdHex = await rpcCall<string>(baseAnvil.url, 'eth_chainId')
      expect(Number.parseInt(chainIdHex, 16)).toBe(baseLane.chainId)
    })
  })
})

async function rpcCall<T = unknown>(url: string, method: string, params: readonly unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`)
  return body.result as T
}

async function fetchBlockNumber(url: string): Promise<bigint> {
  const hex = await rpcCall<string>(url, 'eth_blockNumber')
  return BigInt(hex)
}
