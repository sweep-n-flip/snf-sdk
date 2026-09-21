#!/usr/bin/env node
// examples/vanilla/src/index.mjs
//
// R1's no-React proof: `@sweepnflip/sdk`'s core runs on bare Node with `viem` as its
// ONLY peer — see package.json (no react, no wagmi anywhere in this example's own
// dependency tree) and README.md for the depth-10 `pnpm list` proof. This script
// quotes a real buy of 3 NFTs from the live Base ETH/DEMON pool and prints the
// reconciled fee breakdown. No key, no signer, no SnF server — a read-only quote
// against a public RPC.
//
// Run: `pnpm -C examples/vanilla start` (or `node src/index.mjs` from this folder).

import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { createSnfClient, describeError } from '@sweepnflip/sdk'

// A public, no-key Base RPC. The chain registry's own `defaultRpcUrl` for chainId
// 8453 (packages/sdk/src/chains/registry.ts) is `mainnet.base.org`, but that free
// tier rate-limits (HTTP 429) under this script's handful of sequential multicalls
// (collection -> poolInventory -> quoteBuy, each its own read); publicnode's mirror
// does not. A partner may override with their own RPC via BASE_RPC_URL — the SDK
// itself never reads process.env; this EXAMPLE does, because the publicClient is
// always the caller's, never the SDK's own (D-04).
const RPC = process.env.BASE_RPC_URL ?? 'https://base-rpc.publicnode.com'
const DEMON_COLLECTION = '0x7e50af303A0422ebec6bc198034A2430bBe0195c'

try {
  const publicClient = createPublicClient({ chain: base, transport: http(RPC) })
  const snf = createSnfClient({ chainId: 8453, publicClient })

  const col = await snf.collection(DEMON_COLLECTION)
  if (col.pools.length === 0) throw new Error('DEMON collection currently has no pool on Base')

  const inv = await snf.poolInventory(col.pools[0].pair)
  if (inv.tokenIds.length < 3) {
    throw new Error(`pool only has ${inv.tokenIds.length} candidate tokenIds right now, need 3`)
  }

  const q = await snf.quoteBuy({ collection: col.address, tokenIds: inv.tokenIds.slice(0, 3) })
  if (q.reconciled !== true) throw new Error('quote did not reconcile against the Router on-chain read')

  console.log(`Sweep n' Flip — buy 3 ${col.labels.symbol} from pool ${col.pools[0].pair}\n`)
  console.log(`pool         bps=${q.fees.pool.bps} (${q.fees.pool.note})`)
  console.log(`marketplace  ${q.fees.marketplace.formatted}  (value=${q.fees.marketplace.value}n)`)
  console.log(`royalty      ${q.fees.royalty.formatted}  (value=${q.fees.royalty.value}n)`)
  console.log(`gross        ${q.totalCost.formatted}  (value=${q.totalCost.value}n)`)
  console.log(`deliverable  ${q.deliverable}`)
  console.log(`bestEffort   ${q.bestEffort}`)
  console.log(`priceImpact  ${q.priceImpact}`)
  console.log(`reconciled: ${q.reconciled}`)
} catch (e) {
  const described = describeError(e)
  console.error(`Error [${described.code}]: ${described.message}`)
  process.exit(1)
}
