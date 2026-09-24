#!/usr/bin/env node
// examples/vanilla/src/index.mjs
//
// this rule's no-React proof: `@sweepnflip/sdk`'s core runs on bare Node with `viem` as its
// ONLY peer — see package.json (no react, no wagmi anywhere in this example's own
// dependency tree) and README.md for the depth-10 `pnpm list` proof. This script
// quotes a real buy of 3 NFTs from the live Base ETH/DEMON pool, prints the
// reconciled fee breakdown, then builds and pre-flights an ExecutionPlan for that
// same buy — the exact sequence the root README's `## Quickstart` shows. No key, no
// signer, no SnF server — every call here is a read against a public RPC.
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
// always the caller's, never the SDK's own.
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
  console.log(`pool bps=${q.fees.pool.bps} (${q.fees.pool.note})`)
  console.log(`marketplace ${q.fees.marketplace.formatted} (value=${q.fees.marketplace.value}n)`)
  console.log(`royalty ${q.fees.royalty.formatted} (value=${q.fees.royalty.value}n)`)
  console.log(`gross ${q.totalCost.formatted} (value=${q.totalCost.value}n)`)
  console.log(`deliverable ${q.deliverable}`)
  console.log(`bestEffort ${q.bestEffort}`)
  console.log(`priceImpact ${q.priceImpact}`)
  console.log(`reconciled: ${q.reconciled}`)

  // The rest of the README's Quickstart (`## Quickstart`, root README.md): building
  // and pre-flighting a plan are BOTH read-only — `buildBuy` re-quotes on-chain and
  // computes unsigned calldata, `preflight()` is one Multicall3 read (ownership,
  // pool-holds, wrapper identity, balance, chain) — neither needs a private key or a
  // signer. This is why this script can demonstrate the full sequence up to (but
  // never including) the actual send. `recipient` defaults to the well-known Base
  // burn address purely as a stand-in for "some real, on-chain address" — this
  // example never holds a key, so it cannot itself sign the last step regardless of
  // what `recipient` is set to. Set RECIPIENT_ADDRESS to your own address to preflight
  // against your own balance instead.
  const recipient = process.env.RECIPIENT_ADDRESS ?? '0x000000000000000000000000000000000000dEaD'
  try {
    const plan = await snf.buildBuy({ quote: q, recipient, slippageBps: 100 })
    await plan.preflight()
    console.log(`\nplan ready: ${plan.steps.length} step(s) (${plan.steps.map((s) => s.kind).join(', ')})`)
    console.log('send each step in plan.steps with your own wallet — one click per step (see examples/next-app)')
  } catch (e) {
    const described = describeError(e)
    console.log(`\nbuildBuy/preflight demo (recipient ${recipient}): [${described.code}] ${described.message}`)
    console.log('set RECIPIENT_ADDRESS to a funded address to see a successful pre-flight')
  }
} catch (e) {
  const described = describeError(e)
  console.error(`Error [${described.code}]: ${described.message}`)
  process.exit(1)
}
