// Maps a caught error (often a raw Breez/UniFFI string) to a stable, user-safe code.
// Screens translate the code; the raw cause is never shown on screen.
export type WalletErrorCode =
  | 'insufficientFunds'
  | 'selfPayment'
  | 'expiredInvoice'
  | 'quoteExpired'
  | 'timeout'
  | 'invalidInput'
  | 'offline'
  | 'crossChainTooSmall'
  | 'crossChainTooLarge'
  | 'routeBusy'
  | 'routeUnavailable'
  | 'feeIncreased'
  | 'deleted'
  | 'updateApp'
  | 'exitHeld'
  | 'exitHeldUnread'
  | 'receiveHeld'
  | 'receiveHeldUnread'
  | 'lnurlRefused'
  | 'balanceSettling'
  | 'unknown'

// What spark.ts throws before it signs a spend while the signing wallet holds an emergency exit that is
// alive, or a plan it could not read. Nothing reached the SDK, so nothing moved.
export class SpendHeldByExit extends Error {
  readonly hold: 'exit' | 'unread'

  constructor(hold: 'exit' | 'unread') {
    super(`spend held by an emergency exit: ${hold}`)
    this.name = 'SpendHeldByExit'
    this.hold = hold
  }
}

// What spark.ts throws before it makes or claims a receive while the receiving wallet holds an
// emergency exit that is alive, or a plan it could not read. Nothing reached the SDK.
export class ReceiveHeldByExit extends Error {
  readonly hold: 'exit' | 'unread'

  constructor(hold: 'exit' | 'unread') {
    super(`receive held by an emergency exit: ${hold}`)
    this.name = 'ReceiveHeldByExit'
    this.hold = hold
  }
}

// The key a screen says a code with. The two exit holds speak of payments and conversions, since this
// reaches Convert, the dollar switch and the purchases; Send draws its own lines for a hold and never
// says one through here.
export function walletErrorKey(code: WalletErrorCode): string {
  if (code === 'exitHeld') {
    return 'emergencyExit.spendHeld'
  }
  if (code === 'exitHeldUnread') {
    return 'emergencyExit.spendHeldUnread'
  }
  if (code === 'receiveHeld') {
    return 'emergencyExit.receiveHeld'
  }
  if (code === 'receiveHeldUnread') {
    return 'emergencyExit.receiveHeldUnread'
  }
  return `errors.${code}`
}

// The binding's cross-chain errors carry their reason in tag and inner, and the message is only the
// class name, so they are read by shape. Every other binding error also has a tag, which is why
// anything not named here falls through to the text rules.
function classifyCrossChain(cause: unknown): WalletErrorCode | undefined {
  if (typeof cause !== 'object' || cause === null) {
    return undefined
  }
  const { tag, inner } = cause as { tag?: unknown; inner?: Record<string, unknown> }
  if (tag === 'CrossChainAmountOutOfRange') {
    return inner?.tooSmall === true ? 'crossChainTooSmall' : 'crossChainTooLarge'
  }
  if (tag === 'CrossChainRouteUnavailable') {
    return inner?.temporary === true ? 'routeBusy' : 'routeUnavailable'
  }
  return undefined
}

// A claim refused because the deposit would credit under the dust limit after its fee. The reason is in
// the tag alone, and the SDK records it on the deposit before it throws, so the next read says it too.
export function isDepositTooSmall(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { tag?: unknown }).tag === 'DepositTooSmall'
}

// The gateway refuses a key whose data was deleted with `deleted` as the whole code, and the app's
// own stops (deletionMark.ts) throw the same code, so it is matched exactly rather than as a word
// that could sit inside an unrelated message.
function isDeleted(cause: unknown): boolean {
  if (typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'deleted') {
    return true
  }
  const message = cause instanceof Error ? cause.message : String(cause ?? '')
  return message.trim() === 'deleted'
}

// A binding error's message is only `SdkError.<Variant>`, so String(cause) never holds what the SDK
// said. Its words ride in inner[0] for the variants that carry a sentence.
export function sdkWords(cause: unknown): string {
  const inner = typeof cause === 'object' && cause !== null ? (cause as { inner?: unknown }).inner : undefined
  return Array.isArray(inner) && typeof inner[0] === 'string' ? inner[0].toLowerCase() : ''
}

// The SDK's refusal of a lapsed bolt11 at send, made before anything moves, a conversion included
// (payments/send/mod.rs, orchestrate_send). Only its exact sentence clears a send of doubt, since the
// code below also takes any text with the word in it.
export function isExpiredInvoiceRefusal(cause: unknown): boolean {
  return sdkWords(cause) === 'invoice has expired'
}

// Whether a binding error is the given SdkError variant. The tag is the variant's name.
function isVariant(cause: unknown, tag: string): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { tag?: unknown }).tag === tag
}

