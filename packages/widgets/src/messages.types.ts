import type { SnfErrorCode } from '@sweepnflip/sdk'

/**
 * Partner-facing message overrides — a partial map from an SDK error code
 * to replacement text. Only the codes a partner wants to translate or reword need to
 * be present; every other code falls back to `DEFAULT_WIDGET_MESSAGES`. The `code`
 * itself is never replaced or hidden by an override — see `resolveErrorMessage` in
 * `messages.ts`.
 */
export type SnfWidgetMessages = Partial<Record<SnfErrorCode, string>>
