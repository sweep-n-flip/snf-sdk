import { describe, expect, it } from 'vitest'

import { isSnfError } from '../../src/errors'
import { getAmountOut, ONE_E18 } from '../../src/math/quoteMath'
import { quoteSwap } from '../../src/quote/quoteSwap'
import { buildSwapEnv, ZERO_ADDRESS } from './quoteSwapTestHelpers'

/**
 * `quoteSwap` — fungible, delegate-aware per hop (Task 3, REQ-SDK-14, R10;
 * 54-SPEC.md). Every `<behavior>` bullet is at least one `it` below.
 */

const TOKEN_A = '0x0000000000000000000000000000000000000a01' as `0x${string}`
const TOKEN_B = '0x0000000000000000000000000000000000000b02' as `0x${string}`
const TOKEN_C = '0x0000000000000000000000000000000000000c03' as `0x${string}`
const PAIR_AB = '0x0000000000000000000000000000000000ab0001' as `0x${string}`
const PAIR_AQ = '0x0000000000000000000000000000000000a10001' as `0x${string}`
const PAIR_QB = '0x00000000000000000000000000000000002b0001' as `0x${string}`

describe('quoteSwap (Task 3, R10)', () => {
  it('a single-hop SnF-native pair uses 9800/10000 and matches the mocked on-chain getAmountsOut', async () => {
    const { ctx } = buildSwapEnv({
      hops: [{ from: TOKEN_A, to: TOKEN_B, pair: PAIR_AB, reserveFrom: 1_000n * ONE_E18, reserveTo: 1_000n * ONE_E18 }],
    })
    const quote = await quoteSwap(ctx, { chainId: 8453, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: 10n * ONE_E18 })
    const expected = getAmountOut(10n * ONE_E18, 1_000n * ONE_E18, 1_000n * ONE_E18, 9800n)
    expect(quote.amountOut?.value).toBe(expected)
    expect(quote.reconciled).toBe(true)
    expect(quote.side).toBe('swap')
    expect(quote.legs[0]?.path).toEqual([TOKEN_A, TOKEN_B])
  })

  it('a single-hop delegated pair uses that chain\'s delegateNetFee from the registry', async () => {
    const { ctx } = buildSwapEnv({
      hops: [{ from: TOKEN_A, to: TOKEN_B, pair: PAIR_AB, reserveFrom: 1_000n * ONE_E18, reserveTo: 1_000n * ONE_E18, delegated: true }],
    })
    const quote = await quoteSwap(ctx, { chainId: 8453, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: 10n * ONE_E18 })
    const expected = getAmountOut(10n * ONE_E18, 1_000n * ONE_E18, 1_000n * ONE_E18, BigInt(ctx.chain.delegateNetFee))
    expect(quote.amountOut?.value).toBe(expected)
    // Proves it is NOT the same as the native-pair fee for the same reserves.
    const nativeExpected = getAmountOut(10n * ONE_E18, 1_000n * ONE_E18, 1_000n * ONE_E18, 9800n)
    expect(quote.amountOut?.value).not.toBe(nativeExpected)
  })

  it('two chains whose registry delegateNetFee values differ apply two different fee constants', async () => {
    const hopFixture = { from: TOKEN_A, to: TOKEN_B, pair: PAIR_AB, reserveFrom: 1_000n * ONE_E18, reserveTo: 1_000n * ONE_E18, delegated: true }
    const envA = buildSwapEnv({ hops: [hopFixture] })
    // Simulates a chain whose registry entry carries a DIFFERENT delegateNetFee — the
    // SDK must read this per-ctx.chain field, never a global constant.
    const envB = buildSwapEnv({ hops: [hopFixture], delegateNetFeeOverride: 9500 })

    const quoteA = await quoteSwap(envA.ctx, { chainId: 8453, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: 10n * ONE_E18 })
    const quoteB = await quoteSwap(envB.ctx, { chainId: 8453, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: 10n * ONE_E18 })

    expect(envA.ctx.chain.delegateNetFee).not.toBe(envB.ctx.chain.delegateNetFee)
    expect(quoteA.amountOut?.value).not.toBe(quoteB.amountOut?.value)
    expect(quoteA.amountOut?.value).toBe(getAmountOut(10n * ONE_E18, 1_000n * ONE_E18, 1_000n * ONE_E18, 9970n))
    expect(quoteB.amountOut?.value).toBe(getAmountOut(10n * ONE_E18, 1_000n * ONE_E18, 1_000n * ONE_E18, 9500n))
  })

  it('a two-hop path with one SnF hop and one delegated hop applies a different fee per hop (hand-computed)', async () => {
    const { ctx } = buildSwapEnv({
      hops: [
        { from: TOKEN_A, to: ZERO_ADDRESS, pair: PAIR_AQ, reserveFrom: 500n * ONE_E18, reserveTo: 500n * ONE_E18, delegated: false },
        { from: ZERO_ADDRESS, to: TOKEN_B, pair: PAIR_QB, reserveFrom: 800n * ONE_E18, reserveTo: 200n * ONE_E18, delegated: true },
      ],
    })
    // The quote token stands in for the intermediate hop (chain default quoteToken).
    const quoteToken = ctx.chain.quoteToken
    const hop1 = { from: TOKEN_A, to: quoteToken, pair: PAIR_AQ, reserveFrom: 500n * ONE_E18, reserveTo: 500n * ONE_E18 }
    const hop2 = { from: quoteToken, to: TOKEN_B, pair: PAIR_QB, reserveFrom: 800n * ONE_E18, reserveTo: 200n * ONE_E18 }
    const { ctx: realCtx } = buildSwapEnv({
      hops: [
        { ...hop1, delegated: false },
        { ...hop2, delegated: true },
      ],
    })
    const amountIn = 10n * ONE_E18
    const mid = getAmountOut(amountIn, hop1.reserveFrom, hop1.reserveTo, 9800n)
    const expectedOut = getAmountOut(mid as bigint, hop2.reserveFrom, hop2.reserveTo, BigInt(realCtx.chain.delegateNetFee))

    const quote = await quoteSwap(realCtx, { chainId: 8453, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn })
    expect(quote.amountOut?.value).toBe(expectedOut)
    expect(quote.legs[0]?.path).toEqual([TOKEN_A, quoteToken, TOKEN_B])
    void ctx
  })

  it('directOnly blocking a multi-hop route yields NO_ROUTE with details.viablePayTokens.length > 0', async () => {
    const { ctx } = buildSwapEnv({ hops: [] })
    const quoteToken = ctx.chain.quoteToken
    const { ctx: routedCtx } = buildSwapEnv({
      hops: [
        { from: TOKEN_A, to: quoteToken, pair: PAIR_AQ, reserveFrom: 500n * ONE_E18, reserveTo: 500n * ONE_E18 },
        { from: quoteToken, to: TOKEN_B, pair: PAIR_QB, reserveFrom: 800n * ONE_E18, reserveTo: 200n * ONE_E18 },
      ],
    })
    let threw = false
    try {
      await quoteSwap(routedCtx, { chainId: 8453, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: 10n * ONE_E18, directOnly: true })
    } catch (e) {
      threw = true
      expect(isSnfError(e)).toBe(true)
      if (isSnfError(e)) {
        expect(e.code).toBe('NO_ROUTE')
        const viablePayTokens = e.details?.viablePayTokens as readonly unknown[]
        expect(viablePayTokens.length).toBeGreaterThan(0)
      }
    }
    expect(threw).toBe(true)
  })

  it('amountIn: 0n ⇒ INVALID_PARAMS', async () => {
    const { ctx } = buildSwapEnv({ hops: [{ from: TOKEN_A, to: TOKEN_B, pair: PAIR_AB, reserveFrom: 1n * ONE_E18, reserveTo: 1n * ONE_E18 }] })
    await expect(quoteSwap(ctx, { chainId: 8453, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: 0n })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    })
  })

  it('both amountIn and amountOut supplied ⇒ INVALID_PARAMS', async () => {
    const { ctx } = buildSwapEnv({ hops: [{ from: TOKEN_A, to: TOKEN_B, pair: PAIR_AB, reserveFrom: 1n * ONE_E18, reserveTo: 1n * ONE_E18 }] })
    await expect(
      quoteSwap(ctx, { chainId: 8453, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: 1n, amountOut: 1n }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  })

  it('neither amountIn nor amountOut supplied ⇒ INVALID_PARAMS', async () => {
    const { ctx } = buildSwapEnv({ hops: [{ from: TOKEN_A, to: TOKEN_B, pair: PAIR_AB, reserveFrom: 1n * ONE_E18, reserveTo: 1n * ONE_E18 }] })
    await expect(quoteSwap(ctx, { chainId: 8453, tokenIn: TOKEN_A, tokenOut: TOKEN_B })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    })
  })

  it('tokenIn === tokenOut ⇒ INVALID_PARAMS', async () => {
    const { ctx } = buildSwapEnv({ hops: [{ from: TOKEN_A, to: TOKEN_B, pair: PAIR_AB, reserveFrom: 1n * ONE_E18, reserveTo: 1n * ONE_E18 }] })
    await expect(quoteSwap(ctx, { chainId: 8453, tokenIn: TOKEN_A, tokenOut: TOKEN_A, amountIn: 1n })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    })
  })

  it('amountIn greater than the reserve yields a Quote with a high priceImpact and no error', async () => {
    const { ctx } = buildSwapEnv({
      hops: [{ from: TOKEN_A, to: TOKEN_B, pair: PAIR_AB, reserveFrom: 100n * ONE_E18, reserveTo: 100n * ONE_E18 }],
    })
    const quote = await quoteSwap(ctx, { chainId: 8453, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: 10_000n * ONE_E18 })
    expect(quote.priceImpact).toBeGreaterThan(50)
    expect(quote.priceImpact).toBeLessThanOrEqual(100)
    expect(quote.reconciled).toBe(true)
  })

  it('a mismatch against the Router\'s on-chain answer throws QUOTE_RECONCILIATION_FAILED', async () => {
    const { ctx } = buildSwapEnv({
      hops: [{ from: TOKEN_A, to: TOKEN_B, pair: PAIR_AB, reserveFrom: 1_000n * ONE_E18, reserveTo: 1_000n * ONE_E18 }],
      routerAmountsOverride: [10n * ONE_E18, 999_999n],
    })
    await expect(
      quoteSwap(ctx, { chainId: 8453, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: 10n * ONE_E18 }),
    ).rejects.toMatchObject({ code: 'QUOTE_RECONCILIATION_FAILED' })
  })

  it('amountOut-driven mode computes amountIn via getAmountsInChain and reconciles against the Router', async () => {
    const { ctx } = buildSwapEnv({
      hops: [{ from: TOKEN_A, to: TOKEN_B, pair: PAIR_AB, reserveFrom: 1_000n * ONE_E18, reserveTo: 1_000n * ONE_E18 }],
    })
    const quote = await quoteSwap(ctx, { chainId: 8453, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountOut: 5n * ONE_E18 })
    expect(quote.amountOut?.value).toBe(5n * ONE_E18)
    expect(quote.amountIn?.value).toBeGreaterThan(0n)
    expect(quote.reconciled).toBe(true)
  })

  it('native tokenIn (null) resolves through the chain quote token, amountIn labelled with the native symbol', async () => {
    const { ctx } = buildSwapEnv({ hops: [] })
    const quoteToken = ctx.chain.quoteToken
    const { ctx: routedCtx } = buildSwapEnv({
      hops: [{ from: quoteToken, to: TOKEN_C, pair: PAIR_AB, reserveFrom: 1_000n * ONE_E18, reserveTo: 1_000n * ONE_E18 }],
    })
    const quote = await quoteSwap(routedCtx, { chainId: 8453, tokenIn: null, tokenOut: TOKEN_C, amountIn: 10n * ONE_E18 })
    expect(quote.amountIn?.symbol).toBe(routedCtx.chain.nativeSymbol)
    expect(quote.legs[0]?.kind).toBe('native')
    void ctx
  })

  it('an arbitrary ERC20 output token is labelled with its own on-chain decimals/symbol, not the quote token\'s', async () => {
    const { ctx } = buildSwapEnv({
      hops: [{ from: TOKEN_A, to: TOKEN_C, pair: PAIR_AB, reserveFrom: 1_000n * 10n ** 6n, reserveTo: 1_000n * ONE_E18 }],
      tokenMeta: { [TOKEN_C.toLowerCase()]: { decimals: 6, symbol: 'USDX' } },
    })
    const quote = await quoteSwap(ctx, { chainId: 8453, tokenIn: TOKEN_A, tokenOut: TOKEN_C, amountIn: 10n * 10n ** 6n })
    expect(quote.amountOut?.decimals).toBe(6)
    expect(quote.amountOut?.symbol).toBe('USDX')
  })

  it('a chainId matching the client\'s own chain behaves identically to chainId omitted (R11)', async () => {
    const hops = [{ from: TOKEN_A, to: TOKEN_B, pair: PAIR_AB, reserveFrom: 1_000n * ONE_E18, reserveTo: 1_000n * ONE_E18 }]
    const { ctx: ctxMatching } = buildSwapEnv({ hops })
    const quoteMatching = await quoteSwap(ctxMatching, { chainId: 8453, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: 10n * ONE_E18 })
    const { ctx: ctxOmitted } = buildSwapEnv({ hops })
    const quoteOmitted = await quoteSwap(ctxOmitted, { tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: 10n * ONE_E18 })
    // expiresAt is wall-clock-derived (Date.now() + QUOTE_TTL_MS) so it is compared
    // separately rather than via a blanket toEqual, which would be flaky across a
    // millisecond boundary between the two calls.
    const { expiresAt: expiresAtMatching, ...restMatching } = quoteMatching
    const { expiresAt: expiresAtOmitted, ...restOmitted } = quoteOmitted
    expect(restMatching).toEqual(restOmitted)
    expect(typeof expiresAtMatching).toBe('string')
    expect(typeof expiresAtOmitted).toBe('string')
  })

  it('a chainId mismatched against the client\'s own chain throws WRONG_CHAIN before any on-chain read (R11)', async () => {
    const { ctx, multicall } = buildSwapEnv({
      hops: [{ from: TOKEN_A, to: TOKEN_B, pair: PAIR_AB, reserveFrom: 1_000n * ONE_E18, reserveTo: 1_000n * ONE_E18 }],
    })
    await expect(
      quoteSwap(ctx, { chainId: 1, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: 10n * ONE_E18 }),
    ).rejects.toMatchObject({ code: 'WRONG_CHAIN' })
    expect(multicall).not.toHaveBeenCalled()
  })
})
