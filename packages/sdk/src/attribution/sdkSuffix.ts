import { concat } from 'viem'
import type { Hex } from 'viem'

import { toSdkCode } from './codes'
import { encodeAttribution } from './erc8021'
import type { SnfChainConfig } from '../chains/chains.types'
import type { SnfClientConfig } from '../types/client.types'
import type { Step, UnsignedTx } from '../types/plan.types'

/**
 * Internal glue between a client's `attribution` config and the calldata the build
 * pipeline emits. Not part of the public surface: partners reach attribution through
 * `createSnfClient({ attribution })` plus the public `encodeAttribution` /
 * `parseAttribution` helpers.
 */

/**
 * The data suffix every SnF-contract step of this client carries (`sdk` or
 * `sdk-<code>`). Best effort by design: `createSnfClient` already rejected a bad code
 * at construction, so this only fails for a context assembled by hand around an
 * unvalidated config — and then the step goes out UNTAGGED rather than failing.
 * Attribution must never be the reason a transaction cannot be built.
 */
export function attributionSuffixFor(config: Pick<SnfClientConfig, 'attribution'>): Hex | undefined {
  try {
    return encodeAttribution([toSdkCode(config.attribution?.code)])
  } catch {
    return undefined
  }
}

/** True when `to` is one of this chain's SnF contracts (Router02 or Factory) — the
 * only targets that are ever tagged. Token contracts (approvals) never are. */
export function isAttributedTarget(chain: Pick<SnfChainConfig, 'router02' | 'factory'>, to: Hex): boolean {
  const target = to.toLowerCase()
  return target === chain.router02.toLowerCase() || target === chain.factory.toLowerCase()
}

/**
 * Returns `step.tx` with the attribution suffix appended when — and only when — the
 * step is not an approval AND targets an SnF contract. Approvals go to third-party
 * token contracts, some of which assert an exact `msg.data` length, so they always
 * keep their calldata byte-for-byte.
 */
export function withAttribution(
  step: Pick<Step, 'kind' | 'tx'>,
  chain: Pick<SnfChainConfig, 'router02' | 'factory'>,
  suffix: Hex | undefined,
): UnsignedTx {
  if (suffix === undefined || step.kind === 'approval' || !isAttributedTarget(chain, step.tx.to)) {
    return step.tx
  }
  return { ...step.tx, data: concat([step.tx.data, suffix]) }
}
