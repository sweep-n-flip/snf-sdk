import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { quoteBuy } from '../../src/quote/quoteBuy'
import { buildQuoteEnv, ZERO_ADDRESS } from '../quote/testHelpers'
import { resolveSubject } from './_subject'

/**
 * This rule: the SDK MUST NOT silently adjust a quote when the
 * on-chain reconciliation diverges (absorbing the delta into royalty or pool) — it
 * MUST throw `QUOTE_RECONCILIATION_FAILED` and return no `Quote` at all.
 *
 * `check_target`: packages/sdk/test/prohibitions/no-silent-reconcile.test.ts
 * `check_violation_fixture`: test/fixtures/prohib/reconcile-violation.ts
 * `check_clean_fixture`: test/fixtures/prohib/reconcile-clean.ts
 */

const PAIR = '0x000000000000000000000000000000000000FA17' as `0x${string}`
const WRAPPER = '0x000000000000000000000000000000000000BAD1' as `0x${string}`
const COLLECTION = '0x000000000000000000000000000000000000c011' as `0x${string}`

function reconciledFixture(deltaWei: bigint) {
  const reserves = { base: 1_297_217_522_559_477n, wnft: 11_883_323_065_263_036_728n }
  const poolLeg = 121_625_659_884_654n
  // marketplaceFeeE18 = 0 and every royaltyInfo amount = 0n -> reconstructed gross is
  // exactly poolLeg, so `routerGross = poolLeg + deltaWei` is an EXACT, controlled
  // divergence of `deltaWei` — no other fee component can absorb rounding noise.
  return buildQuoteEnv({
    pair: PAIR,
    wrapper: WRAPPER,
    collection: COLLECTION,
    reserves,
    marketplaceFeeE18: 0n,
    side: 'buy' as const,
    units: 10n ** 18n,
    poolLeg,
    routerTotal: poolLeg + deltaWei,
    perId: [{ tokenId: '1', receiver: ZERO_ADDRESS, amount: 0n }],
  })
}

describe('no-silent-reconcile — quoteBuy end to end', () => {
  it('a 1-wei-ABOVE divergence rejects with QUOTE_RECONCILIATION_FAILED and no Quote is returned', async () => {
    const { ctx } = reconciledFixture(1n)
    await expect(
      quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['1'], payToken: null }),
    ).rejects.toMatchObject({ code: 'QUOTE_RECONCILIATION_FAILED' })
  })

  it('a 1-wei-BELOW divergence also rejects (both directions, never a one-sided tolerance)', async () => {
    const { ctx } = reconciledFixture(-1n)
    let resolvedValue: unknown = 'UNSET'
    try {
      resolvedValue = await quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['1'], payToken: null })
    } catch (e) {
      expect((e as { code?: string }).code).toBe('QUOTE_RECONCILIATION_FAILED')
      resolvedValue = 'THREW'
    }
    expect(resolvedValue).toBe('THREW')
  })

  it('a 2-wei divergence also rejects — the exact size a "small tolerance" bug would be tempted to swallow', async () => {
    const { ctx } = reconciledFixture(2n)
    await expect(
      quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['1'], payToken: null }),
    ).rejects.toMatchObject({ code: 'QUOTE_RECONCILIATION_FAILED' })
  })

  it('the thrown SnfError.details carries deltaWei and both sides — the failure is diagnosable', async () => {
    const { ctx } = reconciledFixture(1n)
    let caught: unknown
    try {
      await quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['1'], payToken: null })
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({
      code: 'QUOTE_RECONCILIATION_FAILED',
      details: { deltaWei: 1n, reconstructed: expect.any(BigInt), router: expect.any(BigInt) },
    })
  })

  it('an EXACT match reconciles without throwing (the positive control)', async () => {
    const { ctx } = reconciledFixture(0n)
    const quote = await quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['1'], payToken: null })
    expect(quote.reconciled).toBe(true)
  })
})

describe('no-silent-reconcile — static scan: no tolerance vocabulary anywhere in the reconciliation path', () => {
  it('src/math/reconcile.ts and src/quote/*.ts contain zero occurrences of Math.abs, epsilon, tolerance, Number(parseFloat', () => {
    const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const targets = [
      path.join(pkgRoot, 'src/math/reconcile.ts'),
      ...readdirSync(path.join(pkgRoot, 'src/quote'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => path.join(pkgRoot, 'src/quote', f)),
    ]
    // Negative lookbehind on `Number(` avoids a false positive on a method name that
    // merely ENDS in "Number(" (e.g. `getBlockNumber()`, `royaltyCapE18Number()`) — the
    // banned pattern is the bare coercion call `Number(x)`, not any identifier suffix.
    const banned = [/Math\.abs/, /epsilon/i, /tolerance/i, /(?<![A-Za-z0-9_])Number\(/, /parseFloat/]
    const hits: string[] = []
    for (const file of targets) {
      const stripped = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(?<!:)\/\/.*$/gm, '')
      for (const re of banned) {
        if (re.test(stripped)) hits.push(`${path.basename(file)} matches ${re}`)
      }
    }
    expect(hits).toEqual([])
  })
})

describe('no-silent-reconcile — SNF_SDK_PROHIB_SUBJECT causation control (fixtures/prohib/reconcile-{clean,violation}.ts)', () => {
  interface ReconcileSubjectModule {
    readonly reconcileGross: (args: { readonly pool: bigint; readonly marketplace: bigint; readonly royalty: bigint; readonly routerGross: bigint }) => void
  }

  it('a 1-wei divergence throws against the resolved subject (RED on the violation fixture, which tolerates up to 2 wei)', async () => {
    const subject = await resolveSubject<ReconcileSubjectModule>('src/math/reconcile.ts')
    expect(() => subject.reconcileGross({ pool: 100n, marketplace: 0n, royalty: 0n, routerGross: 101n })).toThrow()
  })
})
