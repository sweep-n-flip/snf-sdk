import type { Abi } from 'viem'

import { ERC721_ABI } from '../abis/ERC721'
import { IERC2981_ABI, IERC2981_INTERFACE_ID } from '../abis/IERC2981'
import { ROUTER02_COLLECTION_ABI } from '../abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../abis/UniswapV2Router01CollectionNativeERC20'
import type { RoyaltyInfo } from '../types/collection.types'
import type { SnfClientContext } from '../types/client.types'

/**
 * Reconstructs EIP-2981 royalty exactly the way the Router computes it
 * (`RoyaltyHelper.sol`), including the `capBps === 0` ⇒ zero-royalty footgun and the
 * `capRoyaltyFee=false` pin (this function never sends
 * `capRoyaltyFee=true` anywhere; every mention of that flag below is a comment or a
 * warning string). Ported from the production AMM client's own royalty-resolution
 * hooks.
 *
 * ONE call determines the SHAPE of a collection's royalty (does it implement 2981,
 * flat or per-token, capped at what) — it is NOT the quote path. The quote
 * functions re-read `royaltyInfo` per id at the REAL sale price; a per-token
 * collection's `bps`/`receiver` here are illustrative (first sampled id only, always
 * accompanied by a `'per-token'` warning), never authoritative for a charge.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
/** `1e18` — the probe sale price (RoyaltyHelper.sol's `100e16` scale is the same value
 * spelled as a percentage). Reading at a large, fixed price keeps the bps reading free
 * of integer-rounding noise a caller-chosen tiny `salePrice` could introduce — a
 * uniform-rate collection must never look `'per-token'` purely from rounding. */
const PROBE_SALE_PRICE = 10n ** 18n
/** `royaltyFeeCap` is scaled `1e18 = 100%`; `raw * 10000n / 1e18n` converts to bps. */
const ROYALTY_SCALE = 10n ** 18n
/** No usable cap read ⇒ fail-safe as "no effective cap" (100%), matching
 * the production AMM client's own convention — defaulting to
 * `0` instead would silently look identical to a genuine on-chain cap-zero footgun. */
const NO_CAP_BPS = 10_000
const MAX_SAMPLE_IDS = 5

export interface ResolveRoyaltyOptions {
  readonly sampleTokenIds?: readonly bigint[]
  readonly salePrice?: bigint
}

export function resolveRoyalty(
  ctx: SnfClientContext,
  collection: `0x${string}`,
  opts?: ResolveRoyaltyOptions,
): Promise<RoyaltyInfo> {
  const salePrice = opts?.salePrice ?? PROBE_SALE_PRICE
  const sampleIds = (opts?.sampleTokenIds && opts.sampleTokenIds.length > 0 ? opts.sampleTokenIds : [1n]).slice(
    0,
    MAX_SAMPLE_IDS,
  )
  const routerAbi = ctx.chain.routerVariant === 'native-erc20' ? ROUTER_NATIVE_ERC20_ABI : ROUTER02_COLLECTION_ABI

  return probe(ctx, collection, salePrice, sampleIds, routerAbi)
}

/** Loosely-typed multicall call shape — this probe batches THREE different ABIs
 * (ERC721's `supportsInterface`, the Router's `royaltyFeeCap`, IERC2981's
 * `royaltyInfo`) into one array, which viem's per-position tuple inference cannot
 * type-check precisely when the array is built from a fixed prefix plus a
 * variable-length `.map()` spread (a known viem generic-inference limitation for
 * heterogeneous multicall batches). Each entry's `abi`/`functionName`/`args` is still
 * hand-verified against its real ABI at the call site below. */
interface MulticallCallLike {
  readonly address: `0x${string}`
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
}

type MulticallReadResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

