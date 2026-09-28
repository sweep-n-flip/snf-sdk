import { getAddress } from 'viem'
import type { Abi } from 'viem'

import { ERC20_ABI } from '../abis/ERC20'
import { FACTORY_ABI } from '../abis/UniswapV2Factory'
import { PAIR_ABI } from '../abis/UniswapV2Pair'
import { WERC721_ABI } from '../abis/WERC721'
import { assertParam, SnfError } from '../errors'
import { resolveWrapperSide } from '../routing/nftRoutePaths'
import type { TokenRef } from '../types/amount.types'
import type { SnfClientContext } from '../types/client.types'
import type { DepositPoolState, PairPoolState } from './poolState.types'

/**
 * `loadDepositState` / `loadPairState` — the one-block pool-state loaders every
 * liquidity quote/build composes. Both loaders pin every read to a SINGLE
 * `blockNumber` (read once, before any other call, then passed explicitly to every
 * multicall round below) so the whole state describes one consistent chain
 * snapshot, no matter how many sequential round trips resolving it takes — the same
 * discipline `quote/quoteContext.ts` and `inventory/poolInventory.ts` already
 * follow.
 *
 * ROUNDS ARE SEQUENTIAL, THE BLOCK IS NOT
 * ----------------------------------------
 * Each round below depends on the PREVIOUS round's own answer (round 2 needs round
 * 1's wrapper address; round 3 needs round 2's pair address) — a genuine data
 * dependency, not an oversight. What stays fixed across every round is the block
 * number, never the number of round trips. `loadPairState` accepts an optional
 * caller-supplied `blockNumber`: a caller that has already read the chain's head
 * once (a whole-wallet scan pricing several pairs together) passes it straight
 * through, so every pair in that scan is pinned to the exact same snapshot and the
 * loader never issues its own redundant `getBlockNumber()` call.
 *
 * THE WRAPPER SIDE IS NEVER ASSUMED
 * -----------------------------------
 * `wrapperIsToken0` always comes from `resolveWrapperSide` comparing the PAIR's own
 * `token0`/`token1` against the wrapper/base addresses this loader already resolved
 * independently (via `Factory.getWrapper`/`getPair`) — never a bare index guess (root
 * `CLAUDE.md`, "What NOT to Do").
 *
 * BALANCES ARE READ SEPARATE FROM RESERVES
 * -------------------------------------------
 * `Pair.mint` computes minted liquidity from `balanceOf(pair) - reserve` (the amount
 * actually deposited since the last sync); `Pair.burn` pays out of
 * `balanceOf(pair)`, not the cached `getReserves` values. A pool whose balances
 * differ from its reserves (a pending sync, a direct transfer) is exactly the case
 * these two loaders exist to expose correctly to `liquidityMath.ts`'s `mintLiquidity`
 * / `burnAmounts`.
 *
 * THE PAIR IS ALWAYS RE-DERIVED FROM THE FACTORY
 * -------------------------------------------------
 * A caller-supplied `pair` address (`loadPairState`) is untrusted input — it is
 * re-derived from `Factory.getPair(wrapper, base)` and compared, so a spoofed or
 * unrelated address throws `INVALID_PARAMS` (`details.reason === 'not-an-snf-pair'`)
 * before any figure is computed from it.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

interface Call {
  readonly address: `0x${string}`
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
}
type CallResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

function isZeroAddress(addr: string): boolean {
  return addr.toLowerCase() === ZERO_ADDRESS
}

function assertWellFormedAddress(value: string, field: string): void {
  assertParam(ADDRESS_RE.test(value), `${field} must be a well-formed 0x address`, { field, value })
}

/** Same `readResult` convention `quote/quoteContext.ts` uses: a read that failed for
 * any reason OTHER than a deliberately-classified caller-input failure (handled by
 * its own dedicated check, see `loadDepositState`'s `decimals()` read) is an upstream
 * problem, not a validation error. */
function readResult<T>(result: CallResult | undefined, field: string): T {
  if (result?.status !== 'success') {
    throw new SnfError('NO_ROUTE', `Could not read ${field} while loading pool state`, {
      details: { field },
    })
  }
  return result.result as T
}

