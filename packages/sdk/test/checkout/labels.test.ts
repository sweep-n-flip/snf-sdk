import { describe, expect, it } from 'vitest'

import { buildConfirmLabel } from '../../src/checkout/labels'
import type { Step } from '../../src/types/plan.types'
import type { Quote } from '../../src/types/quote.types'

// Only the fields the label reads; everything else about a Step is irrelevant here.
function step(
  kind: Step['kind'],
  approvalKind?: 'erc721-approval-for-all' | 'erc20-allowance' | 'lp-allowance',
): Step {
  return {
    kind,
    approvals: approvalKind ? [{ kind: approvalKind }] : [],
  } as unknown as Step
}

// A liquidity step additionally needs `quote.side` — the one field the label reads
// to tell a plain deposit from a pool-creating one.
function liquidityStep(kind: 'add-liquidity' | 'remove-liquidity', side: Quote['side']): Step {
  return {
    kind,
    approvals: [],
    quote: { side },
  } as unknown as Step
}

describe('buildConfirmLabel reads the step when one state covers several step kinds', () => {
  it('a collection approval says so; an ERC-20 allowance does not claim to approve a collection', () => {
    expect(buildConfirmLabel('ready-approve', step('approval', 'erc721-approval-for-all'))).toBe('Approve collection')
    expect(buildConfirmLabel('ready-approve', step('approval', 'erc20-allowance'))).toBe('Approve token spending')
  })

  it('an LP approval reads as its own kind of approve', () => {
    expect(buildConfirmLabel('ready-approve', step('approval', 'lp-allowance'))).toBe('Approve LP token')
  })

  it('an NFT sale and a fungible swap get different copy', () => {
    expect(buildConfirmLabel('ready-swap', step('swap-sell'))).toBe('Confirm sale')
    expect(buildConfirmLabel('ready-swap', step('swap-fungible'))).toBe('Confirm swap')
  })

  it('an add-liquidity step reads quote.side to tell a deposit from a pool creation', () => {
    expect(buildConfirmLabel('ready-swap', liquidityStep('add-liquidity', 'add-liquidity'))).toBe('Confirm deposit')
    expect(buildConfirmLabel('ready-swap', liquidityStep('add-liquidity', 'create-pool'))).toBe('Create pool')
  })

  it('a remove-liquidity step is always a withdrawal', () => {
    expect(buildConfirmLabel('ready-swap', liquidityStep('remove-liquidity', 'remove-liquidity'))).toBe(
      'Confirm withdrawal',
    )
  })

  it('keeps the state default when no step is known', () => {
    expect(buildConfirmLabel('ready-approve', undefined)).toBe('Approve collection')
    expect(buildConfirmLabel('ready-swap', undefined)).toBe('Confirm sale')
    expect(buildConfirmLabel('ready-buy', undefined)).toBe('Confirm purchase')
  })
})
