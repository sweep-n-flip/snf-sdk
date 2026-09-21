import { getAddress, parseEventLogs, type Log } from 'viem'

import { ERC20_ABI } from '../abis/ERC20'
import { ERC721_ABI } from '../abis/ERC721'
import { PAIR_ABI } from '../abis/UniswapV2Pair'
import { WETH9_ABI } from '../abis/WETH9'
import { describeError } from '../describeError'
import { toNativeAmount } from '../format'
import type { SnfClientContext } from '../types/client.types'
import type { ReceiptLike, SwapReceipt } from './receipt.types'

/**
 * Attributes `itemsIn`/`itemsOut`/fees from an already-mined receipt's own
 * `Transfer`/`Withdrawal`/`Deposit`/`Swap` logs (R16). Synchronous — the logs are
 * already on the receipt, so no further RPC read happens here.
 *
 * ## What this function can honestly attribute from logs alone, and what it cannot
 *
 * `itemsIn`/`itemsOut` (ERC-721 `Transfer` logs) and the pool-only leg (WETH
 * `Withdrawal`/`Deposit`, cross-checked against the pair's `Swap`) are always
 * recoverable — every SnF Router sell/buy leg emits them. The Router's marketplace
 * fee and creator royalty are a DIFFERENT story: both are paid via
 * `TransferHelper.safeTransferETH`/`safeTransferETHBatch` — a raw native transfer
 * with **no log at all** for a plain EOA receiver (`snf-contracts/contracts/
 * periphery/UniswapV2Router01Collection.sol:270-274`,`296-300`). The ONLY case this
 * function can attribute the marketplace fee from a log is when the marketplace
 * wallet happens to be a contract that itself logs on receipt — a Gnosis Safe does
 * (`SafeReceived`), and two of the workspace's fourteen chains (Base, BNB Chain; see
 * workspace root CLAUDE.md's governance table) use exactly that. Everywhere else, and
 * for creator royalty on every chain (paid to an arbitrary, usually-EOA receiver),
 * there is no generic log signal — `snf-drops-registration/.../sellReceipt.ts`'s
 * `parseSellReceipt` only recovers these because it is handed FROZEN quote-time rates
 * (`marketplaceFeeE18`/`royaltyE18`) as explicit input; this function's `(ctx,
 * receipt)` signature carries no such rates (D-01: `parseReceipt` takes no `quote`
 * argument), and a synchronous function cannot perform the live read that would
 * supply them.
 *
 * The doctrine this file follows over reproducing an exact number it cannot honestly
 * derive: attribute what the logs prove, and disclose — via `warnings`, never a
 * silent zero presented as measured — whatever they don't. See
 * `snf-54-08-SUMMARY.md`'s Deviations section for the full account, including why
 * `test/fixtures/receipts/sell-3.json`'s `received` is the fee-only net rather than
 * the collection's true (fee+royalty) net.
 *
 * A pure wNFT (fractional wrapper) leg has NO ERC-721 `Transfer` logs at all — the
 * wrapper token's own `Transfer` is ERC-20-shaped (2 indexed args + a non-indexed
 * `value`), which the ERC-721 ABI above never matches. `itemsIn`/`itemsOut` therefore
 * stay empty for that leg BY DESIGN (this function has no notion of "the wrapper
 * token" as a distinct concept from any other ERC-20). What used to be broken
 * (Finding 3, `snf-54-18-SUMMARY.md`; fixed in `snf-54-18F`) is that `received`/`paid`
 * ALSO stayed `undefined` in that case, even when the pool-side WETH `Withdrawal`/
 * `Deposit` log proved real settlement happened — the gating condition below keyed
 * exclusively off `itemsIn`/`itemsOut`. The fix detects a fungible leg generically
 * from the SAME receipt's own pair `Swap` log (no wrapper address needed as input):
 * an ERC-20 `Transfer` INTO that pair from a non-zero address is a fungible sell leg;
 * one OUT OF that pair to a non-zero address is a fungible buy leg. The zero-address
 * exclusion is what keeps a wrapper's internal mint/burn accounting step (address(0)
 * <-> pair, part of every whole-NFT `*Collection` swap's own bookkeeping —
 * `sell-3.json`'s own mint log is exactly this) from being mistaken for money
 * actually changing hands.
 *
 * `status: 'reverted'` throws a typed `SnfError` via `describeError` (plan 07) rather
 * than re-implementing the revert-reason mapping — `INSUFFICIENT_OUTPUT_AMOUNT` when
 * the receipt carries decodable revert data, `UNKNOWN` otherwise (a mined revert's
 * logs are empty by EVM design, so most reverted receipts have nothing to decode).
 */