export interface LoadDepositStateArgs {
  readonly collection: `0x${string}`
  /** `null`/omitted, or any-case-equal to `ctx.chain.quoteToken` — all three mean the
   * native pool (Pitfall 8: an explicit WETH-equal pick is still the native pool, not
   * a distinct ERC-20 deposit target). */
  readonly baseToken?: `0x${string}` | null
}

export async function loadDepositState(
  ctx: SnfClientContext,
  args: LoadDepositStateArgs,
): Promise<DepositPoolState> {
  assertWellFormedAddress(args.collection, 'collection')
  const collection = getAddress(args.collection)

  const rawBase = args.baseToken ?? null
  if (rawBase !== null) assertWellFormedAddress(rawBase, 'baseToken')
  const isNative = rawBase === null || rawBase.toLowerCase() === ctx.chain.quoteToken.toLowerCase()
  const baseAddress = isNative ? getAddress(ctx.chain.quoteToken) : getAddress(rawBase)

  // Read the block ONCE, before round 1 — every round below is pinned to this exact
  // value, however many sequential round trips resolving the full state takes.
  const blockNumber = await ctx.publicClient.getBlockNumber()

  // ── Round 1 — Factory-level facts + (ERC-20 base only) base metadata ──────────
  const round1Contracts: Call[] = [
    { address: ctx.chain.factory, abi: FACTORY_ABI, functionName: 'getWrapper', args: [collection] },
    { address: ctx.chain.factory, abi: FACTORY_ABI, functionName: 'feeTo', args: [] },
  ]
  if (!isNative) {
    round1Contracts.push(
      { address: baseAddress, abi: ERC20_ABI, functionName: 'decimals', args: [] },
      { address: baseAddress, abi: ERC20_ABI, functionName: 'symbol', args: [] },
      { address: ctx.chain.factory, abi: FACTORY_ABI, functionName: 'getCollection', args: [baseAddress] },
    )
  }
  const round1: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts: round1Contracts,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
    blockNumber,
  })

  const wrapperRaw = readResult<`0x${string}`>(round1[0], 'Factory.getWrapper')
  const feeTo = readResult<`0x${string}`>(round1[1], 'Factory.feeTo')
  const wrapper = isZeroAddress(wrapperRaw) ? null : wrapperRaw

  let baseToken: TokenRef
  let baseIsWrapper = false
  if (isNative) {
    baseToken = { address: baseAddress, symbol: ctx.chain.nativeSymbol, decimals: ctx.chain.quoteDecimals, isNative: true }
  } else {
    const decimalsResult = round1[2]
    // A bad ERC-20 address (no `decimals()`, or reverts) is a CALLER mistake, not an
    // upstream RPC problem — INVALID_PARAMS naming `baseToken`, not the generic
    // NO_ROUTE `readResult` uses for every other read in this file.
    assertParam(decimalsResult?.status === 'success', 'baseToken does not implement ERC-20 decimals()', {
      field: 'baseToken',
      value: baseAddress,
    })
    const decimals = decimalsResult.result as number
    const symbolResult = round1[3]
    const symbol = symbolResult?.status === 'success' ? (symbolResult.result as string) : 'TOKEN'
    const collectionOfBase = readResult<`0x${string}`>(round1[4], 'Factory.getCollection(baseToken)')
    baseIsWrapper = !isZeroAddress(collectionOfBase)
    baseToken = { address: baseAddress, symbol, decimals, isNative: false }
  }

  let pair: `0x${string}` | null = null
  let wrapperIsToken0: boolean | null = null
  let reserves = { base: 0n, wnft: 0n }
  let balances = { base: 0n, wnft: 0n }
  let totalSupply = 0n

  if (wrapper !== null) {
    // ── Round 2 — depends on round 1's wrapper address ──────────────────────────
    const round2Contracts: Call[] = [
      { address: ctx.chain.factory, abi: FACTORY_ABI, functionName: 'getPair', args: [wrapper, baseAddress] },
      { address: wrapper, abi: WERC721_ABI, functionName: 'collection', args: [] },
    ]
    const round2: readonly CallResult[] = await ctx.publicClient.multicall({
      contracts: round2Contracts,
      allowFailure: true,
      multicallAddress: ctx.chain.multicall3,
      batchSize: 0,
      blockNumber,
    })
    const pairRaw = readResult<`0x${string}`>(round2[0], 'Factory.getPair')
    const wrapperCollectionResult = round2[1]
    const wrapperCollection =
      wrapperCollectionResult?.status === 'success' ? (wrapperCollectionResult.result as `0x${string}`) : null
    if (wrapperCollection === null || wrapperCollection.toLowerCase() !== collection.toLowerCase()) {
      throw new SnfError('WRAPPER_UNVERIFIED', "wrapper.collection() did not match the requested collection", {
        details: { wrapper, collection, wrapperCollection },
      })
    }
    pair = isZeroAddress(pairRaw) ? null : pairRaw

    if (pair !== null) {
      // ── Round 3 — depends on round 2's pair address ───────────────────────────
      const round3Contracts: Call[] = [
        { address: pair, abi: PAIR_ABI, functionName: 'getReserves', args: [] },
        { address: pair, abi: PAIR_ABI, functionName: 'token0', args: [] },
        { address: pair, abi: PAIR_ABI, functionName: 'token1', args: [] },
        { address: pair, abi: PAIR_ABI, functionName: 'totalSupply', args: [] },
        { address: baseAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [pair] },
        { address: wrapper, abi: WERC721_ABI, functionName: 'balanceOf', args: [pair] },
      ]
      const round3: readonly CallResult[] = await ctx.publicClient.multicall({
        contracts: round3Contracts,
        allowFailure: true,
        multicallAddress: ctx.chain.multicall3,
        batchSize: 0,
        blockNumber,
      })
      const [reserve0, reserve1] = readResult<readonly [bigint, bigint, number]>(round3[0], 'getReserves')
      const token0 = readResult<`0x${string}`>(round3[1], 'token0')
      const token1 = readResult<`0x${string}`>(round3[2], 'token1')
      totalSupply = readResult<bigint>(round3[3], 'totalSupply')
      const baseBalance = readResult<bigint>(round3[4], 'base balanceOf(pair)')
      const wnftBalance = readResult<bigint>(round3[5], 'wrapper balanceOf(pair)')

      const resolved = resolveWrapperSide({ pair, token0, token1, baseToken })
      wrapperIsToken0 = resolved.wrapperIsToken0
      reserves = wrapperIsToken0 ? { base: reserve1, wnft: reserve0 } : { base: reserve0, wnft: reserve1 }
      balances = { base: baseBalance, wnft: wnftBalance }
    }
  }

  return {
    blockNumber,
    collection,
    wrapper,
    pair,
    baseToken,
    isNative,
    baseIsWrapper,
    wrapperIsToken0,
    reserves,
    balances,
    totalSupply,
    feeTo,
  }
}

