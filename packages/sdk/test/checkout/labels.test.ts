import { describe, expect, it } from 'vitest'

import { buildConfirmLabel } from '../../src/checkout/labels'
import type { Step } from '../../src/types/plan.types'

// Only the fields the label reads; everything else about a Step is irrelevant here.
function step(kind: Step['kind'], approvalKind?: 'erc721-approval-for-all' | 'erc20-allowance'): Step {
  return {
    kind,
    approvals: approvalKind ? [{ kind: approvalKind }] : [],
  } as unknown as Step
}

describe('buildConfirmLabel reads the step when one state covers several step kinds', () => {
  it('a collection approval says so; an ERC-20 allowance does not claim to approve a collection', () => {
    expect(buildConfirmLabel('ready-approve', step('approval', 'erc721-approval-for-all'))).toBe('Approve collection')
    expect(buildConfirmLabel('ready-approve', step('approval', 'erc20-allowance'))).toBe('Approve token spending')
  })

  it('an NFT sale and a fungible swap get different copy', () => {
    expect(buildConfirmLabel('ready-swap', step('swap-sell'))).toBe('Confirm sale')
    expect(buildConfirmLabel('ready-swap', step('swap-fungible'))).toBe('Confirm swap')
  })

  it('keeps the state default when no step is known', () => {
    expect(buildConfirmLabel('ready-approve', undefined)).toBe('Approve collection')
    expect(buildConfirmLabel('ready-swap', undefined)).toBe('Confirm sale')
    expect(buildConfirmLabel('ready-buy', undefined)).toBe('Confirm purchase')
  })
})
