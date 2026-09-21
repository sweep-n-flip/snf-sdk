'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createPublicClient, http } from 'viem'
import type { Chain, PublicClient } from 'viem'
import { base } from 'viem/chains'
import { WagmiProvider, createConfig, http as wagmiHttp } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { SnfProvider } from '@sweepnflip/sdk-react'

/**
 * examples/next-app/src/app/providers.tsx
 *
 * The composition a partner copies verbatim (D-11's own truth): `WagmiProvider` ->
 * `QueryClientProvider` -> `SnfProvider`, in that order. Each layer has exactly one
 * job, and none of them shares a transport with another:
 *
 *   1. `WagmiProvider` — wallet connection + tx signing/sending. Its `injected()`
 *      connector needs no WalletConnect project id to work locally against any
 *      EIP-1193 wallet (MetaMask, Rabby, ...). Add `walletConnect({ projectId })`
 *      here (from `wagmi/connectors`) for QR/mobile support — the project id is the
 *      ONE legitimate `NEXT_PUBLIC_` value in this whole example (see .env.example).
 *   2. `QueryClientProvider` — react-query's cache, which every `useSnf*` read hook
 *      is built on (R18).
 *   3. `SnfProvider` — mounts ONE `SnfClient` for this chain. The SDK NEVER creates
 *      its own transport (D-04): `publicClient` below is a plain viem client this
 *      app owns, entirely separate from wagmi's own internal transport. A partner
 *      is free to point wagmi and the SDK's `publicClient` at two different RPCs.
 */

// A public, keyless Base RPC. Override via NEXT_PUBLIC_RPC_URL (see .env.example) —
// this is the ONLY place this example reads that variable; @sweepnflip/sdk itself
// never reads process.env (D-04).
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'https://base-rpc.publicnode.com'

const wagmiConfig = createConfig({
  chains: [base],
  connectors: [injected()],
  transports: { [base.id]: wagmiHttp(RPC_URL) },
})

// `base as Chain` (not the literal `typeof base`) — `base`'s OP-stack chain
// formatters add a `deposit` transaction-type variant to `getBlock()`'s inferred
// return shape that the SDK's generically-typed `publicClient: PublicClient`
// (viem's own default `Chain | undefined` generic, unresolved) does not carry.
// This is a documented viem/OP-stack TypeScript rough edge, not an SDK bug — widen
// at construction, the same way a partner integrating any OP-stack chain
// (Base, Robinhood Chain, ...) would.
const publicClient: PublicClient = createPublicClient({ chain: base as Chain, transport: http(RPC_URL) })

export function Providers({ children }: { readonly children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <SnfProvider chainId={base.id} publicClient={publicClient}>
          {children}
        </SnfProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
