// UI model for the history. Decouples the screen from the engine's payment shape, so the screen
// never reads raw SDK fields. Populated by the Spark boundary (wallet/spark.ts).
// 'converted' is a swap between the wallet's own assets (the dollar wallet turning sats into the
// token and back, or the converter), not money arriving from anyone. The SDK reports it as a receive,
// which would read as money received for a move the wallet made itself.
export type HistoryDirection = 'received' | 'sent' | 'converted'
export type HistoryStatus = 'complete' | 'pending' | 'failed'

// Settlement rail of a payment, for the explorer link + the detail sheet. Spark holds BTC, settled
// over Lightning, on-chain Bitcoin, or a Spark transfer. Absent on payments that don't record it.
export type PaymentMethod = 'lightning' | 'bitcoin' | 'spark'

// A non-BTC asset a payment moved (a Spark token). `amount` is already formatted in the asset's
// own unit (e.g. "25", "100.5"), so the screen renders `${amount} ${ticker}`. `fee` is in that unit
// too, and absent when the SDK recorded 0, which it writes for every token payment without working
// one out (utils/token.rs).
export type HistoryAsset = { assetId: string; ticker: string; amount: string; fee?: string }

// What the service a Lightning payment paid left to show afterwards (LUD-09). Third-party text: drawn
// as plain text, never used as a translation key, and `url` opens only on a tap that passes
// `httpUrl`. An encrypted action counts once decrypted, with its own `description`.
export type HistorySuccessAction =
  | { kind: 'message'; text: string; description?: string }
  // `foreignHost`: the address is on another host than the service that was paid (LUD-09).
  | { kind: 'url'; url: string; description: string; foreignHost?: boolean }

// The leg past Spark of a USDC or USDT send. Every figure is already in `asset`'s unit. Read with
// `crossChainArrival`, since `deliveredAmount` says nothing until the delivery is final.
export type HistoryCrossChainSend = {
  chain: string
  asset: string
  estimatedOut: string
  deliveredAmount?: string
  // The provider's best figure: an estimate while pending, the real one once completed.
  feeAmount?: string
  // Only Orchestra reports the transaction on the destination chain.
  txHash?: string
}

// One side of a conversion. `ticker` null is Bitcoin, whose amounts are whole sats; a token's amounts
// are already in its own unit. What the SDK did not give is absent, never a zero: the fee on a side
// is that side's unit, and the SDK reports 0 both for no fee and for a fee it never learned.
// `quoted` says the amount is what the SDK quoted for a Convert, not what it reports as moved.
// `assetId` is the token's identifier, the only thing that can say which token a ticker really is.
export type HistoryConversionSide = {
  ticker: string | null
  assetId?: string
  amount?: string
  fee?: string
  quoted?: boolean
}

export type HistoryConversionStatus = 'complete' | 'pending' | 'failed' | 'refundPending' | 'refunded'

// `from` and `to` are absent when the SDK does not name that side. A conversion to the wallet's own
// address hides the leg that left and links it where no reader can reach it, so only the leg that
// arrived is known. A receive that dollar mode is about to convert has neither side yet.
export type HistoryConversion = {
  status: HistoryConversionStatus
  automatic: boolean
  from?: HistoryConversionSide
  to?: HistoryConversionSide
  // The fee the SDK quoted for a Convert, kept apart from a side's `fee`, which is one it reports as
  // charged. Present only when the SDK reports none (conversionNotes.ts).
  quotedFee?: { ticker: string | null; amount: string }
}

export type HistoryItem = {
  id: string
  direction: HistoryDirection
  status: HistoryStatus
  amountSat: number
  feesSat: number
  timestamp: number
  method?: PaymentMethod
  // null => Bitcoin, shown in sats; otherwise an asset shown in its own unit.
  asset: HistoryAsset | null
  // Whom a send went to. A receive has none: its Lightning node key is the wallet's own side.
  destination?: string
  // The lightning address a send paid, kept apart from `destination`, which falls back to a node key.
  lnAddress?: string
  // The BOLT11 invoice of a Lightning payment, or the Spark invoice a receive answered.
  invoice?: string
  txId?: string
  // The Spark transfer id, or a token's txHash. Neither is a Bitcoin txid, so it stays out of `txId`,
  // which is what an explorer link is built from.
  transferRef?: string
  // Lightning only. The payment hash is its on-ledger identifier, as txId is on-chain, and once
  // settled the preimage proves the payment.
  paymentHash?: string
  preimage?: string
  description?: string
  // The LUD-12 comment this wallet sent with a payment. A received one is `zap.comment` or hidden.
  comment?: string
  successAction?: HistorySuccessAction
  // Present only when this receive arrived as a nostr zap (NIP-57). `comment` is the zapper's message
  // (from the 9734), absent when the zap carried none. The screen shows a badge on presence alone.
  zap?: { comment?: string }
  // Present when a receive was paid in on another chain, carrying where from, how much was sent
  // there (in that asset), and the funding transaction on that chain.
  crossChain?: { chain: string; asset: string; amountIn?: string; txHash?: string }
  crossChainSend?: HistoryCrossChainSend
  // Who ran the conversion or the cross-chain leg, as a proper name that is never translated.
  provider?: string
  // Present when a conversion ran on this payment, whatever its direction: a real receive that dollar
  // mode converted and a send funded by one carry it too.
  conversion?: HistoryConversion
  // The payment is the leg the pool sent back. A real receive whose automatic conversion was refunded
  // is not one: `conversion` carries that status from a child leg, and its money stayed in the wallet.
  poolRefund?: true
  // Present on a cross-chain send: where the leg past Spark stands, which the send's own status does
  // not say. The Spark side can be final while this is still pending or was refunded.
  delivery?: HistoryConversionStatus
}
