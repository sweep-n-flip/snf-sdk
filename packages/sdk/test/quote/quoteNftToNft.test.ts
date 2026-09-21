import { describe, expect, it } from 'vitest'

import { isSnfError } from '../../src/errors'
import { quoteNftToNft } from '../../src/quote/quoteNftToNft'
import { buildTwoLegEnv, ZERO_ADDRESS, type TwoLegConfig } from './nftToNftTestHelpers'

/**
 * `quoteNftToNft` — two legs, per-leg royalty, saturating remainder, and a typed
 * refusal for cross-base pools (Task 2, REQ-SDK-13, R9; 54-SPEC.md). Every
 * `<behavior>` bullet from the plan is at least one `it` below; parity against
 * `snf-client`'s `computeNftToNftQuote` lives in its own file
 * (`test/quote/nftToNft.parity.test.ts`).
 */

const SELL_PAIR = '0x000000000000000000000000000000005e11000a' as `0x${string}`
const SELL_WRAPPER = '0x000000000000000000000000000000005e11000b' as `0x${string}`
const SELL_COLLECTION = '0x000000000000000000000000000000005e11000c' as `0x${string}`
const BUY_PAIR = '0x000000000000000000000000000000006b1000a1' as `0x${string}`
const BUY_WRAPPER = '0x000000000000000000000000000000006b1000b1' as `0x${string}`
const BUY_COLLECTION = '0x000000000000000000000000000000006b1000c1' as `0x${string}`
const SELL_RECEIVER = '0x1111111111111111111111111111111111111111' as `0x${string}`
const BUY_RECEIVER = '0x2222222222222222222222222222222222222222' as `0x${string}`

const RESERVES = { base: 1_000n * 10n ** 18n, wnft: 1_000n * 10n ** 18n }

function baseConfig(overrides: { readonly sell?: Partial<TwoLegConfig['sell']>; readonly buy?: Partial<TwoLegConfig['buy']> } = {}): TwoLegConfig {
  return {
    chainId: 8453,
    marketplaceFeeE18: 0n,
    sell: {
      pair: SELL_PAIR,
      wrapper: SELL_WRAPPER,
      collection: SELL_COLLECTION,
      reserves: RESERVES,
      units: 10n ** 18n,
      poolLeg: 100n,
      routerTotal: 100n,
      perId: [{ tokenId: '1', receiver: ZERO_ADDRESS, amount: 0n }],
      ...overrides.sell,
    },
    buy: {
      pair: BUY_PAIR,
      wrapper: BUY_WRAPPER,
      collection: BUY_COLLECTION,
      reserves: RESERVES,
      units: 10n ** 18n,
      poolLeg: 100n,
      routerTotal: 100n,
      perId: [{ tokenId: '10', receiver: ZERO_ADDRESS, amount: 0n }],
      ...overrides.buy,
    },
  }
}

const ARGS = {
  chainId: 8453 as const,
  sell: { collection: SELL_COLLECTION, tokenIds: ['1'] },
  buy: { collection: BUY_COLLECTION, count: 1 },
  remainder: 'native' as const,
}