async function probe(
  ctx: SnfClientContext,
  collection: `0x${string}`,
  salePrice: bigint,
  sampleIds: readonly bigint[],
  routerAbi: typeof ROUTER02_COLLECTION_ABI | typeof ROUTER_NATIVE_ERC20_ABI,
): Promise<RoyaltyInfo> {
  const contracts: readonly MulticallCallLike[] = [
    { address: collection, abi: ERC721_ABI, functionName: 'supportsInterface', args: [IERC2981_INTERFACE_ID] },
    { address: ctx.chain.router02, abi: routerAbi, functionName: 'royaltyFeeCap', args: [collection] },
    ...sampleIds.map((id) => ({
      address: collection,
      abi: IERC2981_ABI,
      functionName: 'royaltyInfo',
      args: [id, salePrice],
    })),
  ]

  // ONE multicall for the whole probe (— no per-field RPC amplification): a
  // spy in the test suite asserts this is called exactly once.
  let results: readonly MulticallReadResult[]
  try {
    results = await ctx.publicClient.multicall({
      contracts,
      allowFailure: true,
      multicallAddress: ctx.chain.multicall3,
      batchSize: 0,
    })
  } catch {
    // The whole RPC round-trip failed — "we could not tell", never conflated with a
    // definitive "this collection has no royalty".
    return {
      bps: 0,
      receiver: null,
      capBps: 0,
      effectiveBpsWhenCapped: 0,
      basis: 'collection-default',
      unpayableReceiver: false,
      warnings: ['The royalty probe could not be read (RPC failure) — this is NOT the same as "no royalty".'],
      probeFailed: true,
    }
  }

  const [supportsResult, capResult, ...royaltyResults] = results
  const { capBps, capWarning } = readCap(capResult)
  const supportsEip2981 = supportsResult?.status === 'success' && supportsResult.result === true

  if (!supportsEip2981) {
    return {
      bps: 0,
      receiver: null,
      capBps,
      effectiveBpsWhenCapped: 0,
      basis: 'collection-default',
      unpayableReceiver: false,
      warnings: capWarning ? [capWarning] : [],
      probeFailed: false,
    }
  }

  const perId = sampleIds
    .map((id, index) => ({ id, entry: readRoyaltyInfo(royaltyResults[index], salePrice) }))
    .filter((row): row is { id: bigint; entry: { bps: number; receiver: `0x${string}` } } => row.entry !== undefined)
  const revertedCount = sampleIds.length - perId.length

  const warnings: string[] = []
  if (capWarning) warnings.push(capWarning)
  if (revertedCount > 0) {
    warnings.push(
      `royaltyInfo reverted for ${String(revertedCount)} of ${String(sampleIds.length)} sampled tokenId(s); those ids were skipped.`,
    )
  }

  if (perId.length === 0) {
    // supportsInterface said yes, but not a single sampled id could actually be read —
    // a genuine "we could not tell", not "no royalty".
    warnings.push('supportsInterface(0x2a55205a) returned true, but royaltyInfo could not be read for any sampled tokenId.')
    return {
      bps: 0,
      receiver: null,
      capBps,
      effectiveBpsWhenCapped: 0,
      basis: 'collection-default',
      unpayableReceiver: false,
      warnings,
      probeFailed: true,
    }
  }

  const allSameBps = perId.every((row) => row.entry.bps === perId[0]?.entry.bps)
  const basis: RoyaltyInfo['basis'] = allSameBps ? 'collection-default' : 'per-token'
  if (!allSameBps) {
    warnings.push(
      'Sampled tokenIds return different royalty rates ("per-token") — never quote this collection with one averaged rate; re-read royaltyInfo per id at the real sale price.',
    )
  }

  const bps = perId[0]?.entry.bps ?? 0
  const receiver = perId[0]?.entry.receiver ?? null
  const unpayableReceiver = receiver !== null && receiver.toLowerCase() === ZERO_ADDRESS
  if (unpayableReceiver) {
    warnings.push(
      "This collection's EIP-2981 receiver is the zero address — on Arc the Router's _unpayableRoyalties path drops this amount (not charged to a buyer, kept by a seller); a preview that ignored this would overstate the buy cost.",
    )
  }

  const effectiveBpsWhenCapped = capBps === 0 ? 0 : Math.min(bps, capBps)

  return { bps, receiver, capBps, effectiveBpsWhenCapped, basis, unpayableReceiver, warnings, probeFailed: false }
}

function readCap(
  capResult: { readonly status: 'success' | 'failure'; readonly result?: unknown } | undefined,
): { capBps: number; capWarning: string | undefined } {
  if (capResult?.status !== 'success' || typeof capResult.result !== 'bigint') {
    return {
      capBps: NO_CAP_BPS,
      capWarning: "The Router's royaltyFeeCap could not be read — treated as no effective cap (fail-safe).",
    }
  }
  const raw = capResult.result
  const capBps = Number((raw * 10_000n) / ROYALTY_SCALE)
  if (capBps === 0) {
    return {
      capBps: 0,
      capWarning:
        "The Router's royaltyFeeCap for this collection is 0, so a call with capRoyaltyFee=true would pay the creator nothing; this SDK pins capRoyaltyFee=false in v1.",
    }
  }
  return { capBps, capWarning: undefined }
}

function readRoyaltyInfo(
  result: { readonly status: 'success' | 'failure'; readonly result?: unknown } | undefined,
  salePrice: bigint,
): { bps: number; receiver: `0x${string}` } | undefined {
  if (result?.status !== 'success' || !Array.isArray(result.result) || result.result.length < 2) return undefined
  const [receiver, amount] = result.result as [`0x${string}`, bigint]
  if (typeof receiver !== 'string' || typeof amount !== 'bigint' || salePrice <= 0n) return undefined
  const bps = Number((amount * 10_000n) / salePrice)
  return { bps, receiver }
}