export function parseReceipt(ctx: SnfClientContext, receipt: ReceiptLike): SwapReceipt {
  if (receipt.status === 'reverted') {
    throw describeError(receipt)
  }

  const router = getAddress(ctx.chain.router02)
  const warnings: string[] = []

  const transfers = parseTransfers(receipt.logs)
  const itemsIn: string[] = []
  const itemsOut: string[] = []
  for (const transfer of transfers) {
    const from = getAddress(transfer.args.from)
    const to = getAddress(transfer.args.to)
    // Deposited INTO the Router (a sell leg's seller -> Router step) vs. released to
    // whoever isn't the Router (a buy leg's wrapper -> buyer step, or any other
    // recipient). A transfer FROM the Router (Router -> wrapper, the internal mint
    // step of a sell) is neither — it moves nothing in or out of the trade's two
    // parties and is deliberately excluded from both arrays.
    if (to === router) itemsIn.push(transfer.args.tokenId.toString())
    else if (from !== router) itemsOut.push(transfer.args.tokenId.toString())
  }

  const withdrawals = parseWithdrawals(receipt.logs).filter(
    (log) => sameAddress(log.address, ctx.chain.quoteToken) && sameAddress(log.args.src, router),
  )
  const deposits = parseDeposits(receipt.logs).filter(
    (log) => sameAddress(log.address, ctx.chain.quoteToken) && sameAddress(log.args.dst, router),
  )
  const grossWithdrawn = sumWad(withdrawals)
  const grossDeposited = sumWad(deposits)

  const swaps = parseSwaps(receipt.logs)
  reconcileAgainstPoolLeg(swaps, grossWithdrawn, grossDeposited, warnings)

  // Fungible (wNFT/wrapper) leg detection — see this file's header for why this is
  // generic (no wrapper address as input) and why the zero-address exclusion matters.
  const pairAddress = swaps[0]?.address
  const erc20Transfers = parseErc20Transfers(receipt.logs).filter(
    (t) => !sameAddress(t.address, ctx.chain.quoteToken),
  )
  const hasFungibleInLeg =
    pairAddress !== undefined &&
    erc20Transfers.some((t) => sameAddress(t.args.to, pairAddress) && !isZeroAddress(t.args.from))
  const hasFungibleOutLeg =
    pairAddress !== undefined &&
    erc20Transfers.some((t) => sameAddress(t.args.from, pairAddress) && !isZeroAddress(t.args.to))

  const marketplaceFeeWei = attributeMarketplaceFee(receipt.logs, router)
  if (marketplaceFeeWei === undefined) {
    warnings.push(
      "Marketplace fee could not be attributed from this receipt's logs (the marketplace wallet emitted no receipt event on this chain); reported as 0.",
    )
  }
  const marketplaceFee = marketplaceFeeWei ?? 0n

  warnings.push(
    "Creator royalty could not be attributed from this receipt's logs (paid via a raw native transfer with no log); reported as 0.",
  )

  const chainId = ctx.chain.chainId
  const fees = {
    marketplace: toNativeAmount(chainId, marketplaceFee),
    royalty: toNativeAmount(chainId, 0n),
  }

  let received: SwapReceipt['received']
  let paid: SwapReceipt['paid']
  if ((itemsIn.length > 0 || hasFungibleInLeg) && grossWithdrawn > 0n) {
    received = toNativeAmount(chainId, grossWithdrawn - marketplaceFee)
    warnings.push('received excludes any creator royalty deduction, which could not be attributed from logs.')
  } else if ((itemsOut.length > 0 || hasFungibleOutLeg) && grossDeposited > 0n) {
    paid = toNativeAmount(chainId, grossDeposited + marketplaceFee)
    warnings.push('paid excludes any creator royalty addition, which could not be attributed from logs.')
  }

  if (transfers.length === 0 && withdrawals.length === 0 && deposits.length === 0 && erc20Transfers.length === 0) {
    return {
      itemsIn: [],
      itemsOut: [],
      fees: { marketplace: toNativeAmount(chainId, 0n), royalty: toNativeAmount(chainId, 0n) },
      txInvalidationVersion: ctx.nextTxInvalidationVersion(),
      blockNumber: receipt.blockNumber,
      warnings: ['No recognisable Transfer/Withdrawal/Deposit/Swap logs were found in this receipt.'],
    }
  }

  return {
    itemsIn,
    itemsOut,
    ...(paid !== undefined ? { paid } : {}),
    ...(received !== undefined ? { received } : {}),
    fees,
    txInvalidationVersion: ctx.nextTxInvalidationVersion(),
    blockNumber: receipt.blockNumber,
    warnings,
  }
}

function sameAddress(a: `0x${string}`, b: `0x${string}`): boolean {
  return getAddress(a) === getAddress(b)
}

