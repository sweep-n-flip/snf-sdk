'use client'

import { useCallback, useState } from 'react'
import type { CSSProperties } from 'react'
import { isAddress } from 'viem'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import {
  useSnfClient,
  useSnfCollection,
  useSnfPoolInventory,
  useSnfQuoteBuy,
  useSnfCheckout,
} from '@sweepnflip/sdk-react'
import type { ExecutionPlan, Quote, SnfClient, SnfError } from '@sweepnflip/sdk'

/**
 * examples/next-app/src/components/SwapPanel.tsx
 *
 * One client component, four sections, discovery -> inventory -> quote -> checkout
 *. Every read goes through a `useSnf*` hook; the ONLY wallet dispatch in this
 * whole file happens inside `useSnfCheckout` itself, from the explicit click on
 * `CheckoutFlow`'s single button — never from a `useEffect` here (INV-17). This file
 * has zero `useEffect` calls; react-query's own hooks already refetch declaratively,
 * and building a plan is a deliberate button click, not a side effect of rendering.
 */

// The Base ETH/DEMON pool this monorepo's own fixtures pin down
// (packages/sdk/test/fixtures/collections/base-demon.json) — a real, live collection
// with a real pool, so this page shows real numbers on first load.
const DEFAULT_COLLECTION = '0x7e50af303A0422ebec6bc198034A2430bBe0195c'

const sectionStyle: CSSProperties = {
  border: '1px solid #333',
  borderRadius: 8,
  padding: 16,
  marginTop: 16,
}

function ConnectRow() {
  const { address, isConnected } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()

  if (isConnected && address) {
    return (
      <div style={sectionStyle}>
        <span>Connected: {address}</span>
        <button style={{ marginLeft: 12 }} onClick={() => disconnect()}>
          Disconnect
        </button>
      </div>
    )
  }

  const injectedConnector = connectors.find((c) => c.id === 'injected')

  return (
    <div style={sectionStyle}>
      <button
        disabled={!injectedConnector || isPending}
        onClick={() => injectedConnector && connect({ connector: injectedConnector })}
      >
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </button>
    </div>
  )
}

function CollectionSection({
  address,
  onAddressChange,
}: {
  readonly address: string
  readonly onAddressChange: (value: string) => void
}) {
  const valid = isAddress(address)
  const collection = useSnfCollection(valid ? (address as `0x${string}`) : undefined)

  return (
    <div style={sectionStyle}>
      <h2>1. Collection</h2>
      <input style={{ width: '100%' }} value={address} onChange={(e) => onAddressChange(e.target.value)} />
      {collection.isLoading && <p>Resolving…</p>}
      {collection.error && (
        <p>
          Error: {collection.error.code} — {collection.error.message}
        </p>
      )}
      {collection.data && (
        <ul>
          {/* `labels.name`/`labels.symbol` are ALREADY the resolved display identity —
              never render `address` itself as a name (the workspace's own collection-
              identity doctrine). This SDK's CollectionLabels type does not (yet)
              surface a `nameIsFallback` flag the way the production app's own
              waterfall does; flagged as a finding in this plan's SUMMARY rather than
              widened here. */}
          <li>
            Name: {collection.data.labels.name} ({collection.data.labels.symbol})
          </li>
          <li>Wrapper verified: {collection.data.wrapperVerified}</li>
          <li>Redemption locked: {String(collection.data.redemptionLocked)}</li>
          <li>
            Royalty: {(collection.data.royalty.bps / 100).toFixed(2)}%
            {collection.data.royalty.capBps === 0 && ' — no on-chain cap set on this Router'}
          </li>
        </ul>
      )}
    </div>
  )
}

function InventorySection({ pair }: { readonly pair: `0x${string}` | undefined }) {
  // Candidate data only — "the index proposes, the chain decides" (poolInventory's
  // own doc comment). `plan.preflight()`, run in `CheckoutSection.handleBuildPlan`
  // right after `client.buildBuy` below, is what actually decides which tokenIds
  // are still there at signing time.
  const inventory = useSnfPoolInventory(pair)

  if (!pair) return null

  return (
    <div style={sectionStyle}>
      <h2>2. Inventory</h2>
      {inventory.data && (
        <ul>
          <li>Available: {inventory.data.availableCount}</li>
          <li>Source: {inventory.data.source}</li>
          <li>As of block: {inventory.data.asOfBlock.toString()}</li>
          <li>
            Lag: {inventory.data.lagSeconds}s {inventory.data.stale && <strong>(STALE)</strong>}
          </li>
        </ul>
      )}
    </div>
  )
}

