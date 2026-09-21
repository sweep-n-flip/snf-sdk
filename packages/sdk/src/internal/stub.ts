import { SnfError } from '../errors'

/**
 * The single `@gsd-stub` throw site every unimplemented domain function in this
 * package calls through. Plan 20's release gate counts `@gsd-stub` occurrences across
 * `packages/*\/src` and fails the phase if any survive — every stub module repeats the
 * literal token in its own header comment (`// @gsd-stub — implemented by plan NN. …`)
 * so a forgotten stub is visible to that grep, not just reachable through this
 * function.
 *
 * @gsd-stub
 */
export function notImplemented(fn: string, plan: string): never {
  throw new SnfError('UNKNOWN', `${fn} is not implemented yet (lands in Phase 54 plan ${plan})`)
}