export interface LoadPairStateArgs {
  readonly pair: `0x${string}`
  /** When present, the loader also returns this address's live LP balance
   * (`ownerLp`). */
  readonly owner?: `0x${string}`
  /** When present, every round is pinned to it and no block is read — the caller
   * (e.g. a whole-wallet scan already sitting on one block) supplies the snapshot
   * instead of this loader taking its own. */
  readonly blockNumber?: bigint
}

export async function loadPairState(ctx: SnfClientContext, args: LoadPairStateArgs): Promise<PairPoolState> {
  assertWellFormedAddress(args.pair, 'pair')
  const pair = getAddress(args.pair)
  if (args.owner !== undefined) assertWellFormedAddress(args.owner, 'owner')
  const owner = args.owner !== undefined ? getAddress(args.owner) : undefined

  const blockNumber = args.blockNumber ?? (await ctx.publicClient.getBlockNumber())

  // ── Round 1 — the pair's own state (+ owner LP balance, if requested) ────────
  const round1Contracts: Call[] = [
    { address: pair, abi: PAIR_ABI, functionName: 'token0', args: [] },
    { address: pair, abi: PAIR_ABI, functionName: 'token1', args: [] },
    { address: pair, abi: PAIR_ABI, functionName: 'getReserves', args: [] },
    { address: pair, abi: PAIR_ABI, functionName: 'totalSupply', args: [] },
    { address: ctx.chain.factory, abi: FACTORY_ABI, functionName: 'feeTo', args: [] },
    ...(owner !== undefined ? [{ address: pair, abi: PAIR_ABI, functionName: 'balanceOf', args: [owner] } as Call] : []),
  ]
  const round1: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts: round1Contracts,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
    blockNumber,
  })
  const token0 = readResult<`0x${string}`>(round1[0], 'token0')
  const token1 = readResult<`0x${string}`>(round1[1], 'token1')
  const [reserve0, reserve1] = readResult<readonly [bigint, bigint, number]>(round1[2], 'getReserves')
  const totalSupply = readResult<bigint>(round1[3], 'totalSupply')
  const feeTo = readResult<`0x${string}`>(round1[4], 'Factory.feeTo')
  const ownerLp = owner !== undefined ? readResult<bigint>(round1[5], 'Pair.balanceOf(owner)') : undefined

  // ── Round 2 — which slot is the wrapper: probe collection() on BOTH tokens ───
  const round2Contracts: readonly Call[] = [
    { address: token0, abi: WERC721_ABI, functionName: 'collection', args: [] },
    { address: token1, abi: WERC721_ABI, functionName: 'collection', args: [] },
  ]
  const round2: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts: round2Contracts,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
    blockNumber,
  })
  const discrete0 = round2[0]?.status === 'success'
  const discrete1 = round2[1]?.status === 'success'
  assertParam(discrete0 !== discrete1, 'this pair is not an SnF NFT pool', {
    field: 'pair',
    value: pair,
    reason: 'not-an-snf-pair',
  })
  const wrapper = discrete0 ? token0 : token1
  const collection = (discrete0 ? round2[0] : round2[1])!.result as `0x${string}`
  const baseAddressGuess = discrete0 ? token1 : token0
  const isNative = baseAddressGuess.toLowerCase() === ctx.chain.quoteToken.toLowerCase()

  // ── Round 3 — verify the pair via the Factory + read both pair balances (+ ERC-20
  // base metadata, when applicable) ─────────────────────────────────────────────
  const round3Contracts: Call[] = [
    { address: ctx.chain.factory, abi: FACTORY_ABI, functionName: 'getPair', args: [wrapper, baseAddressGuess] },
    { address: baseAddressGuess, abi: ERC20_ABI, functionName: 'balanceOf', args: [pair] },
    { address: wrapper, abi: WERC721_ABI, functionName: 'balanceOf', args: [pair] },
  ]
  if (!isNative) {
    round3Contracts.push(
      { address: baseAddressGuess, abi: ERC20_ABI, functionName: 'decimals', args: [] },
      { address: baseAddressGuess, abi: ERC20_ABI, functionName: 'symbol', args: [] },
    )
  }
  const round3: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts: round3Contracts,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
    blockNumber,
  })
  const factoryPair = readResult<`0x${string}`>(round3[0], 'Factory.getPair')
  // The pair is untrusted input — re-derived from the Factory and compared,
  // never used to compute a figure before this check passes.
  assertParam(factoryPair.toLowerCase() === pair.toLowerCase(), 'this pair is not an SnF NFT pool', {
    field: 'pair',
    value: pair,
    reason: 'not-an-snf-pair',
  })
  const baseBalance = readResult<bigint>(round3[1], 'base balanceOf(pair)')
  const wnftBalance = readResult<bigint>(round3[2], 'wrapper balanceOf(pair)')

  let baseToken: TokenRef
  if (isNative) {
    baseToken = { address: baseAddressGuess, symbol: ctx.chain.nativeSymbol, decimals: ctx.chain.quoteDecimals, isNative: true }
  } else {
    const decimalsResult = round3[3]
    assertParam(decimalsResult?.status === 'success', 'baseToken does not implement ERC-20 decimals()', {
      field: 'baseToken',
      value: baseAddressGuess,
    })
    const decimals = decimalsResult.result as number
    const symbolResult = round3[4]
    const symbol = symbolResult?.status === 'success' ? (symbolResult.result as string) : 'TOKEN'
    baseToken = { address: baseAddressGuess, symbol, decimals, isNative: false }
  }

  const resolved = resolveWrapperSide({ pair, token0, token1, baseToken })
  const wrapperIsToken0 = resolved.wrapperIsToken0
  const reserves = wrapperIsToken0 ? { base: reserve1, wnft: reserve0 } : { base: reserve0, wnft: reserve1 }
  const balances = { base: baseBalance, wnft: wnftBalance }

  return {
    blockNumber,
    pair,
    collection,
    wrapper,
    baseToken,
    isNative,
    wrapperIsToken0,
    reserves,
    balances,
    totalSupply,
    feeTo,
    ...(ownerLp !== undefined ? { ownerLp } : {}),
  }
}