function QuoteSection({
  collectionAddress,
  count,
  onCountChange,
}: {
  readonly collectionAddress: `0x${string}` | undefined
  readonly count: number
  readonly onCountChange: (value: number) => void
}) {
  const quote = useSnfQuoteBuy(collectionAddress ? { collection: collectionAddress, count } : undefined)

  return (
    <div style={sectionStyle}>
      <h2>3. Quote</h2>
      <label>
        Count:{' '}
        <input
          type="number"
          min={1}
          max={10}
          value={count}
          onChange={(e) => onCountChange(Number(e.target.value))}
        />
      </label>
      {quote.error && (
        <p>
          Error: {quote.error.code} — {quote.error.message}
        </p>
      )}
      {quote.data && (
        <ul>
          <li>Pool fee: {quote.data.fees.pool.bps} bps ({quote.data.fees.pool.note})</li>
          <li>
            Marketplace: {quote.data.fees.marketplace.formatted} (value={quote.data.fees.marketplace.value.toString()})
          </li>
          <li>
            Royalty: {quote.data.fees.royalty.formatted} (value={quote.data.fees.royalty.value.toString()})
          </li>
          <li>
            Gross: {quote.data.totalCost?.formatted} (value={quote.data.totalCost?.value.toString()})
          </li>
          <li>Price impact: {quote.data.priceImpact}%</li>
          <li>
            Deliverable: {quote.data.deliverable} / bestEffort: {String(quote.data.bestEffort)}
          </li>
          <li>Reconciled: {String(quote.data.reconciled)}</li>
        </ul>
      )}
    </div>
  )
}

function CheckoutFlow({ plan }: { readonly plan: ExecutionPlan }) {
  const checkout = useSnfCheckout(plan)

  return (
    <>
      <ol>
        {plan.steps.map((step) => (
          <li key={step.label}>{step.label}</li>
        ))}
      </ol>
      <p>State: {checkout.state}</p>
      {/* One click == one transaction. `next()` is called ONLY from this button's
          onClick — never from a useEffect/watcher in this file or inside
          useSnfCheckout itself. The button is disabled whenever `canProceed` is
          false, so a partner copying this exact pattern cannot wire an accidental
          auto-advance (INV-17; memory feedback_wagmi_reset_race). */}
      <button disabled={!checkout.canProceed} onClick={() => void checkout.next()}>
        {checkout.label}
      </button>
      {checkout.error && (
        <p>
          Error: {checkout.error.code} — {checkout.error.message}
        </p>
      )}
      {checkout.txHash && <p>tx: {checkout.txHash}</p>}
    </>
  )
}

function CheckoutSection({
  quote,
  address,
  client,
}: {
  readonly quote: Quote | undefined
  readonly address: `0x${string}` | undefined
  readonly client: SnfClient
}) {
  const [plan, setPlan] = useState<ExecutionPlan | null>(null)
  const [buildError, setBuildError] = useState<SnfError | null>(null)
  const [building, setBuilding] = useState(false)

  // `plan.preflight()` runs HERE, once, right after `buildBuy` — both are read-only
  // (no wallet popup, snf-54-20's README Quickstart demonstrates the identical
  // sequence in examples/vanilla). Gating `setPlan` on a successful pre-flight means
  // `<CheckoutFlow>` (and therefore `useSnfCheckout`'s one dispatch site) is never
  // even constructed for a plan whose ownership/inventory/wrapper-identity/balance/
  // chain checks already failed — e.g. Case E of snf-54-UAT.md (wrong chain) rejects
  // right here, before the checkout section renders a single button, let alone
  // before any wallet popup.
  const handleBuildPlan = useCallback(async () => {
    if (!address || !quote) return
    setBuilding(true)
    setBuildError(null)
    try {
      const builtPlan = await client.buildBuy({ quote, recipient: address })
      await builtPlan.preflight()
      setPlan(builtPlan)
    } catch (e) {
      setBuildError(client.describeError(e))
    } finally {
      setBuilding(false)
    }
  }, [address, quote, client])

  return (
    <div style={sectionStyle}>
      <h2>4. Checkout</h2>
      {!plan && (
        <>
          <button disabled={!address || !quote || building} onClick={() => void handleBuildPlan()}>
            {building ? 'Building…' : 'Build plan'}
          </button>
          {!address && <p>Connect a wallet first.</p>}
          {buildError && (
            <p>
              Error: {buildError.code} — {buildError.message}
            </p>
          )}
        </>
      )}
      {plan && <CheckoutFlow plan={plan} />}
    </div>
  )
}

export function SwapPanel() {
  const client = useSnfClient()
  const { address } = useAccount()

  const [collectionInput, setCollectionInput] = useState<string>(DEFAULT_COLLECTION)
  const [count, setCount] = useState(3)

  const validCollection = isAddress(collectionInput) ? (collectionInput as `0x${string}`) : undefined
  const collection = useSnfCollection(validCollection)
  const pair = collection.data?.pools[0]?.pair
  const quote = useSnfQuoteBuy(validCollection ? { collection: validCollection, count } : undefined)

  return (
    <div>
      <ConnectRow />
      <CollectionSection address={collectionInput} onAddressChange={setCollectionInput} />
      <InventorySection pair={pair} />
      <QuoteSection collectionAddress={validCollection} count={count} onCountChange={setCount} />
      <CheckoutSection quote={quote.data} address={address} client={client} />
    </div>
  )
}