function sumWad(events: readonly { readonly args: { readonly wad: bigint } }[]): bigint {
  return events.reduce((sum, event) => sum + event.args.wad, 0n)
}

function parseTransfers(logs: readonly Log[]) {
  try {
    return parseEventLogs({ abi: ERC721_ABI, eventName: 'Transfer', logs: [...logs] })
  } catch {
    return []
  }
}

/** ERC-20-shaped `Transfer` logs (2 indexed args + a non-indexed `value`) — the
 * wrapper token's own transfer shape, distinct from the ERC-721 `Transfer` above
 * (`parseTransfers`) even though both events share the same topic0 signature. viem's
 * `parseEventLogs` discriminates by matching each log's actual topic COUNT against
 * what each ABI's indexed-arg layout expects, so a 4-topic ERC-721 transfer never
 * matches here and a 3-topic ERC-20 transfer never matches `parseTransfers` above. */
function parseErc20Transfers(logs: readonly Log[]) {
  try {
    return parseEventLogs({ abi: ERC20_ABI, eventName: 'Transfer', logs: [...logs] })
  } catch {
    return []
  }
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

function isZeroAddress(address: `0x${string}`): boolean {
  return getAddress(address) === ZERO_ADDRESS
}

function parseWithdrawals(logs: readonly Log[]) {
  try {
    return parseEventLogs({ abi: WETH9_ABI, eventName: 'Withdrawal', logs: [...logs] })
  } catch {
    return []
  }
}

function parseDeposits(logs: readonly Log[]) {
  try {
    return parseEventLogs({ abi: WETH9_ABI, eventName: 'Deposit', logs: [...logs] })
  } catch {
    return []
  }
}

function parseSwaps(logs: readonly Log[]) {
  try {
    return parseEventLogs({ abi: PAIR_ABI, eventName: 'Swap', logs: [...logs] })
  } catch {
    return []
  }
}

/** Cross-checks the WETH-derived gross against the pair's own `Swap` log — a
 * mismatch means this receipt moved more than the one hop this function models
 * (multi-hop, delegate routing) and the derived figures above should be read with
 * that in mind. Never blocks the return; only annotates `warnings`. `swaps` is
 * parsed once by the caller (`parseReceipt`) and reused here and for fungible-leg
 * detection — never re-parsed. */
function reconcileAgainstPoolLeg(
  swaps: ReturnType<typeof parseSwaps>,
  grossWithdrawn: bigint,
  grossDeposited: bigint,
  warnings: string[],
): void {
  if (swaps.length === 0) return
  const poolOut = swaps.reduce(
    (sum, log) => sum + (log.args.amount0Out > 0n ? log.args.amount0Out : log.args.amount1Out),
    0n,
  )
  const poolIn = swaps.reduce(
    (sum, log) => sum + (log.args.amount0In > 0n ? log.args.amount0In : log.args.amount1In),
    0n,
  )
  if (grossWithdrawn > 0n && poolOut > 0n && poolOut !== grossWithdrawn) {
    warnings.push(
      "The pair Swap log's pool-out leg does not match the WETH Withdrawal amount — this receipt may involve more than one hop.",
    )
  }
  if (grossDeposited > 0n && poolIn > 0n && poolIn !== grossDeposited) {
    warnings.push(
      "The pair Swap log's pool-in leg does not match the WETH Deposit amount — this receipt may involve more than one hop.",
    )
  }
}

// Gnosis Safe v1.3+'s `SafeReceived(address indexed sender, uint256 value)` — a
// generic, well-known signature (not SnF-specific). Whenever a chain's marketplace
// wallet happens to be a Safe (Base, BNB Chain per workspace root CLAUDE.md's
// governance table), the fee arrives with a real log to attribute from. An EOA
// marketplace wallet emits nothing on a plain native transfer — see this module's
// header for why that case is `undefined` here, never a guess.
const SAFE_RECEIVED_TOPIC = '0x3d0ce9bfc3ed7d6862dbb28b2dea94561fe714a1b4d019aa8af39730d1ad7c3d'

function attributeMarketplaceFee(logs: readonly Log[], router: `0x${string}`): bigint | undefined {
  const matches = logs.filter((log) => {
    const topic0 = log.topics[0]
    const senderTopic = log.topics[1]
    if (topic0 !== SAFE_RECEIVED_TOPIC || !senderTopic) return false
    return sameAddress(addressFromTopic(senderTopic), router)
  })
  if (matches.length === 0) return undefined
  return matches.reduce((sum, log) => sum + BigInt(log.data), 0n)
}

function addressFromTopic(topic: `0x${string}`): `0x${string}` {
  return `0x${topic.slice(-40)}`
}