// The operators turn away a Lightning send whose invoice already has a payment registered with them,
// paid or still in flight, with gRPC AlreadyExists. It reaches the binding as a SparkError carrying
// tonic's display of the status, "status: AlreadyExists, message: ..." (tonic 0.12 status.rs, through
// SparkWalletError's default arm in core/src/error.rs). The SDK has no variant for it, so the words are
// read. The payment it names may be this wallet's own: when the probe for a committed transfer fails,
// the SDK returns the original error (spark transfer.rs, recover_committed_transfer), a leaf retry then
// sends the same invoice again (spark-wallet with_leafs_spent_retry), and the SDK keeps the send's
// record through any error and finishes it on a later sync (lightning_sender.rs, resume_pending_sends).
// So it never clears a send of doubt, and its words never advise paying a new invoice.
export function isUsedInvoiceRefusal(cause: unknown): boolean {
  return isVariant(cause, 'SparkError') && /\bstatus: alreadyexists\b/.test(sdkWords(cause))
}

export function classifyWalletError(cause: unknown): WalletErrorCode {
  if (cause instanceof SpendHeldByExit) {
    return cause.hold === 'exit' ? 'exitHeld' : 'exitHeldUnread'
  }
  if (cause instanceof ReceiveHeldByExit) {
    return cause.hold === 'exit' ? 'receiveHeld' : 'receiveHeldUnread'
  }
  if (isDeleted(cause)) {
    return 'deleted'
  }
  const crossChain = classifyCrossChain(cause)
  if (crossChain) {
    return crossChain
  }
  // An LNURL server that answered with its own refusal (LUD-06, status ERROR) is an LnurlError whose
  // words open with "endpoint error:" (common/src/lnurl/error.rs). Read ahead of the text rules, since
  // the rest of those words are the server's, which must not pick a reason the app then states.
  if (isVariant(cause, 'LnurlError') && sdkWords(cause).startsWith('endpoint error:')) {
    return 'lnurlRefused'
  }
  // The SDK gives up reserving leaves in a SparkError saying "Failed to select leaves after all retries"
  // (spark-wallet wallet.rs, select_leaves_with_retry) only when the balance covers the amount, so the
  // leaves are held by another operation or not loaded yet. It happens before any transfer is built.
  if (isVariant(cause, 'SparkError') && sdkWords(cause).includes('failed to select leaves')) {
    return 'balanceSettling'
  }
  const text = String(cause ?? '').toLowerCase()
  // Only the SDK's exact sentences are read from its words. A keyword rule further down stays on the
  // variant's name, because inner[0] can be a server's body or an internal detail, and a NetworkError
  // whose body mentions something expired is still a network error.
  const said = `${text} ${sdkWords(cause)}`
  // The operators refuse an old client with "<field> is required. Please upgrade to the latest SDK
  // version", in the words of its handlers. First among the text rules, since the variant around it
  // can name InvalidInput, and only an update ends this one.
  if (said.includes('upgrade to the latest sdk')) {
    return 'updateApp'
  }
  // The SDK gives up when a fee rose since the quote, in a Generic: "Fee increased since prepare" on a
  // send and "Fee increased between queries" on an LNURL pay.
  if (said.includes('fee increased')) {
    return 'feeIncreased'
  }
  // The wallet refuses to pay itself in a SparkError saying "Self payment not allowed". The other
  // spellings are older bindings' and plain strings'.
  if (
    said.includes('self payment') ||
    text.includes('selftransfer') ||
    text.includes('self transfer') ||
    text.includes('self-transfer')
  ) {
    return 'selfPayment'
  }
  // Both cross-chain providers refuse in these words, in an InvalidInput, before their own send starts,
  // so no invoice is involved and the send has not left. The whole phrase, because a coop exit's lapsed
  // fee quote is a SparkError saying "quote has expired" about an on-chain send.
  if (said.includes('cross-chain quote has expired')) {
    return 'quoteExpired'
  }
  // An InvalidInput too, which the rule for 'invalid' below would otherwise name as a bad address.
  if (text.includes('expired') || said.includes('invoice has expired')) {
    return 'expiredInvoice'
  }
  // A payment-specific timeout, matched before the generic 'timeout' -> offline rule below, which
  // would otherwise swallow it.
  if (text.includes('paymenttimeout') || text.includes('payment timeout')) {
    return 'timeout'
  }
  if (text.includes('insufficient') || text.includes('not enough')) {
    return 'insufficientFunds'
  }
  if (
    text.includes('invalid') ||
    text.includes('parse') ||
    text.includes('decode') ||
    text.includes('unsupported') ||
    text.includes('unrecognized')
  ) {
    return 'invalidInput'
  }
  if (
    text.includes('network') ||
    text.includes('timeout') ||
    text.includes('connection') ||
    text.includes('offline') ||
    text.includes('unreachable')
  ) {
    return 'offline'
  }
  return 'unknown'
}

// What a log line may say about an error. A release build keeps its logs, and an error's message, an
// SDK error's `inner` or a server's answer can carry an address, an amount or a name, so only the
// kind is said: its name and its code or tag, never its message, and for a thrown value that is not
// an object, only its type.
export function errorKind(err: unknown): string {
  if (typeof err !== 'object' || err === null) {
    return typeof err
  }
  const { name, code, tag } = err as { name?: unknown; code?: unknown; tag?: unknown }
  const parts = [name, code, tag].filter(
    (part): part is string | number => typeof part === 'string' || typeof part === 'number',
  )
  // Bounded, since a name or a code is a label and anything longer is text that can carry anything.
  return parts.length > 0 ? parts.map(part => String(part).slice(0, 40)).join(' ') : 'object'
}
