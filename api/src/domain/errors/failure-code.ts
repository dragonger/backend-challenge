/**
 * Stable, machine-readable reasons why a transaction was REJECTED or FAILED.
 * Providers use them to decide whether to resend, fix the payload or give up.
 *
 * Business rejections (REJECTED):
 *  - INSUFFICIENT_BALANCE: BET larger than the balance. Do not resend as is.
 *  - REVERSAL_WOULD_OVERDRAW: a REFUND/ROLLBACK would make the balance negative.
 *  - REFERENCE_NOT_FOUND: referenced transaction never arrived (TTL exhausted).
 *  - REFERENCE_MISMATCH: reference belongs to another player/wallet/round/currency.
 *  - REFERENCE_NOT_PROCESSED: reference exists but did not change the balance.
 *  - REFERENCE_ALREADY_REVERSED: reference already reversed (once only).
 *  - INVALID_REFERENCE_KIND: reference kind not allowed for this operation.
 *  - AMOUNT_MISMATCH: reversal amount differs from the reference amount.
 *  - CURRENCY_MISMATCH: operation currency differs from the wallet currency.
 *  - WALLET_PLAYER_MISMATCH: wallet does not belong to the informed player.
 *  - WALLET_NOT_FOUND: wallet does not exist (reported as 404, never persisted).
 *  - MISSING_REFERENCE: REFUND/ROLLBACK without referenceExternalTransactionId.
 *
 * Permanent technical failure (FAILED):
 *  - INTERNAL_ERROR
 */
export enum FailureCode {
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  AmountMismatch = 'AMOUNT_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  WalletNotFound = 'WALLET_NOT_FOUND',
  MissingReference = 'MISSING_REFERENCE',
  InternalError = 'INTERNAL_ERROR',
}