describe('quoteNftToNft (Task 2, R9)', () => {
  it('legs.length === 2 with legs[0].side === "sell" and legs[1].side === "buy", always in that order', async () => {
    const { ctx } = buildTwoLegEnv(baseConfig())
    const quote = await quoteNftToNft(ctx, ARGS)
    expect(quote.legs.length).toBe(2)
    expect(quote.legs[0]?.side).toBe('sell')
    expect(quote.legs[1]?.side).toBe('buy')
    expect(quote.side).toBe('nft-to-nft')
  })

  it('buyCost > netProceeds ⇒ remainder 0n; top-up derivable as buyCost - netProceeds', async () => {
    const { ctx } = buildTwoLegEnv(baseConfig({ sell: { routerTotal: 100n, poolLeg: 100n }, buy: { routerTotal: 150n, poolLeg: 150n } }))
    const quote = await quoteNftToNft(ctx, ARGS)
    expect(quote.netProceeds?.value).toBe(100n)
    expect(quote.buyCost?.value).toBe(150n)
    expect(quote.remainder?.value).toBe(0n)
    const topUp = (quote.buyCost?.value ?? 0n) - (quote.netProceeds?.value ?? 0n)
    expect(topUp).toBe(50n)
  })

  it('buyCost === netProceeds ⇒ remainder 0n, top-up 0n', async () => {
    const { ctx } = buildTwoLegEnv(baseConfig({ sell: { routerTotal: 100n, poolLeg: 100n }, buy: { routerTotal: 100n, poolLeg: 100n } }))
    const quote = await quoteNftToNft(ctx, ARGS)
    expect(quote.remainder?.value).toBe(0n)
    expect((quote.buyCost?.value ?? 0n) - (quote.netProceeds?.value ?? 0n)).toBe(0n)
  })

  it('buyCost < netProceeds ⇒ remainder === netProceeds - buyCost (native mode)', async () => {
    const { ctx } = buildTwoLegEnv(baseConfig({ sell: { routerTotal: 200n, poolLeg: 200n }, buy: { routerTotal: 120n, poolLeg: 120n } }))
    const quote = await quoteNftToNft(ctx, ARGS)
    expect(quote.remainder?.value).toBe(80n)
    expect(quote.remainder?.decimals).toBe(18)
  })

  it("remainder: 'wnft' returns the leftover as wrapper units on the buy collection", async () => {
    const cfg = baseConfig({
      sell: { routerTotal: 200n, poolLeg: 200n },
      buy: { routerTotal: 120n, poolLeg: 120n, symbol: 'BUYSYM' },
    })
    const { ctx } = buildTwoLegEnv(cfg)
    const quote = await quoteNftToNft(ctx, { ...ARGS, remainder: 'wnft' })
    expect(quote.remainder?.value).toBeGreaterThan(0n)
    expect(quote.remainder?.decimals).toBe(18)
    expect(quote.remainder?.symbol).toBe('BUYSYM')
  })

  it("remainder: 'native' returns the leftover as native change", async () => {
    const { ctx } = buildTwoLegEnv(baseConfig({ sell: { routerTotal: 200n, poolLeg: 200n }, buy: { routerTotal: 120n, poolLeg: 120n } }))
    const quote = await quoteNftToNft(ctx, { ...ARGS, remainder: 'native' })
    expect(quote.remainder?.value).toBe(80n)
    expect(quote.remainder?.symbol).toBe(ctx.chain.nativeSymbol)
  })

  it('each leg carries its own fees.royalty in its own base currency; different percentages surface a warning naming both', async () => {
    const cfg = baseConfig({
      sell: {
        routerTotal: 100n - 5n,
        poolLeg: 100n,
        perId: [{ tokenId: '1', receiver: SELL_RECEIVER, amount: 5n }],
        symbol: 'SELLSYM',
      },
      buy: {
        routerTotal: 100n + 9n,
        poolLeg: 100n,
        perId: [{ tokenId: '10', receiver: BUY_RECEIVER, amount: 9n }],
        symbol: 'BUYSYM',
      },
    })
    const { ctx } = buildTwoLegEnv(cfg)
    const quote = await quoteNftToNft(ctx, ARGS)
    expect(quote.legs[0]?.fees?.royalty.value).toBe(5n)
    expect(quote.legs[1]?.fees?.royalty.value).toBe(9n)
    expect(quote.fees.royalty.value).toBe(14n)
    expect(quote.warnings?.some((w) => w.includes('SELLSYM') && w.includes('BUYSYM'))).toBe(true)
  })

  it('pool A on one base and pool B on a different base ⇒ NO_ROUTE with details.reason "different-base"', async () => {
    const otherBase = '0x9999999999999999999999999999999999999999' as `0x${string}`
    const cfg = baseConfig({ buy: { baseToken: otherBase } })
    const { ctx } = buildTwoLegEnv(cfg)
    let threw = false
    try {
      await quoteNftToNft(ctx, ARGS)
    } catch (e) {
      threw = true
      expect(isSnfError(e)).toBe(true)
      if (isSnfError(e)) {
        expect(e.code).toBe('NO_ROUTE')
        expect(e.details?.reason).toBe('different-base')
      }
    }
    expect(threw).toBe(true)
  })

  it('sell.collection === buy.collection ⇒ INVALID_PARAMS', async () => {
    const { ctx } = buildTwoLegEnv(baseConfig())
    await expect(
      quoteNftToNft(ctx, { ...ARGS, buy: { collection: SELL_COLLECTION, count: 1 } }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  })

  it('sell.tokenIds: [] ⇒ INVALID_PARAMS', async () => {
    const { ctx } = buildTwoLegEnv(baseConfig())
    await expect(
      quoteNftToNft(ctx, { ...ARGS, sell: { collection: SELL_COLLECTION, tokenIds: [] } }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  })

  it('buy.count: 0 ⇒ INVALID_PARAMS', async () => {
    const { ctx } = buildTwoLegEnv(baseConfig())
    await expect(
      quoteNftToNft(ctx, { ...ARGS, buy: { collection: BUY_COLLECTION, count: 0 } }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  })

  it('an invalid remainder mode ⇒ INVALID_PARAMS', async () => {
    const { ctx } = buildTwoLegEnv(baseConfig())
    await expect(
      quoteNftToNft(ctx, { ...ARGS, remainder: 'eth' as unknown as 'native' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  })

  it('priceImpact uses crossPoolPriceImpact and stays within [0, 100]', async () => {
    const { ctx } = buildTwoLegEnv(baseConfig())
    const quote = await quoteNftToNft(ctx, ARGS)
    expect(quote.priceImpact).toBeGreaterThanOrEqual(0)
    expect(quote.priceImpact).toBeLessThanOrEqual(100)
  })

  it('reconciles: reconstructed pool ± marketplace ± royalty must equal the Router totals, or the call throws', async () => {
    const cfg = baseConfig({ sell: { routerTotal: 999n, poolLeg: 100n } })
    const { ctx } = buildTwoLegEnv(cfg)
    await expect(quoteNftToNft(ctx, ARGS)).rejects.toMatchObject({ code: 'QUOTE_RECONCILIATION_FAILED' })
  })

  it('a buy count deeper than the pool yields bestEffort: true and deliverable < count', async () => {
    const cfg = baseConfig()
    const { ctx } = buildTwoLegEnv({
      ...cfg,
      buy: { ...cfg.buy, reserves: { base: 1_000n * 10n ** 18n, wnft: 2n * 10n ** 18n } },
    })
    const quote = await quoteNftToNft(ctx, { ...ARGS, buy: { collection: BUY_COLLECTION, count: 5 } })
    expect(quote.bestEffort).toBe(true)
    expect(quote.deliverable).toBeLessThan(5)
  })
})
