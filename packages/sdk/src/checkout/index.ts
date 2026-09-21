/**
 * The checkout surface (R15, INV-17). Re-exported (not just internally used) so a
 * later plan/barrel can do `export * from './checkout'` without reaching into each
 * file individually.
 */
export { checkoutReducer, initialCheckoutState, canDispatch, CHECKOUT_STATES, NEXT_READY_BY_KIND } from './reducer'
export type { CheckoutMachineState, CheckoutAction, CheckoutEffect } from './reducer'
export { buildConfirmLabel, isBusyState } from './labels'
export { createCheckout } from './createCheckout'
