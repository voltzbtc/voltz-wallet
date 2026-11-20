import RNFS from 'react-native-fs'
import {
  forgetLnAddress,
  lastLnAddress,
  notTakenBack,
  noteNotTakenBack,
  rememberLnAddress,
} from './lnAddressMemory'
import { paymentInput } from './paymentInput'
import {
  deletedError,
  deletionHolds,
  findDeletionMark,
  markAddressRemoved,
  noteGatewayDeleted,
  unmarkAddressRemoved,
  type DeletionMark,
} from './deletionMark'
import { answerWithin } from './answerWithin'
import { gatewayRefusal } from './lnRefusal'
import { keyStep, nextStep, readKeyState, readNameState, type NameState } from './nameState'
import { domainFor } from './lnurlDomainPref'
import {
  AssetFilter,
  BitcoinNetwork,
  BuyBitcoinRequest,
  connect,
  ConversionOptions,
  CpfpFundingKind,
  CpfpInput,
  ExitLeafSelection,
  CpfpInput_Tags,
  ExitTransactionStatus_Tags,
  RecoveryMethod,
  RecoveryTxKind,
  RecoveryVerdict_Tags,
  SdkError,
  SdkError_Tags,
  singleKeyCpfpSigner,
  SkippedLeafReason_Tags,
  ConversionType,
  ConversionType_Tags,
  CrossChainRouteFilter,
  defaultConfig,
  DepositClaimError,
  ClaimDepositOutcome_Tags,
  AesSuccessActionDataResult_Tags,
  ConversionInfo_Tags,
  ConversionPurpose_Tags,
  ConversionProvider,
  ConversionStatus,
  DepositClaimError_Tags,
  FeePolicy,
  InstantClaimStatus_Tags,
  RefundState_Tags,
  SparkAsset,
  SparkAsset_Tags,
  initLogging,
  Fee,
  MaxOnchainFee,
  MoonpayDelivery,
  Network,
  OnchainConfirmationSpeed,
  PaymentRequest,
  TransferAuthorization,
  PaymentMethod as SdkPaymentMethod,
  PaymentStatus,
  PaymentType,
  ReceivePaymentMethod,
  Seed,
  SdkEvent_Tags,
  SendPaymentMethod_Tags,
  SendPaymentOptions,
  StableBalanceActiveLabel,
  WebhookEventType,
  WebhookEventType_Tags,
  type Bip21Details,
  type BitcoinAddressDetails,
  type ConversionEstimate,
  type LightningAddressDetails,
  type Bolt11InvoiceDetails,
  type BreezSdkInterface,
  type Config,
  type CpfpFundingStrategy,
  type SyncError,
  type ConversionSide,
  type CrossChainAcceptedAsset,
  type DepositInfo,
  type MaxFee,
  type PrepareRecoverFundsResponse,
  type RecoverFundsResponse,
  type CrossChainAddressDetails,
  type CrossChainRoutePair,
  type LightningAddressInfo,
  type LnurlPayRequestDetails,
  type LnurlWithdrawRequestDetails,
  type Payment,
  type PrepareLnurlPayResponse,
  type PrepareSendPaymentResponse,
  type SdkEvent,
  type SendPaymentMethod,
  type SparkInvoiceDetails,
  SuccessActionProcessed_Tags,
  type SuccessActionProcessed,
} from '@breeztech/breez-sdk-spark-react-native'
import { getBreezSparkApiKey } from '../config'
import { formatAssetAmount } from './assets'
import {
  pickReceiveLanding,
  receiveBounds,
  sortRoutes,
  type CrossChainSource,
  type ReceiveLanding,
} from './crossChain'
import { conversionNotesEra, keepConversionNote, withConversionNotes } from './conversionNotes'
import { formatBaseUnitsExact, toBaseUnitsExact } from './sparkConvert'
import { parseZap } from './history'
import type {
  HistoryAsset,
  HistoryConversion,
  HistoryConversionSide,
  HistoryConversionStatus,
  HistoryItem,
  HistoryStatus,
  HistorySuccessAction,
  PaymentMethod,
} from './payment'
import { PRIMARY_ID, loadPassphraseFor, loadSeedFor } from './seed'
import { ReceiveHeldByExit, SpendHeldByExit, sdkWords } from './errors'
import { exitHoldOnSigner } from './exitHold'
import { defaultAddressDescription, lnurlText, randomUsername } from './lnaddress'
import { ensureRegistered, getActiveWalletId } from './walletRegistry'
import { fingerprintFromMnemonicAsync } from './fingerprint'
import { STABLE_BALANCE_LABEL, USDB } from './tokens'
import { announceResumed } from './resumeNotice'
import {
  dropUnknownSend,
  notePendingSend,
  readPendingSends,
  rebuildPendingSends,
  settlePendingSend,
} from './pendingSends'
import { announceSendSettled, sendSettledHeard } from './sendNotice'
import type { NoticeRail, PaymentFacts } from './paymentNotice'

// Sole boundary between the app and the Breez Spark SDK, so no screen imports the binding itself.

// Keyed by wallet id, never by the seed, so no plaintext mnemonic sits in the JS heap for the session.
//
// Each connect makes a new record, so the identity one connection answered never vouches for
// another, even when the binding hands back an object it returned before. The same holds for
// `synced`: getInfo answers the account state stored at the last sync however old it is, and the
// lastSyncedAt it carries is kept across connects, so it says nothing of this connection. A connection
// counts as synced only once it has heard its own first SdkEvent.Synced, and again only after a Synced
// heard since the app last came back from the background (sparkNoteResumed), or since a pull that
// heard none or a read that reported a failed sync (markNotCurrent). lastSyncError is the opposite
// evidence and stands alone, though unset it proves nothing, since each connect clears it. It outranks
// a Synced at every stage: one that follows a reported failure proves nothing, however marked the
// connection already was.
type Connection = {
  sdk: BreezSdkInterface
  // The wallet this instance signs for, so what it hears is told only to that wallet.
  walletId: string
  // The domain the SDK itself was given, its default included, which connectedLnurlDomain leaves out.
  addressDomain: string | undefined
  identity: string | null
  synced: boolean
  // When the current wait for a sync began: the connect, or the latest return from the background.
  connectedAt: number
  // Every Synced heard, marked or not. syncWallet resolves whether or not the sync reached anyone, so
  // this count moving is the one evidence a pull has.
  heard: number
  // Set by the pull in flight, which ends at the next Synced.
  onHeard: (() => void) | null
  // Whether the SDK may spend leaves nobody asked it to: the optimizer swaps them after a payment
  // (guide/optimize.html), and an active stable balance converts excess sats on receive
  // (guide/stable_balance.html, "On receive"). Both are off on a connection opened while the exit holds,
  // and such a connection is replaced once the hold reads none (liveToKeep).
  spendsOnItsOwn: boolean
}
let live: Connection | null = null
let connectedWalletId: string | null = null

// How long a balance screen waits for a connection's first sync before it shows the stored figure,
// marked as not yet updated. A database weeks behind took about 10 s from connect to Synced on the
// iPhone 17 simulator, so an online open lands as a plain figure, and an offline one is not left on a
// skeleton for good.
export const SYNC_WAIT_MS = 12_000

// What a balance read can claim. `waiting` is a connection inside SYNC_WAIT_MS without a sync,
// `stale` one past it.
export type BalanceSync = 'synced' | 'waiting' | 'stale'

function syncOf(connection: Connection): BalanceSync {
  if (connection.synced) {
    return 'synced'
  }
  return Date.now() - connection.connectedAt >= SYNC_WAIT_MS ? 'stale' : 'waiting'
}

// Past the wait at once, so a screen marks its figure now rather than 12 s from now. The next Synced
// that follows no failure marks the connection again and brings the re-read, with nothing further here.
function markNotCurrent(connection: Connection): void {
  connection.synced = false
  connection.connectedAt = Date.now() - SYNC_WAIT_MS
}

const syncedListeners = new Set<() => void>()

// Fires when the live connection hears its first sync, or its first since a return from the
// background or a pull that heard none, after the flag is set, so a read made in the callback counts
// as synced.
export function onSparkSynced(cb: () => void): () => void {
  syncedListeners.add(cb)
  return () => {
    syncedListeners.delete(cb)
  }
}

// The SDK fires RecoverableFunds only when funds join the total, and nothing when they leave it, so
// this only brings a read forward. getInfo stays the source of the figure.
const recoverableListeners = new Set<() => void>()

export function onSparkRecoverableFunds(cb: () => void): () => void {
  recoverableListeners.add(cb)
  return () => {
    recoverableListeners.delete(cb)
  }
}

// The app came back from the background. The live connection kept its record through the
// suspension, and the figure its database holds can predate it until the SDK syncs again, so it
// counts as unsynced and waits SYNC_WAIT_MS afresh, as at connect; the next Synced marks it again.
// Only the live connection is touched: a replaced one is no screen's source.
export function sparkNoteResumed(): void {
  const connection = live
  if (!connection) {
    return
  }
  connection.synced = false
  connection.connectedAt = Date.now()
  announceResumed()
  sweepPendingSends(connection)
}

// What a screen with no figure of its own can claim, such as the payment list. Taken before the read
// it qualifies, as in sparkGetWalletInfo.
export function sparkSyncState(): BalanceSync {
  return live ? syncOf(live) : 'waiting'
}

// Milliseconds until the live connection's wait runs out, and 0 once it synced, once the wait is over,
// or with nothing connected.
export function sparkSyncWaitLeftMs(): number {
  if (!live || live.synced) {
    return 0
  }
  return Math.max(0, live.connectedAt + SYNC_WAIT_MS - Date.now())
}

// A read that fails says nothing of the sync, and counts as no proof of one.
async function syncReportsFailure(connection: Connection): Promise<boolean> {
  try {
    const info = await connection.sdk.getInfo({ ensureSynced: false })
    return noteSyncFailure(connection, info.lastSyncError)
  } catch {
    return true
  }
}

// The reason itself stays here: its message is for logs, and only `sync` reaches a screen.
function noteSyncFailure(connection: Connection, error: SyncError | undefined): boolean {
  if (error === undefined) {
    return false
  }
  markNotCurrent(connection)
  return true
}

// A listener's failure costs that one event's handling, never the process, and is logged rather than
// lost. A release build keeps its logs and a subscriber's message can carry an address, an amount or
// a name, so only the error's kind is logged: its name and its code or tag, never its message, and
// for a thrown value that is not an object, only its type.
function warnListener(err: unknown): void {
  console.warn(`sdk listener failed: ${errorKind(err)}`)
}

function errorKind(err: unknown): string {
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

// The binding hands a listener's rejection to Rust as an unexpected error, which panics in a library
// built to abort (uniffiTraitInterfaceCallAsync), so every listener the app registers is built here
// or in `detached`, and nothing it runs throws out of it. This one awaits its body, which only the
// connection's own listeners use, since the SDK awaits each listener in turn.
function shielded(onEvent: (event: SdkEvent) => Promise<void> | void): {
  onEvent: (event: SdkEvent) => Promise<void>
} {
  return {
    onEvent: async event => {
      try {
        await onEvent(event)
      } catch (err) {
        warnListener(err)
      }
    },
  }
}

// A subscriber is started and not awaited. SDK 0.28 awaits each listener in turn under its listener
// lock, so a promise a subscriber returned would hold the other listeners and the sync behind it. Its
// synchronous throw and its rejection are both caught, the rejection after this listener resolved.
function detached(onEvent: (event: SdkEvent) => unknown): { onEvent: (event: SdkEvent) => Promise<void> } {
  return {
    onEvent: async event => {
      try {
        Promise.resolve(onEvent(event)).catch(warnListener)
      } catch (err) {
        warnListener(err)
      }
    },
  }
}

// Registered on the record before it is published, which is the earliest the binding allows, since
// connect takes no listener. A Synced that still slipped past is followed by the next periodic one.
// The callback holds its own record, so an older connection's event never marks a newer one. Once
// marked, a further event only reads for a failure, until a return from the background, a pull that
// heard no sync or a failure clears the mark.
async function watchFirstSync(connection: Connection): Promise<void> {
  try {
    await connection.sdk.addEventListener(
      shielded(async event => {
        if (event.tag === SdkEvent_Tags.RecoverableFunds && live === connection) {
          recoverableListeners.forEach(cb => cb())
        }
        heardSendEnd(connection, event)
        if (event.tag !== SdkEvent_Tags.Synced) {
          return
        }
        connection.heard += 1
        connection.onHeard?.()
        // Synced is sent for any part of a sync that worked, and the error is set before it is sent,
        // so the wallet's own failure is read first. A resume or a failure noted meanwhile moves the
        // wait, and this event then speaks for the wait before it.
        const wait = connection.connectedAt
        const failed = await syncReportsFailure(connection)
        if (failed || connection.synced || connection.connectedAt !== wait) {
          return
        }
        connection.synced = true
        if (live === connection) {
          syncedListeners.forEach(cb => cb())
          sweepPendingSends(connection)
        }
      }),
    )
  } catch {
    // Without the listener the connection never counts as synced, so screens fall back to the stored
    // figure marked as not updated once the wait runs out.
  }
}

const connectListeners = new Set<() => void>()

export function onSparkConnected(cb: () => void): () => void {
  connectListeners.add(cb)
  if (connectedWalletId !== null) {
    cb()
  }
  return () => {
    connectListeners.delete(cb)
  }
}

// The wallet every signature comes from. The registry's active id can name another one after a
// switch that did not reconnect, so a request that must be signed by one wallet checks this.
export function sparkConnectedWalletId(): string | null {
  return connectedWalletId
}

// The JS catch only sees one opaque string, so in dev the SDK's own log is forwarded. initLogging
// throws if called twice, hence the latch.
let sdkLoggingStarted = false
function initSdkLogging(): void {
  if (sdkLoggingStarted || !__DEV__) {
    return
  }
  sdkLoggingStarted = true
  try {
    initLogging(undefined, { log: entry => console.log(`[spark:${entry.level}] ${entry.line}`) }, 'info')
  } catch {
    // A missing diagnostic log must never block connecting.
  }
}

// The per wallet domain the live connection was built with, published together with it, since the SDK
// reads the domain once at connect.
let lnurlDomainInUse: string | undefined

// The domain the connected SDK is actually serving, which is what an address has to match. Undefined
// with nothing connected.
export function connectedLnurlDomain(): string | undefined {
  return lnurlDomainInUse
}

// The ceiling of a claim the person approved on the card: the fee they saw, in sats, and nothing on
// top. proportionalPpm would add a share of the deposit to `onchain`, so it stays unset.
function flatClaimCeiling(amountSat: bigint): MaxFee {
  return { onchain: new MaxOnchainFee.Fixed({ amount: amountSat }), proportionalPpm: undefined }
}

function buildConfig(lnurlDomain: string | undefined, exitHeld: boolean): Config {
  const config = { ...defaultConfig(Network.Mainnet), apiKey: getBreezSparkApiKey() }
  // The optimizer swaps leaves after any payment (guide/optimize.html, swap_minimizing_leaves in
  // leaf_optimizer.rs), and a swap of a leaf an exit is spending wastes the fees paid for its steps. While
  // the wallet's exit is alive, or its plan cannot be read, it is off; the multiplicity stays as it was.
  if (exitHeld) {
    config.leafOptimizationConfig = { ...config.leafOptimizationConfig, autoEnabled: false }
  }
  // The SDK claims a deposit without asking whenever the claim's fee fits the fastest recommended
  // network fee rate plus 1 sat/vbyte, plus 0.1% of the amount, as Breez recommends
  // (guide/onchain_claims.html). An instant or expedited claim, which the provider offers per deposit,
  // runs under the same ceiling, so a deposit is credited before maturity whenever that fee fits. The
  // ceiling follows the mempool, so during a fee spike a small deposit can be claimed at a fee that is a
  // large share of it. Above it the SDK emits UnclaimedDeposits, and the card asks the person to accept
  // the quoted fee or send the deposit back.
  config.maxDepositClaimFee = {
    onchain: new MaxOnchainFee.NetworkRecommended({ leewaySatPerVbyte: 1n }),
    proportionalPpm: 1000,
  }
  // Assigning undefined blanks out the SDK's default domain (breez.tips), so only assign when set.
  if (lnurlDomain) {
    config.lnurlDomain = lnurlDomain
  }
  // An active stable balance sells the sats of any receive above its threshold on its own
  // (guide/stable_balance.html, "On receive"), spending Available leaves an exit may be taking. While the
  // exit holds the wallet the SDK gets no stable balance at all, so it builds neither the middleware nor
  // its conversion worker (build_stable_balance in sdk_builder.rs). The chosen label stays in the SDK's
  // own storage and comes back with the config on the first connect after the exit.
  if (exitHeld) {
    config.stableBalanceConfig = undefined
  } else {
    // defaultActiveLabel stays unset because a default would auto-convert the wallet's sats without
    // consent.
    // Only USDB, the one token behind STABLE_BALANCE_LABEL; the SDK refuses a second token under the
    // same label ("tokens contains duplicate label").
    config.stableBalanceConfig = {
      tokens: [{ label: STABLE_BALANCE_LABEL, tokenIdentifier: USDB.identifier }],
      defaultActiveLabel: undefined,
      thresholdSats: undefined,
      // The SDK default of 10 bps rejects real conversions on the thin USDB pool. Matches CONVERT_MAX_SLIPPAGE_BPS.
      maxSlippageBps: 100,
    }
  }
  // Cross-chain sends stay disabled unless this config is passed. Undefined fields keep the SDK defaults.
  config.crossChainConfig = { defaultSlippageBps: undefined, defaultTargetOverpayBps: undefined }
  return config
}

// Every wallet shares one storage directory, and the SDK requires each running instance to have its
// own (guide/initializing.html). These rules keep the live connection on the wallet the newest request
// wants, and keep one seed from running twice:
//
// - Connect requests are served one at a time, in the order they were asked for. Before a connect
//   opens an instance, the live one is disconnected and the SDK has answered that disconnect.
// - A request is cut loose when a newer one wants another wallet, or a disconnect. Whatever a cut
//   request is waiting on, it rejects with SparkConnectSuperseded at once and the next request is
//   served. A cut request never publishes: a native connect already under way still lands, and its
//   instance disconnects itself. An instance whose landing check cannot read the registry does too.
// - A request for a wallet whose instance is still landing waits for it to land and disconnect itself
//   before opening another. The wait is bounded by LANDING_WAIT_MS and then fails as a connection
//   error the person can retry, never by opening the second instance.
// - disconnectSpark never waits for a connect: it cuts every request loose and disconnects the live
//   instance.
//
// A connect of another wallet does not wait for a cut instance still landing, so a native connect that
// never answers cannot stall the next wallet. Two wallets' instances can then run at once, on the same
// directory, until the late one lands and disconnects itself.
//
// A request names a wallet, or ACTIVE for whichever wallet the registry points at when its turn comes,
// which is what Home, the asset screen and every switch ask for.
const ACTIVE = Symbol('active wallet')
type Want = string | typeof ACTIVE

// How long a request waits for its wallet's earlier instance to land before it gives up. A native
// connect answers in seconds, so the wait only runs out on one that hangs.
export const LANDING_WAIT_MS = 30_000

type Turn = {
  seq: number
  own: Want
  // For ACTIVE, the registry's wallet when the request was made, and again once its turn comes.
  walletId: string
  cut: boolean
  // Rejects with SparkConnectSuperseded when the turn is cut loose.
  cutSignal: Promise<never>
  cutLoose: () => void
}

let connectTurn: Promise<void> = Promise.resolve()
let requestSeq = 0
let newest: { seq: number; want: Want | null } = { seq: 0, want: null }
// Turns queued or served and not cut loose, so the fast path knows nothing can still replace `live`.
const pendingTurns = new Set<Turn>()
// Native connects that have not landed, by wallet. Each settles once its instance is published or has
// disconnected itself.
const opening = new Map<string, Promise<void>>()
// The disconnect of the last live instance, settled whatever the SDK answered.
let closing: Promise<void> = Promise.resolve()

// What a connect throws when a later request wanted another wallet, or a disconnect, before it could
// be published. Nothing was connected for the caller, and the newer request settles the connection.
export class SparkConnectSuperseded extends Error {
  constructor() {
    super('spark connect superseded')
    this.name = 'SparkConnectSuperseded'
  }
}

// What a connect throws when its wallet's earlier instance is still landing after LANDING_WAIT_MS.
// Nothing was opened. The message carries "connection timeout" so screens classify it as offline and
// offer to try again.
export class SparkConnectBusy extends Error {
  constructor() {
    super('spark connection timeout: an earlier connect of this wallet has not landed')
    this.name = 'SparkConnectBusy'
  }
}

// Cuts loose every turn for another wallet, or every turn when walletId is null (a disconnect).
function noteRequest(want: Want | null, walletId: string | null): number {
  requestSeq += 1
  newest = { seq: requestSeq, want }
  pendingTurns.forEach(turn => {
    if (turn.walletId !== walletId) {
      turn.cutLoose()
    }
  })
  return requestSeq
}

// A `yielding` request is one nobody asked for (reconnectWallet, sparkStopSpendsOnItsOwn). It cuts no
// turn and does not become the newest request, so every request already pending keeps what it asked for
// and runs first; any later request for another wallet still cuts it.
function inConnectTurn<T>(
  want: Want,
  walletId: string,
  work: (turn: Turn) => Promise<T>,
  yielding = false,
): Promise<T> {
  if (erasing > 0) {
    return Promise.reject(new SparkConnectSuperseded())
  }
  const seq = yielding ? ++requestSeq : noteRequest(want, walletId)
  let cut!: (reason: Error) => void
  const cutSignal = new Promise<never>((_resolve, reject) => {
    cut = reject
  })
  cutSignal.catch(() => undefined)
  const turn: Turn = {
    seq,
    own: want,
    walletId,
    cut: false,
    cutSignal,
    cutLoose: () => {
      if (!turn.cut) {
        turn.cut = true
        pendingTurns.delete(turn)
        cut(new SparkConnectSuperseded())
      }
    },
  }
  pendingTurns.add(turn)
  const previous = connectTurn
  const run = Promise.race([previous, cutSignal]).then(() => {
    stopIfCut(turn)
    return work(turn)
  })
  const over = run.then(
    () => undefined,
    () => undefined,
  )
  over.then(() => pendingTurns.delete(turn))
  // Every wait of a cut turn ends at once, so its run settles and hands the turn on even while the
  // binding still holds its native connect.
  connectTurn = previous.then(() => over)
  return run
}

// Called right before every write a turn makes, since a cut can come between an answer and the
// continuation that reads it.
function stopIfCut(turn: Turn): void {
  if (turn.cut) {
    throw new SparkConnectSuperseded()
  }
}

// Awaits work for a turn, ending at once when the turn is cut loose. Work left behind only reads, except
// a native connect, which disconnects its own instance when it lands.
async function untilCut<T>(turn: Turn, work: Promise<T>): Promise<T> {
  const value = await Promise.race([work, turn.cutSignal])
  stopIfCut(turn)
  return value
}

async function activeWalletId(): Promise<string> {
  return (await getActiveWalletId()) ?? PRIMARY_ID
}

// Whether the turn may go on: not cut loose, and its wallet is the one the newest request wants, which
// for ACTIVE is what the registry says now.
async function stillWanted(turn: Turn): Promise<boolean> {
  // Spares the registry read for a turn already cut. At the landing check in openInstance it is
  // redundant, since the cut check there after the read sees this case too.
  if (turn.cut) {
    return false
  }
  const want = newest.seq > turn.seq ? newest.want : turn.own
  if (want === ACTIVE) {
    return (await activeWalletId()) === turn.walletId
  }
  return want === turn.walletId
}

function disconnectInstance(sdk: BreezSdkInterface): Promise<void> {
  return Promise.resolve().then(() => sdk.disconnect())
}

// Readers stop seeing the live connection at once, so nothing reads or signs on an instance being
// closed. Resolves once the SDK has answered the disconnect, and with nothing live, once the last
// disconnect has.
function dropLive(): Promise<void> {
  const connection = live
  if (!connection) {
    return closing
  }
  live = null
  connectedWalletId = null
  lnurlDomainInUse = undefined
  const disconnecting = disconnectInstance(connection.sdk)
  closing = disconnecting.then(
    () => undefined,
    () => undefined,
  )
  return disconnecting
}

// One seed never runs twice. The wallet's instance still landing belongs to a cut turn, since a turn
// that is not cut holds the turn until its connect lands, so it disconnects itself.
async function waitForLanding(turn: Turn): Promise<void> {
  if (!opening.has(turn.walletId)) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SparkConnectBusy()), LANDING_WAIT_MS)
  })
  bound.catch(() => undefined)
  try {
    for (let landing = opening.get(turn.walletId); landing; landing = opening.get(turn.walletId)) {
      await untilCut(turn, Promise.race([landing, bound]))
    }
  } finally {
    clearTimeout(timer)
  }
}

// The native connect and its landing, which run to the end even once the turn is cut loose, since
// only this code holds the instance the binding hands back.
async function openInstance(
  turn: Turn,
  seed: Seed,
  lnurlDomain: string | undefined,
  storageDir: string,
  exitHeld: boolean,
): Promise<BreezSdkInterface> {
  const walletId = turn.walletId
  let landed!: () => void
  const done = new Promise<void>(resolve => {
    landed = resolve
  })
  opening.set(walletId, done)
  try {
    const config = buildConfig(lnurlDomain, exitHeld)
    const sdk = await connect({ config, seed, storageDir })
    const connection: Connection = {
      sdk,
      walletId,
      addressDomain: config.lnurlDomain,
      identity: null,
      synced: false,
      connectedAt: Date.now(),
      heard: 0,
      onHeard: null,
      spendsOnItsOwn: !exitHeld,
    }
    await watchFirstSync(connection)
    // A registry that cannot be read leaves no instance running unpublished, and the request fails
    // with the read's error: no newer request is behind it to bring the screen's next load, so a
    // superseded rejection would leave the screen waiting until it is focused again.
    let wanted: boolean
    try {
      wanted = await stillWanted(turn)
    } catch (error) {
      await disconnectInstance(sdk).catch(() => undefined)
      throw error
    }
    // Checked again after the read, since a cut landing while stillWanted awaits the registry is seen
    // only here. The check that opens stillWanted is redundant at this call and only spares the read.
    if (!wanted || turn.cut) {
      await disconnectInstance(sdk).catch(() => undefined)
      throw new SparkConnectSuperseded()
    }
    // The record, its wallet id and its domain are set together here and cleared together in dropLive,
    // so no reader sees one without the others, nor a domain while nothing is connected.
    live = connection
    connectedWalletId = walletId
    lnurlDomainInUse = lnurlDomain
    connectListeners.forEach(cb => cb())
    sweepPendingSends(connection)
    return sdk
  } finally {
    if (opening.get(walletId) === done) {
      opening.delete(walletId)
    }
    landed()
  }
}

async function connectInTurn(
  turn: Turn,
  seed: () => Promise<string | null>,
): Promise<BreezSdkInterface> {
  const walletId = turn.walletId
  if (!(await untilCut(turn, stillWanted(turn)))) {
    throw new SparkConnectSuperseded()
  }
  await waitForLanding(turn)
  stopIfCut(turn)
  // Asked on every connect, the fast path's included, since a connection built under the other answer
  // is replaced (liveToKeep).
  const exitHeld = (await untilCut(turn, exitHoldOnSigner(walletId))) !== 'none'
  stopIfCut(turn)
  const keptEarly = liveToKeep(walletId, exitHeld)
  if (keptEarly) {
    return keptEarly
  }
  const mnemonic = await untilCut(turn, seed())
  if (!mnemonic) {
    throw new Error('no wallet stored')
  }
  initSdkLogging()
  const lnurlDomain = await untilCut(turn, domainFor(walletId))
  const storageDir = SPARK_STORAGE_DIR
  await untilCut(turn, RNFS.mkdir(storageDir).catch(() => undefined))
  // The optional BIP39 passphrase selects a different derived wallet, not just a different unlock.
  const passphrase = await untilCut(turn, loadPassphraseFor(walletId))
  // Asked again after the reads and before the live connection is dropped, so a request the person
  // has moved on from never takes down the wallet they are on.
  if (!(await untilCut(turn, stillWanted(turn)))) {
    throw new SparkConnectSuperseded()
  }
  stopIfCut(turn)
  // Asked again in the step that drops, since a send may have started during the reads above.
  const kept = liveToKeep(walletId, exitHeld)
  if (kept) {
    return kept
  }
  await untilCut(turn, dropLive())
  stopIfCut(turn)
  return untilCut(
    turn,
    openInstance(turn, Seed.Mnemonic.new({ mnemonic, passphrase }), lnurlDomain, storageDir, exitHeld),
  )
}

// The live connection when it is this wallet's and may stay under the hold just read. One that spends
// leaves on its own never stays while the exit holds the wallet or its plan is unread. One opened while
// it held is replaced once the hold reads none, so the stable balance and the optimizer the settings ask
// for come back, except while a send, a prepare or an address change runs on it, since a dropped
// instance takes that call down with it; the first request after that replaces it.
function liveToKeep(walletId: string, exitHeld: boolean): BreezSdkInterface | null {
  if (!live || connectedWalletId !== walletId) {
    return null
  }
  if (exitHeld) {
    return live.spendsOnItsOwn ? null : live.sdk
  }
  return live.spendsOnItsOwn || busy() ? live.sdk : null
}

// The SDK's own folder, shared by every wallet it opened on this device.
const SPARK_STORAGE_DIR = `${RNFS.DocumentDirectoryPath}/spark`

// Payment history, contacts and the lightning address sit here in the clear under a name taken from
// each key, so erasing every wallet has to take the folder too. It runs inside whileSparkErasing, where
// no connection is open or can open, and the seeds are gone by then, so what is left here opens nothing.
export async function sparkEraseLocalData(): Promise<void> {
  if (await RNFS.exists(SPARK_STORAGE_DIR)) {
    await RNFS.unlink(SPARK_STORAGE_DIR)
  }
}

export function connectSpark(
  mnemonic: string,
  walletId: string = PRIMARY_ID,
): Promise<BreezSdkInterface> {
  return inConnectTurn(walletId, walletId, turn => connectInTurn(turn, async () => mnemonic))
}

// Stale entries stay harmless because the fast path also gates on connectedWalletId, which disconnect nulls.
const registeredWallets = new Set<string>()

// Erases of every wallet under way (whileSparkErasing). The next first wallet takes the erased primary
// id, so a connect landing on the erased seed would be kept by the fast path and never replaced. While
// one runs no connect starts, on any path, since each enters through inConnectTurn.
let erasing = 0
// connectActiveSpark calls not settled, so an erase starts only once each has ended, its registry
// write included.
const activeConnects = new Set<Promise<void>>()

// Runs `work`, the erase of every wallet, with every connect refused from its first step to its last.
// Turns already queued are cut loose, and a call already past its turn is waited for, so none
// reconnects or registers the wallet whose seed is going.
export async function whileSparkErasing<T>(work: () => Promise<T>): Promise<T> {
  erasing += 1
  try {
    noteRequest(null, null)
    await Promise.all(activeConnects)
    registeredWallets.clear()
    return await work()
  } finally {
    erasing -= 1
  }
}

export function connectActiveSpark(): Promise<void> {
  if (erasing > 0) {
    return Promise.reject(new SparkConnectSuperseded())
  }
  const run = connectActive()
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  activeConnects.add(settled)
  settled.then(() => activeConnects.delete(settled))
  return run
}

async function connectActive(): Promise<void> {
  const current = await activeWalletId()
  // Called on every focus and payment event, so the connected case skips the Keychain read and PBKDF2.
  // Only with no turn held, since a queued request can still replace the live connection, and only for
  // a connection that may stay under the hold read now: one built under the other answer goes through
  // connectInTurn, which replaces it (liveToKeep).
  const kept = (): boolean =>
    pendingTurns.size === 0 && connectedWalletId === current && registeredWallets.has(current)
  if (kept()) {
    const exitHeld = (await exitHoldOnSigner(current)) !== 'none'
    if (kept() && liveToKeep(current, exitHeld)) {
      return
    }
  }
  let mnemonic: string | null = null
  const activeId = await inConnectTurn(ACTIVE, current, async turn => {
    turn.walletId = await untilCut(turn, activeWalletId())
    await connectInTurn(turn, async () => {
      mnemonic = await loadSeedFor(turn.walletId)
      return mnemonic
    })
    return turn.walletId
  })
  // Onboarding stores the seed without registering, so the first wallet enters the registry here. The
  // fingerprint must derive from mnemonic+passphrase, else a passphrase wallet lands on the wrong id.
  try {
    const words = mnemonic ?? (await loadSeedFor(activeId))
    if (!words) {
      return
    }
    const passphrase = await loadPassphraseFor(activeId)
    await ensureRegistered(activeId, await fingerprintFromMnemonicAsync(words, passphrase))
    registeredWallets.add(activeId)
  } catch {
    // The connection already succeeded, so a failed registry update is not fatal.
  }
}

// Whether the live connection is this wallet's and spends no leaf on its own, replacing one that does
// first. The binding has no call that stops a running instance's optimizer or stable balance (both are
// read at connect, guide/config.html), so the connection is replaced by one connectInTurn opens with
// both off while the wallet's exit is alive or unread. An exit transmits only after this answers true.
// It yields, as reconnectWallet does: a switch to another wallet asked first runs and is never cut, and
// this turn then finds `connection` gone, replaces nothing and answers false, so the pass sends nothing.
export async function sparkStopSpendsOnItsOwn(walletId: string): Promise<boolean> {
  const connection = live
  if (connection && connectedWalletId === walletId && connection.spendsOnItsOwn) {
    await inConnectTurn(
      walletId,
      walletId,
      async turn => {
        if (live === connection) {
          await connectInTurn(turn, () => loadSeedFor(walletId))
        }
      },
      true,
    ).catch(() => undefined)
  }
  return live !== null && connectedWalletId === walletId && !live.spendsOnItsOwn
}

export async function disconnectSpark(): Promise<void> {
  noteRequest(null, null)
  await dropLive()
}

// Sends and prepares in flight. A dropped instance takes the call it runs down with it, and a send that
// already left then reads as failed, so a reconnect nobody asked for (the refresh after a refund, the
// domain move after a deletion) is skipped while one runs and left for the next sweep or focus, never
// queued to fire mid-send. Every path that prepares or sends money enters through `sending`, and so
// does the stable balance switch, which converts the balance either way.
let sendsInFlight = 0
// Address changes asked for and not settled, counted from the moment they queue for the address turn,
// since each holds the connection it was asked on (inAddressTurn). Such a reconnect skips for them too.
let addressWorks = 0

async function sending<T>(work: () => Promise<T>): Promise<T> {
  sendsInFlight += 1
  try {
    return await work()
  } finally {
    sendsInFlight -= 1
  }
}

// Read in the same step as the drop it guards, so nothing can start in between.
function busy(): boolean {
  return sendsInFlight > 0 || addressWorks > 0
}

// What a reconnect nobody asked for rejects with when a send, a prepare or an address change is in
// flight. Nothing was dropped, and the reconnect is left for whoever asks next.
export class SparkReconnectBusy extends Error {
  constructor() {
    super('spark reconnect skipped: a send or an address change is in flight')
    this.name = 'SparkReconnectBusy'
  }
}

// disconnectSpark for a reconnect nobody asked for, refused while a send, a prepare or an address change
// is in flight.
export function disconnectSparkWhenIdle(): Promise<void> {
  if (busy()) {
    return Promise.reject(new SparkReconnectBusy())
  }
  return disconnectSpark()
}

function requireConnection(): Connection {
  if (!live) {
    throw new Error('spark not connected')
  }
  return live
}

function requireSdk(): BreezSdkInterface {
  return requireConnection().sdk
}

// A spend can take the sat leaves an emergency exit under way is moving on-chain, and a plan does not
// record which leaves it named, so nothing is signed while the signing wallet holds a live plan or one
// that could not be read. Every call that signs a spend out of the wallet asks here first, inside
// `sending`; receiving, claiming a deposit and the exit's own calls do not. The SDK handed back is the
// connection that was asked about, since one replaced during the read belongs to a wallet nobody asked.
async function signerFreeOfExit(): Promise<BreezSdkInterface> {
  const connection = requireConnection()
  const hold = await exitHoldOnSigner(connectedWalletId)
  if (hold !== 'none') {
    throw new SpendHeldByExit(hold)
  }
  if (live !== connection) {
    throw new Error('spark not connected')
  }
  return connection.sdk
}

// A receive into a wallet whose exit is alive, or whose plan could not be read, waits until the exit
// ends: Receive and every other screen that makes or claims one meet this here, before the SDK is
// called, as spends meet signerFreeOfExit. The wallet asked is the connected one, the one the SDK
// receives into, and a connection replaced during the read receives nothing.
async function receiverFreeOfExit(): Promise<BreezSdkInterface> {
  const connection = requireConnection()
  const hold = await exitHoldOnSigner(connectedWalletId)
  if (hold !== 'none') {
    throw new ReceiveHeldByExit(hold)
  }
  if (live !== connection) {
    throw new Error('spark not connected')
  }
  return connection.sdk
}

// A lightning address registered, claimed or handed to a screen for a wallet whose exit is alive, or
// whose plan could not be read, is a new way to receive into it, so it waits as every other receive
// does. Asked of the wallet the name would serve, before the SDK is called.
async function addressFreeOfExit(walletId: string | null | undefined): Promise<void> {
  const hold = await exitHoldOnSigner(walletId ?? null)
  if (hold !== 'none') {
    throw new ReceiveHeldByExit(hold)
  }
}

// balanceSats is a bigint in the binding, narrowed here because screens deal in number.
export async function sparkGetBalanceSat(): Promise<number> {
  const info = await requireSdk().getInfo({ ensureSynced: false })
  return Number(info.balanceSats)
}

// Resolves when the connection hears its sync, or when its SYNC_WAIT_MS runs out first.
async function firstSyncOrWait(connection: Connection): Promise<void> {
  if (connection.synced) {
    return
  }
  let finish!: () => void
  const over = new Promise<void>(resolve => {
    finish = resolve
  })
  const timer = setTimeout(finish, Math.max(0, connection.connectedAt + SYNC_WAIT_MS - Date.now()))
  const off = onSparkSynced(finish)
  await over
  clearTimeout(timer)
  off()
}

// The bitcoin balance a payment may be decided on, read once the live connection has heard its first
// sync, or its first since the app came back from the background, waiting for it as a balance screen
// does. Null when the wait runs out first or the connection is replaced meanwhile: the figure stored
// at the last sync can be days old, or predate a suspension, so it neither refuses nor allows a
// payment.
export async function sparkSyncedBalanceSat(): Promise<number | null> {
  const connection = requireConnection()
  await firstSyncOrWait(connection)
  if (live !== connection || !connection.synced) {
    return null
  }
  const info = await connection.sdk.getInfo({ ensureSynced: false })
  return noteSyncFailure(connection, info.lastSyncError) ? null : Number(info.balanceSats)
}

export type SparkToken = {
  identifier: string
  ticker: string
  name: string
  decimals: number
  balanceBaseUnits: number
}

// `sync` belongs to the connection that answered. A screen shows the figure as current only when it
// is 'synced'. A sync the SDK reports as failed makes it 'stale' at once, whatever the wait says.
//
// recoverableSat left balanceSat for the chain, so it is its own figure and joins no balance or total.
// On a restored wallet it can count funds already recovered until the SDK's chain check ends, which
// nothing announces (recover_funds.md).
export type SparkWalletInfo = {
  balanceSat: number
  recoverableSat: number
  tokens: SparkToken[]
  sync: BalanceSync
}

// ensureSynced stays false because true blocks until the first sync, which never comes offline.
export async function sparkGetWalletInfo(): Promise<SparkWalletInfo> {
  const connection = requireConnection()
  // Taken before the read, so a sync landing while it runs leaves this answer unsynced and the sync's
  // own notice brings the re-read.
  const sync = syncOf(connection)
  const info = await connection.sdk.getInfo({ ensureSynced: false })
  const tokens: SparkToken[] = []
  info.tokenBalances.forEach((tb, identifier) => {
    tokens.push({
      identifier,
      ticker: tb.tokenMetadata.ticker,
      name: tb.tokenMetadata.name,
      decimals: tb.tokenMetadata.decimals,
      balanceBaseUnits: Number(tb.balance),
    })
  })
  return {
    balanceSat: Number(info.balanceSats),
    recoverableSat: Number(info.recoverableFundsSats),
    tokens,
    sync: noteSyncFailure(connection, info.lastSyncError) ? 'stale' : sync,
  }
}

export async function sparkGetTokenBalances(): Promise<SparkToken[]> {
  return (await sparkGetWalletInfo()).tokens
}

// Results are not guaranteed in input order, so the match is by identifier rather than by position.
export async function sparkResolveToken(
  identifier: string,
): Promise<{ identifier: string; name: string; ticker: string; decimals: number } | null> {
  const res = await requireSdk().getTokensMetadata({ tokenIdentifiers: [identifier] })
  const meta = res.tokensMetadata.find(entry => entry.identifier === identifier)
  if (!meta) {
    return null
  }
  return { identifier: meta.identifier, name: meta.name, ticker: meta.ticker, decimals: meta.decimals }
}

// The answer is kept on the connection that gave it, which may no longer be the live one when it
// arrives, and then vouches for nothing else.
async function identityOf(connection: Connection): Promise<string> {
  const pubkey = (await connection.sdk.getInfo({ ensureSynced: false })).identityPubkey
  connection.identity = pubkey
  return pubkey
}

export async function sparkGetIdentityPubkey(): Promise<string> {
  return identityOf(requireConnection())
}

// The connected wallet's id and identity, read from one connection, so a record kept by wallet id
// always belongs to the identity that signed for it, even across a switch landing between two reads.
export async function sparkConnectedIdentity(): Promise<{ walletId: string; pubkey: string }> {
  const connection = requireConnection()
  const pubkey = connection.identity ?? (await identityOf(connection))
  return { walletId: connection.walletId, pubkey }
}

// Signs with the wallet's identity key, DER hex, which is the encoding both the Breez LNURL server
// and the Voltz gateway parse. `compact: false` therefore is not a default worth changing.
//
// `as` is the pubkey the signed request sends. The connection live at the call is taken once, its
// identity is read from it when not yet known, and the signature is refused, as without a
// connection, when that identity is another, so no request carries one wallet's signature over
// another's pubkey. The signature is made on that same connection even if another replaces it
// meanwhile, and a connection only ever holds its own wallet's key.
export async function sparkSignMessage(message: string, as: string): Promise<string> {
  const signer = requireConnection()
  const identity = signer.identity ?? (await identityOf(signer))
  if (identity !== as) {
    throw new Error('spark connected as another identity')
  }
  return (await signer.sdk.signMessage({ message, compact: false })).signature
}

// The Spark address of the wallet whose identity is `as`, read on one connection and refused, as
// without a connection, when that connection is another wallet's, so sats owed back to one wallet
// are never sent to the address of the wallet switched to.
export async function sparkOwnSparkAddress(as: string): Promise<string> {
  const connection = requireConnection()
  const identity = connection.identity ?? (await identityOf(connection))
  if (identity !== as) {
    throw new Error('spark connected as another identity')
  }
  const sdk = await receiverFreeOfExit()
  if (sdk !== connection.sdk) {
    throw new Error('spark connected as another identity')
  }
  const res = await sdk.receivePayment({ paymentMethod: new ReceivePaymentMethod.SparkAddress() })
  return res.paymentRequest
}

export async function sparkGetFiatRates(coins: string[]): Promise<Record<string, number>> {
  const res = await requireSdk().listFiatRates()
  const result: Record<string, number> = {}
  for (const coin of coins) {
    const found = res.rates.find(rate => rate.coin === coin)
    if (found) {
      result[coin] = found.value
    }
  }
  return result
}

// `uniqSymbol` is the disambiguated glyph such as A$ or CN¥, and wins over the ambiguous `symbol`.
// The feed's placement of the symbol (`template`, `position`) is not carried, since the app language
// places every currency (fiat.ts).
export type FiatCurrencyOption = {
  id: string
  name: string
  symbol: string
  fractionSize: number
}

export async function sparkListFiatCurrencies(): Promise<FiatCurrencyOption[]> {
  const res = await requireSdk().listFiatCurrencies()
  return res.currencies.map(c => {
    const sym = c.info.uniqSymbol?.grapheme ? c.info.uniqSymbol : c.info.symbol ?? c.info.uniqSymbol
    return {
      id: c.id,
      name: c.info.name,
      symbol: sym?.grapheme ?? c.id,
      fractionSize: c.info.fractionSize,
    }
  })
}

export async function sparkAddEventListener(onEvent: (event: SdkEvent) => void): Promise<() => void> {
  const id = await requireSdk().addEventListener(detached(onEvent))
  return () => {
    live?.sdk.removeEventListener(id).catch(() => undefined)
  }
}

export type SparkReceiveMethod = 'lightning' | 'onchain' | 'spark'
// feeSat is in sats, except on a token invoice, which the SDK denominates in the token's base units.
export type SparkReceiveQuote = { destination: string; feeSat: number }

// `amount` is in sats, except when tokenIdentifier is set, where it is that token's base units, as a
// bigint when typed, since a double cannot carry an 18-place figure. Held while the wallet's exit is
// alive or unread, since what it hands out is a way to pay this wallet.
export async function sparkReceive(
  method: SparkReceiveMethod,
  amount?: number | bigint,
  description?: string,
  tokenIdentifier?: string,
): Promise<SparkReceiveQuote> {
  return receiveOn(await receiverFreeOfExit(), method, amount, description, tokenIdentifier)
}

// The wallet's own code read for the app's use alone, never shown: a conversion's own Spark address,
// whose spend is held at its confirm, and the exit's check that its destination is not this wallet.
function ownReceive(method: SparkReceiveMethod): Promise<SparkReceiveQuote> {
  return receiveOn(requireSdk(), method)
}

async function receiveOn(
  sdk: BreezSdkInterface,
  method: SparkReceiveMethod,
  amount?: number | bigint,
  description?: string,
  tokenIdentifier?: string,
): Promise<SparkReceiveQuote> {
  let paymentMethod: ReceivePaymentMethod
  if (method === 'lightning') {
    paymentMethod = new ReceivePaymentMethod.Bolt11Invoice({
      description: description ?? '',
      amountSats: amount === undefined ? undefined : BigInt(amount),
      expirySecs: undefined,
      paymentHash: undefined,
      receiverIdentityPublicKey: undefined,
      preimage: undefined,
    })
  } else if (method === 'onchain') {
    paymentMethod = new ReceivePaymentMethod.BitcoinAddress({ newAddress: undefined })
  } else if (amount !== undefined && BigInt(amount) > 0n) {
    paymentMethod = new ReceivePaymentMethod.SparkInvoice({
      amount: BigInt(amount),
      tokenIdentifier,
      expiryTime: undefined,
      description: description && description.length > 0 ? description : undefined,
      senderPublicKey: undefined,
    })
  } else {
    paymentMethod = new ReceivePaymentMethod.SparkAddress()
  }
  const res = await sdk.receivePayment({ paymentMethod })
  return { destination: res.paymentRequest, feeSat: Number(res.fee) }
}

export type SparkDestinationKind =
  | 'bolt11'
  | 'bitcoinAddress'
  // BIP-352. An on-chain send like the one above, for a refund and an exit it is not an address at all.
  | 'silentPaymentAddress'
  | 'sparkAddress'
  | 'lightningAddress'
  | 'lnurlPay'
  | 'lnurlWithdraw'
  | 'crossChainAddress'
  | 'other'
  // A destination that names a server the wallet could not read, which says nothing about it.
  | 'unread'
  // Read whole and for another network, which is a fact about the text whatever the connection is.
  | 'wrongNetwork'

function kindOfTag(tag: string): SparkDestinationKind {
  switch (tag) {
    case 'Bolt11Invoice':
      return 'bolt11'
    case 'BitcoinAddress':
      return 'bitcoinAddress'
    case 'SilentPaymentAddress':
      return 'silentPaymentAddress'
    case 'SparkAddress':
    case 'SparkInvoice':
      return 'sparkAddress'
    case 'LightningAddress':
      return 'lightningAddress'
    case 'LnurlPay':
      return 'lnurlPay'
    case 'LnurlWithdraw':
      return 'lnurlWithdraw'
    case 'CrossChainAddress':
      return 'crossChainAddress'
    default:
      return 'other'
  }
}

const silentPaymentDetails = (parsed: { inner?: unknown }): BitcoinAddressDetails =>
  (parsed.inner as readonly [BitcoinAddressDetails])[0]

// `parse` takes a tsp1 or sprt1 address on any wallet and names its network, and the send refuses it
// only at prepare, so this refuses it first, as the exit does for a Bitcoin address.
function kindOfInput(parsed: { tag: string; inner?: unknown }): SparkDestinationKind {
  if (parsed.tag === 'SilentPaymentAddress' && silentPaymentDetails(parsed).network !== BitcoinNetwork.Bitcoin) {
    return 'wrongNetwork'
  }
  return kindOfTag(parsed.tag)
}

// An LNURL whose server stayed silent comes back as an InvalidInput, with only its words to tell it
// from text that is no destination. An answer cut mid-body, or a failure the SDK files under Other,
// says as little (ServiceConnectivityError). A server that answered badly has spoken, so it stays
// `other`. A lightning address gives no such words, since the SDK drops the reason
// (probeLightningAddress).
const LNURL_UNREAD = /error calling lnurl endpoint: (?:timeout|request|connect|body|other) error/

function kindOfRefusal(cause: unknown): SparkDestinationKind {
  return LNURL_UNREAD.test(sdkWords(cause)) ? 'unread' : 'other'
}

// Any `bitcoin:` text parses as Bip21, an address alone included, and so does a BIP-353 name, so the
// kind of one is the kind of the leg Send would pay, and a code the scanner hands on is the one Send pays.
export async function sparkClassify(destination: string): Promise<SparkDestinationKind> {
  try {
    const parsed = await requireSdk().parse(paymentInput(destination))
    return parsed.tag === 'Bip21' ? bip21Leg(parsed).kind : kindOfInput(parsed)
  } catch (cause) {
    return kindOfRefusal(cause)
  }
}

// --- Cross-chain sends (sats -> USDC/USDT on Solana / Tron / an EVM chain) ---
// Voltz never touches the funds and takes no cut, as the SDK talks to the provider and the device signs.

// One address usually resolves to several routes, since an EVM address exists on every EVM chain.
export type SparkCrossChainRoute = {
  /** Opaque id, scoped to its address so a stale one fails to resolve instead of paying the wrong payee. */
  id: string
  chain: string
  asset: string
  decimals: number
  provider: 'orchestra' | 'boltz'
  /** The Spark assets the route takes, USDB by its identifier and never by a name. */
  accepts: { btc: boolean; usdb: boolean }
  /** The token's contract on its chain. Absent for a coin native to it. */
  contractAddress?: string
  // Bounds for a send funded with sats, as the route publishes them. A route may enforce tighter ones
  // at prepare, so these only spare a quote that is bound to be refused.
  minSat?: number
  maxSat?: number
  minUsdCents?: number
  maxUsdCents?: number
  // The same for a send funded with USDB, in dollars. Its own bounds, never the sats ones. USDB's
  // six places fit a double, which the sheet's dollar figures are.
  usdbMin?: number
  usdbMax?: number
}

// Routes kept behind their id so preparing needs neither a re-parse nor raw SDK types on screen.
const crossChainRoutes = new Map<string, { address: string; pair: CrossChainRoutePair }>()

// The SDK tells routes apart by chain, asset and contract, and two contracts of one asset are two
// tokens, so the id holds what the SDK's key holds.
function crossChainRouteId(address: string, pair: CrossChainRoutePair): string {
  return `${address}|${pair.chain}|${pair.asset}|${pair.contractAddress ?? ''}|${pair.provider}`
}

const toNumber = (v: bigint | undefined) => (v === undefined ? undefined : Number(v))
const usdbDollars = (v: bigint | undefined) =>
  v === undefined ? undefined : Number(formatBaseUnitsExact(v, USDB.decimals))

function acceptsUsdb(a: CrossChainAcceptedAsset): boolean {
  return a.asset.tag === SparkAsset_Tags.Token && a.asset.inner.tokenIdentifier === USDB.identifier
}

// CrossChainProvider is a numeric enum where Orchestra is 0 and Boltz the only non-zero value.
const providerOf = (pair: CrossChainRoutePair): SparkCrossChainRoute['provider'] =>
  pair.provider === 0 ? 'orchestra' : 'boltz'

function toRoute(address: string, pair: CrossChainRoutePair): SparkCrossChainRoute {
  // Bounds are per Spark asset paid in.
  const bitcoin = pair.acceptedAssets.find(a => a.asset.tag === SparkAsset_Tags.Bitcoin)
  const usdb = pair.acceptedAssets.find(acceptsUsdb)
  const limits = bitcoin?.limits
  const usdbBounds = receiveBounds(usdb?.limits, USDB.decimals)
  return {
    id: crossChainRouteId(address, pair),
    chain: pair.chain,
    asset: pair.asset,
    decimals: pair.decimals,
    provider: providerOf(pair),
    accepts: { btc: bitcoin !== undefined, usdb: usdb !== undefined },
    contractAddress: pair.contractAddress || undefined,
    minSat: toNumber(limits?.minAmount),
    maxSat: toNumber(limits?.maxAmount),
    minUsdCents: toNumber(limits?.minUsdCents),
    maxUsdCents: toNumber(limits?.maxUsdCents),
    usdbMin: usdbDollars(usdbBounds.min),
    usdbMax: usdbDollars(usdbBounds.max),
  }
}

async function loadCrossChainRoutes(
  details: CrossChainAddressDetails,
): Promise<SparkCrossChainRoute[]> {
  const pairs = await requireSdk().getCrossChainRoutes(
    // Unset lists the routes paid from the Spark balance, which is the balance the send spends.
    new CrossChainRouteFilter.Send({ addressDetails: details, deliveryMethod: undefined }),
  )
  const routes: SparkCrossChainRoute[] = []
  for (const pair of pairs) {
    crossChainRoutes.set(crossChainRouteId(details.address, pair), { address: details.address, pair })
    routes.push(toRoute(details.address, pair))
  }
  return routes
}

export type SparkDestinationInfo = {
  kind: SparkDestinationKind
  /** Payable string picked out of a unified BIP21 URI. The screen prepares this, not the raw input. */
  resolved?: string
  /** The token a Spark invoice bills in. Absent means it bills in Bitcoin. */
  tokenIdentifier?: string
  /** Amount a Spark invoice embeds. Already part of `resolved`, so never pass it to prepare again. */
  amount?: number
  /** BIP21 amount for a leg whose own string embeds none. External to `resolved`, so it must be passed
   *  to prepare and the amount sheet skipped. */
  requestedAmount?: number
  /** A unified URI's Lightning invoice ran out and `resolved` is the on-chain leg beside it, which is
   *  slower and may belong to the request that expired, so the screen pays it only when asked to. */
  expiredInvoice?: true
  routes?: SparkCrossChainRoute[]
}

// A unified BIP-21 carries several rails. They are tried cheapest and most instant first, Spark before a
// still-valid bolt11, bolt11 before the on-chain address.
function bip21Leg(parsed: { inner?: unknown }): SparkDestinationInfo {
  const details = (parsed.inner as readonly [Bip21Details])[0]
  const amount = details.amountSat === undefined ? undefined : Number(details.amountSat)

  // The Spark leg is read from the raw URI, so it wins whatever the SDK lists beside it. A BIP-21 key
  // matches in any case, as the SDK's parser matches it (input/parser/mod.rs, parse_bip_21), and a
  // Spark address is bech32m, which is one case, so an all-caps QR's address is taken in lower case.
  const sparkParam = details.uri.match(/[?&]spark=([^&]+)/i)
  if (sparkParam) {
    return { kind: 'sparkAddress', resolved: sparkParam[1].toLowerCase(), requestedAmount: amount }
  }

  // An expired bolt11 never shadows a still-payable on-chain leg in a stale link, and the leg carries
  // the expiry, since its address may belong to the same request and settle it only late.
  const bolt11 = details.paymentMethods.find(m => m.tag === 'Bolt11Invoice')
  let expired = false
  if (bolt11) {
    const inv = (bolt11.inner as readonly [Bolt11InvoiceDetails])[0]
    const expiresAtMs = (Number(inv.timestamp) + Number(inv.expiry)) * 1000
    if (Date.now() < expiresAtMs) {
      return { kind: 'bolt11', resolved: inv.invoice.bolt11 }
    }
    expired = true
  }
  const ranOut = expired ? { expiredInvoice: true as const } : {}

  // The plain address beside it is the fallback for a wallet that cannot pay this one.
  const silent = details.paymentMethods.find(
    m => m.tag === 'SilentPaymentAddress' && kindOfInput(m) === 'silentPaymentAddress',
  )
  if (silent) {
    return {
      kind: 'silentPaymentAddress',
      resolved: silentPaymentDetails(silent).address,
      requestedAmount: amount,
      ...ranOut,
    }
  }

  const onchain = details.paymentMethods.find(m => m.tag === 'BitcoinAddress')
  if (onchain) {
    return {
      kind: 'bitcoinAddress',
      resolved: (onchain.inner as readonly [BitcoinAddressDetails])[0].address,
      requestedAmount: amount,
      ...ranOut,
    }
  }
  const foreign = details.paymentMethods.some(m => m.tag === 'SilentPaymentAddress')
  return { kind: foreign ? 'wrongNetwork' : 'other' }
}

export async function sparkInspectDestination(destination: string): Promise<SparkDestinationInfo> {
  let parsed
  try {
    parsed = await requireSdk().parse(paymentInput(destination))
  } catch (cause) {
    return { kind: kindOfRefusal(cause) }
  }
  const kind = kindOfInput(parsed)
  if (parsed.tag === 'SilentPaymentAddress' && kind === 'silentPaymentAddress') {
    // The SDK's lowercase form, since a QR code carries these in capitals and the review groups them.
    return { kind, resolved: silentPaymentDetails(parsed).address }
  }
  if (parsed.tag === 'Bip21') {
    return bip21Leg(parsed)
  }
  if (parsed.tag === 'SparkInvoice') {
    // The SDK rejects a send whose tokenIdentifier disagrees with the invoice, so the asset comes from here.
    const details = (parsed.inner as readonly [SparkInvoiceDetails])[0]
    return {
      kind,
      tokenIdentifier: details.tokenIdentifier ?? undefined,
      amount: details.amount === undefined ? undefined : Number(details.amount),
    }
  }
  if (parsed.tag === 'CrossChainAddress') {
    const details = (parsed.inner as [CrossChainAddressDetails])[0]
    // A parseable address with no route is still cross-chain, so a failed lookup must not change the kind.
    const routes = await loadCrossChainRoutes(details).catch(() => [] as SparkCrossChainRoute[])
    return { kind, routes }
  }
  return { kind }
}

// Prepared sends kept behind an opaque handle, so only display fields cross to the screens.
const preparedSends = new Map<string, PrepareSendPaymentResponse>()
let sendHandleSeq = 0

// An on-chain withdrawal pays two legs from the SDK quote, the L1 miner fee (l1BroadcastFeeSat) and
// the Spark operator's cooperative exit fee (userFeeSat). Voltz adds nothing to either.
export type SparkOnchainFeeTier = { minerSat: number; sparkSat: number; totalSat: number }
export type SparkOnchainFees = {
  fast: SparkOnchainFeeTier
  medium: SparkOnchainFeeTier
  slow: SparkOnchainFeeTier
  /** The SDK estimated rather than quoted: the wallet holds no bitcoin and a token conversion will
   *  fund the send. The provider quotes nothing against zero leaves. The send refreshes the quote
   *  itself and never pays more than the tier shown, stepping down in speed if the rate rose. */
  estimate: boolean
}
export type OnchainSpeed = 'fast' | 'medium' | 'slow'

export type SparkSendQuote = {
  handle: string
  /** Amount leaving, in sats or in the token's base units when tokenIdentifier is set. */
  amount: number
  /** `amount` as the SDK gave it when tokenIdentifier is set, since a double drops a token's digits
   *  past about 15 and a figure drawn from it can differ from what is signed. */
  amountBase?: bigint
  /** Sender-paid fee in the same unit as `amount`. Undefined on-chain, where onchainFees is tiered. */
  fee: number | undefined
  onchainFees?: SparkOnchainFees
  description?: string
  /** Set when the send moves a Spark token. Absent means a Bitcoin send. */
  tokenIdentifier?: string
  /** `amount` is everything that leaves, fees inside it, so nothing is added on top. */
  feesIncluded?: boolean
  /** What reaches the recipient of a send with fees included, in the unit of `amount`. Undefined
   *  on-chain, where it follows the speed: see sendReceives in sendAll.ts. */
  receives?: number
  /** The fee if this invoice is paid over Spark instead of Lightning. `fee` stays the Lightning one,
   *  since the route is chosen at confirm: see routedQuote in sendAll.ts. */
  sparkRouteFeeSat?: number
  /** Present when the SDK funds a Bitcoin send by converting a token first, which stable balance does
   *  on its own. `amount` stays the sats leaving, so a balance check must read conversion.amountIn. */
  conversion?: SparkSendConversion
}

/** The token leg of a Bitcoin send funded by a token (stable balance). */
export type SparkSendConversion = {
  tokenIdentifier: string
  /** Token base units leaving the wallet. */
  amountIn: number
  /** Sats the conversion produces, or at least produces when `expectedOut` is set. */
  amountOut: number
  /** What the pool is expected to give when `amountOut` is the floor of an exact input. */
  expectedOut?: number
  /** Conversion fee, in the token's base units, since the SDK denominates it on the input side. */
  fee: number
}

// Both prepare responses carry the same estimate, so the mapping is shared rather than duplicated:
// paying a lightning address out of a dollar balance is the same conversion as any other send.
function sendConversionOf(
  prepared: { conversionEstimate?: ConversionEstimate },
  exactInput = false,
): SparkSendConversion | undefined {
  const est = prepared.conversionEstimate
  if (!est) {
    return undefined
  }
  const conversionType = est.options.conversionType
  // Only a token -> BTC leg is spendable from the token, FromBitcoin being the opposite direction.
  if (conversionType.tag !== ConversionType_Tags.ToBitcoin) {
    return undefined
  }
  return {
    tokenIdentifier: conversionType.inner.fromTokenIdentifier,
    amountIn: Number(est.amountIn),
    amountOut: Number(est.amountOut),
    ...(exactInput ? { expectedOut: expectedOfFloor(est.amountOut) } : {}),
    fee: Number(est.fee),
  }
}

// On-chain has no flat fee, its feeQuote being tiered, so it returns undefined and the review picks.
// An invoice is the Lightning fee alone: the SDK pays one route, so the two fees never add up.
function sendFeeSat(method: SendPaymentMethod): number | undefined {
  if ('lightningFeeSats' in method.inner) {
    return Number(method.inner.lightningFeeSats)
  }
  if ('fee' in method.inner) {
    return Number(method.inner.fee)
  }
  return undefined
}

// Present only on an invoice that names a Spark address, which is what makes the route possible.
function sparkRouteFeeOf(method: SendPaymentMethod): number | undefined {
  const fee = 'sparkTransferFeeSats' in method.inner ? method.inner.sparkTransferFeeSats : undefined
  return fee === undefined ? undefined : Number(fee)
}

function onchainFeesOf(method: SendPaymentMethod): SparkOnchainFees | undefined {
  if (!('feeQuote' in method.inner)) {
    return undefined
  }
  const q = method.inner.feeQuote
  const tier = (s: { l1BroadcastFeeSat: bigint; userFeeSat: bigint }): SparkOnchainFeeTier => ({
    minerSat: Number(s.l1BroadcastFeeSat),
    sparkSat: Number(s.userFeeSat),
    totalSat: Number(s.l1BroadcastFeeSat + s.userFeeSat),
  })
  return { fast: tier(q.speedFast), medium: tier(q.speedMedium), slow: tier(q.speedSlow), estimate: q.isEstimate }
}

// Only the Spark methods carry the field, every other rail settling in BTC.
function sendTokenIdentifier(method: SendPaymentMethod): string | undefined {
  return 'tokenIdentifier' in method.inner ? (method.inner.tokenIdentifier ?? undefined) : undefined
}

// A bare bitcoin or spark address has no invoiceDetails, hence no payee memo.
function sendDescription(method: SendPaymentMethod): string | undefined {
  if ('invoiceDetails' in method.inner) {
    return method.inner.invoiceDetails?.description ?? undefined
  }
  return undefined
}

// The recipe for a dollar wallet's whole balance: the full token balance in, fees included, sold to
// bitcoin. With the mode on the SDK adds the sats held and sends what the sale leaves.
function dollarSale(): ConversionOptions {
  return ConversionOptions.create({
    conversionType: new ConversionType.ToBitcoin({ fromTokenIdentifier: USDB.identifier }),
    maxSlippageBps: CONVERT_MAX_SLIPPAGE_BPS,
  })
}

function feesIncludedQuote(
  amount: number,
  fee: number | undefined,
): Pick<SparkSendQuote, 'feesIncluded' | 'receives'> {
  return { feesIncluded: true, ...(fee === undefined ? {} : { receives: amount - fee }) }
}

// Step 1 of a send, which moves nothing. With tokenIdentifier set, amount and fee are that token's
// base units, and only Spark destinations can carry a token. `dollarBalance` asks for a dollar
// wallet's whole balance: `amount` then goes in as USDB base units, and the quote comes back in sats.
// A typed token amount comes as a bigint, since a double cannot carry an 18-place figure.
export async function sparkPrepareSend(
  destination: string,
  amount?: number | bigint,
  tokenIdentifier?: string,
  spendAll = false,
  dollarBalance = false,
): Promise<SparkSendQuote> {
  const prepared = await sending(() =>
    requireSdk().prepareSendPayment({
      paymentRequest: new PaymentRequest.Input({ input: paymentInput(destination) }),
      amount: amount === undefined ? undefined : BigInt(amount),
      tokenIdentifier: dollarBalance ? USDB.identifier : tokenIdentifier,
      conversionOptions: dollarBalance ? dollarSale() : undefined,
      feePolicy: spendAll || dollarBalance ? FeePolicy.FeesIncluded : undefined,
    }),
  )
  const handle = `spark_send_${++sendHandleSeq}`
  preparedSends.set(handle, prepared)
  const fee = sendFeeSat(prepared.paymentMethod)
  // What the SDK answered is sats on a dollar sale, whatever token went in.
  const sentToken = dollarBalance
    ? undefined
    : sendTokenIdentifier(prepared.paymentMethod) ?? tokenIdentifier
  return {
    handle,
    amount: Number(prepared.amount),
    ...(sentToken === undefined ? {} : { amountBase: prepared.amount }),
    fee,
    ...(spendAll || dollarBalance ? feesIncludedQuote(Number(prepared.amount), fee) : {}),
    sparkRouteFeeSat: sparkRouteFeeOf(prepared.paymentMethod),
    onchainFees: onchainFeesOf(prepared.paymentMethod),
    description: sendDescription(prepared.paymentMethod),
    tokenIdentifier: sentToken,
    conversion: sendConversionOf(prepared, dollarBalance),
  }
}

// Two units meet here. What leaves is in the source's unit, what arrives in the destination asset's.
export type SparkCrossChainQuote = {
  handle: string
  routeId: string
  /** What the prepare spends, which names the unit of amountIn. */
  source: CrossChainSource
  /** What leaves, fees inside it: USDB base units with source usdb, otherwise sats. */
  amountIn: number
  feeSat: number
  /** What the recipient gets, in the destination asset's base units. */
  estimatedOut: number
  /** Provider spread + bridge/gas + slippage, in the destination asset's base units. */
  feeAmount: number
  chain: string
  asset: string
  decimals: number
  provider: SparkCrossChainRoute['provider']
  contractAddress?: string
  /** When the quote lapses, RFC3339 from Orchestra and unix seconds from Boltz: see quoteExpiryMs. */
  expiresAt: string
  /** Present when the SDK funds a sats source by converting a token first. amountIn stays in sats. */
  conversion?: SparkSendConversion
}

// Step 2 of a cross-chain send. Confirm goes through sparkConfirmSend like any other prepared send.
// `amount` is in the source's unit. On a route that takes only sats the SDK reads a token's amount in
// the route's own decimals, 12 orders of magnitude off on an 18-decimal route, so a token goes in only
// where the route lists it.
export async function sparkPrepareCrossChainSend(
  routeId: string,
  amount: number,
  source: CrossChainSource,
): Promise<SparkCrossChainQuote> {
  const entry = crossChainRoutes.get(routeId)
  if (!entry) {
    throw new Error('cross-chain route not found')
  }
  if (source === 'usdb' && !entry.pair.acceptedAssets.some(acceptsUsdb)) {
    throw new Error('cross-chain route does not take USDB')
  }
  const prepared = await sending(() =>
    requireSdk().prepareSendPayment({
      paymentRequest: new PaymentRequest.CrossChain({
        address: entry.address,
        route: entry.pair,
        maxSlippageBps: undefined,
        targetOverpayBps: undefined,
      }),
      amount: BigInt(amount),
      tokenIdentifier: source === 'usdb' ? USDB.identifier : undefined,
      conversionOptions: undefined,
      feePolicy: undefined,
    }),
  )
  const handle = `spark_xchain_${++sendHandleSeq}`
  preparedSends.set(handle, prepared)
  const method = prepared.paymentMethod
  const inner = 'estimatedOut' in method.inner ? method.inner : undefined
  return {
    handle,
    routeId,
    source,
    amountIn: inner ? Number(inner.amountIn) : Number(prepared.amount),
    feeSat: inner ? Number(inner.sourceTransferFeeSats) : 0,
    estimatedOut: inner ? Number(inner.estimatedOut) : 0,
    feeAmount: inner ? Number(inner.feeAmount) : 0,
    chain: entry.pair.chain,
    asset: entry.pair.asset,
    decimals: entry.pair.decimals,
    provider: providerOf(entry.pair),
    contractAddress: entry.pair.contractAddress || undefined,
    expiresAt: inner ? inner.expiresAt : '',
    conversion: sendConversionOf(prepared),
  }
}

// A quote compared and not chosen, so what it holds goes without a send.
export function sparkDiscardSendQuote(handle: string): void {
  preparedSends.delete(handle)
}

// --- Cross-chain receives (USDT/USDC paid in on another chain, delivered to this wallet) ---
// The provider (Orchestra) holds the payer's deposit, converts it and pays this wallet's Spark
// address. Voltz is in no leg and adds no fee.

export type SparkReceiveRoute = {
  /** Opaque. Carries the contract, since one chain can list the same asset under two. */
  id: string
  chain: string
  asset: string
  decimals: number
  landing: ReceiveLanding
  /** In the paid asset's base units, since its 18 places can be past a double's reach. */
  min?: bigint
  max?: bigint
}

const receiveRoutes = new Map<string, { pair: CrossChainRoutePair; landing: SparkAsset }>()

// What lands follows the dollar wallet, which is why the list is asked for with it.
export async function sparkListReceiveRoutes(dollarMode: boolean): Promise<SparkReceiveRoute[]> {
  const pairs = await requireSdk().getCrossChainRoutes(
    // Unset lists the routes that land on the Spark balance, which is the balance the list offers.
    new CrossChainRouteFilter.Receive({ contractAddress: undefined, deliveryMethod: undefined }),
  )
  receiveRoutes.clear()
  const routes: SparkReceiveRoute[] = []
  for (const pair of pairs) {
    const btc = pair.acceptedAssets.find(a => a.asset.tag === SparkAsset_Tags.Bitcoin)
    const usdb = pair.acceptedAssets.find(acceptsUsdb)
    const landing = pickReceiveLanding({ btc: btc !== undefined, usdb: usdb !== undefined }, dollarMode)
    if (landing === null) {
      continue
    }
    const id = `receive|${pair.chain}|${pair.asset}|${pair.contractAddress ?? ''}|${pair.provider}`
    receiveRoutes.set(id, {
      pair,
      landing:
        landing === 'usdb'
          ? new SparkAsset.Token({ tokenIdentifier: USDB.identifier })
          : new SparkAsset.Bitcoin(),
    })
    const bounds = receiveBounds((landing === 'usdb' ? usdb : btc)?.limits, pair.decimals)
    routes.push({ id, chain: pair.chain, asset: pair.asset, decimals: pair.decimals, landing, ...bounds })
  }
  return sortRoutes(routes)
}

export type SparkStableReceive = {
  /** The QR payload, an EIP-681 URI on EVM chains and the bare address elsewhere. */
  qr: string
  /** What copying carries, since an exchange withdrawal form takes an address, not a URI. */
  address: string
  /** Exactly what the payer sends, in the paid asset. It covers the provider's fees. */
  sendAmount: string
  chain: string
  asset: string
  landing: ReceiveLanding
  /** What lands after fees, in sats for bitcoin and in dollars for USDB. */
  receiveAmount: number
  /** After this the price is gone; a payment sent later is repriced when it arrives. */
  expiresAtMs: number
}

// `amount` is the display amount the wallet receives (the SDK's default FeesExcluded), in the paid
// asset. Each call mints a single-use deposit address, so a quote is never reused.
export async function sparkReceiveStable(routeId: string, amount: string): Promise<SparkStableReceive> {
  const entry = receiveRoutes.get(routeId)
  if (!entry) {
    throw new Error('cross-chain receive route not found')
  }
  const base = toBaseUnitsExact(amount, entry.pair.decimals)
  if (base === null) {
    throw new Error('invalid amount')
  }
  const res = await (await receiverFreeOfExit()).receivePayment({
    paymentMethod: new ReceivePaymentMethod.CrossChain({
      route: entry.pair,
      amount: base,
      destination: entry.landing,
      feeMode: undefined,
      maxSlippageBps: undefined,
      targetOverpayBps: undefined,
    }),
  })
  const info = res.crossChainInfo
  if (!info) {
    throw new Error('cross-chain receive returned no deposit')
  }
  const usdb = entry.landing.tag === SparkAsset_Tags.Token
  return {
    qr: res.paymentRequest,
    address: info.depositAddress,
    sendAmount: formatBaseUnitsExact(info.depositAmount, entry.pair.decimals),
    chain: entry.pair.chain,
    asset: entry.pair.asset,
    landing: usdb ? 'usdb' : 'btc',
    receiveAmount: usdb
      ? Number(formatBaseUnitsExact(info.expectedReceivedAmount, USDB.decimals))
      : Number(info.expectedReceivedAmount),
    expiresAtMs: Number(info.expiresAt) * 1000,
  }
}

export type SparkSendStatus = 'complete' | 'pending' | 'failed'

function toSendStatus(status: PaymentStatus): SparkSendStatus {
  if (status === PaymentStatus.Failed) {
    return 'failed'
  }
  if (status === PaymentStatus.Pending) {
    return 'pending'
  }
  return 'complete'
}

// The send a confirm just left pending, for sparkFollowSend to name by its handle. The confirms keep
// answering a bare status, which is all the callers that never follow want. One slot, since a follow
// comes right after its own confirm, and a confirm that overwrites it only leaves that follow reading
// pending, which is what the send was.
let unsettledSend: { handle: string; paymentId: string } | null = null

// The rail each recent confirm's record went over, by its handle, for the screen that shows the send.
// The quote's kind does not say it, since an invoice can be paid over Spark. Bounded, because a handle
// is read once, right after its confirm answers.
const sentRails = new Map<string, NoticeRail>()
const SENT_RAILS_KEPT = 8

export function sparkSentRail(handle: string): NoticeRail | undefined {
  return sentRails.get(handle)
}

// A send left pending also goes to the wallet's record, which follows it to its end however late.
function sentStatus(handle: string, payment: Payment, walletId: string | null): SparkSendStatus {
  const status = toSendStatus(payment.status)
  const rail = detailMethod(payment)
  sentRails.delete(handle)
  if (rail) {
    sentRails.set(handle, rail)
    if (sentRails.size > SENT_RAILS_KEPT) {
      sentRails.delete(sentRails.keys().next().value as string)
    }
  }
  if (status === 'pending') {
    unsettledSend = { handle, paymentId: payment.id }
    if (walletId !== null) {
      notePendingSend(walletId, payment.id).catch(() => undefined)
    }
  }
  return status
}

const ONCHAIN_SPEED = {
  fast: OnchainConfirmationSpeed.Fast,
  medium: OnchainConfirmationSpeed.Medium,
  slow: OnchainConfirmationSpeed.Slow,
} as const

// Step 2 of a send, signed on device and consuming the handle. onchainSpeed applies only on-chain,
// Lightning and Spark having no fee tiers.
// `idempotencyKey` names the payment for the SDK: re-using one returns the first payment instead of
// making a second, and the key becomes the payment's id. A charge carries the name the gateway
// minted. Send carries one drawn for its prepared request (sendKey.ts) through
// sparkConfirmSendHeld, which keeps that request for Try again if the send throws.
//
// Shape-checked here rather than trusted, since the SDK documents that the key must be a valid UUID
// and a malformed one would fail a send on the money path. Anything else falls back to undefined,
// which sends without a key.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Options are left out unless asked for, because an invoice from the treasury has to settle as that
// invoice for the sale to be delivered, so the Spark route is opt-in per send and no charge opts in.
function sendOptionsFor(onchainSpeed?: OnchainSpeed, preferSpark?: boolean): SendPaymentOptions | undefined {
  if (onchainSpeed) {
    return new SendPaymentOptions.BitcoinAddress({ confirmationSpeed: ONCHAIN_SPEED[onchainSpeed] })
  }
  return preferSpark
    ? new SendPaymentOptions.Bolt11Invoice({ preferSpark: true, completionTimeoutSecs: undefined })
    : undefined
}

export async function sparkConfirmSend(
  handle: string,
  onchainSpeed?: OnchainSpeed,
  idempotencyKey?: string,
  preferSpark?: boolean,
): Promise<SparkSendStatus> {
  const prepared = preparedSends.get(handle)
  if (!prepared) {
    throw new Error('spark send not prepared')
  }
  preparedSends.delete(handle)
  const walletId = connectedWalletId
  const res = await sending(async () =>
    (await signerFreeOfExit()).sendPayment({
      prepareResponse: prepared,
      options: sendOptionsFor(onchainSpeed, preferSpark),
      idempotencyKey: idempotencyKey && UUID.test(idempotencyKey) ? idempotencyKey : undefined,
    }),
  )
  return sentStatus(handle, res.payment, walletId)
}

// Whether a caller's key may go with this prepared send. The SDK refuses one with InvalidInput on any
// send with a token leg, a token sent directly or a conversion ahead of the send
// (payments/send/mod.rs, orchestrate_send), so such a send goes without one. A cross-chain send goes
// without one too, since the SDK names its deposit transfer after the key (cross_chain/orchestra) and
// Try again is not offered for it.
export function sparkSendTakesKey(handle: string): boolean {
  const prepared = preparedSends.get(handle)
  if (prepared) {
    return (
      prepared.paymentMethod.tag !== SendPaymentMethod_Tags.CrossChainAddress &&
      prepared.tokenIdentifier === undefined &&
      prepared.conversionEstimate === undefined
    )
  }
  const lnurl = lnurlPayPrepared.get(handle)
  return lnurl !== undefined && lnurl.conversionEstimate === undefined
}

type HeldAnswer = { payment: Payment; successAction?: HistorySuccessAction }

// A keyed send from Send whose confirm threw, kept under its handle so that Try again sends the very
// request the confirm sent, under the very key, and nothing else. `resend` closes over both. A normal
// confirm never reaches it: the prepared maps lose the handle at the first confirm as before, and
// only sparkRetryHeldSend, given the handle and its key, reads this. Send drops it when it lets the
// quote go, and a restart drops it with the process.
type HeldSend = {
  key: string
  walletId: string | null
  /** Set while a retry of this send runs, so a second one never runs beside it. */
  retrying: boolean
  resend: (sdk: BreezSdkInterface) => Promise<HeldAnswer>
}
const heldSends = new Map<string, HeldSend>()

async function sendHeld(
  handle: string,
  key: string,
  walletId: string | null,
  resend: (sdk: BreezSdkInterface) => Promise<HeldAnswer>,
): Promise<HeldAnswer> {
  try {
    return await sending(async () => resend(await signerFreeOfExit()))
  } catch (cause) {
    heldSends.set(handle, { key, walletId, retrying: false, resend })
    throw cause
  }
}

// sparkConfirmSend for Send, under a key drawn for this prepared request. A send that throws stays
// held for sparkRetryHeldSend. Refused, with the handle left prepared, when the send takes no key
// (sparkSendTakesKey) or the key is not a UUID, since that send has no safe retry.
export async function sparkConfirmSendHeld(
  handle: string,
  key: string,
  onchainSpeed?: OnchainSpeed,
  preferSpark?: boolean,
): Promise<SparkSendStatus> {
  const prepared = preparedSends.get(handle)
  if (!prepared) {
    throw new Error('spark send not prepared')
  }
  if (!sparkSendTakesKey(handle) || !UUID.test(key)) {
    throw new Error('spark send takes no key')
  }
  preparedSends.delete(handle)
  const walletId = connectedWalletId
  const options = sendOptionsFor(onchainSpeed, preferSpark)
  const res = await sendHeld(handle, key, walletId, async sdk => ({
    payment: (await sdk.sendPayment({ prepareResponse: prepared, options, idempotencyKey: key })).payment,
  }))
  return sentStatus(handle, res.payment, walletId)
}

export function sparkDropHeldSend(handle: string): void {
  heldSends.delete(handle)
}

// --- LNURL-pay, paying a Lightning address or LNURL ---
// Three steps rather than two, since the endpoint mints the invoice between parse and pay.

export type SparkLnurlPay = {
  handle: string
  /** Minimum sendable, in sats, the endpoint quoting in millisats. */
  minSat: number
  maxSat: number
  /** Max comment length the endpoint accepts, where 0 means no comment field. */
  commentAllowed: number
  /** The lightning address the endpoint came from, else the service's domain. */
  payee: string
  /** The service's own text/plain description, for an endpoint that names no one. */
  description?: string
}

const lnurlPayRequests = new Map<string, LnurlPayRequestDetails>()
const lnurlPayPrepared = new Map<string, PrepareLnurlPayResponse>()
let lnurlHandleSeq = 0

export async function sparkParseLnurlPay(destination: string): Promise<SparkLnurlPay> {
  const parsed = await requireSdk().parse(paymentInput(destination))
  // A lightning address parses as `LightningAddress` and nests its pay request under `.payRequest`,
  // not as `LnurlPay`. Both kinds reach here, so both must be accepted.
  let details: LnurlPayRequestDetails
  if (parsed.tag === 'LnurlPay') {
    details = (parsed.inner as [LnurlPayRequestDetails])[0]
  } else if (parsed.tag === 'LightningAddress') {
    details = (parsed.inner as [LightningAddressDetails])[0].payRequest
  } else {
    throw new Error('not an lnurl-pay destination')
  }
  const handle = `lnurl_pay_${++lnurlHandleSeq}`
  lnurlPayRequests.set(handle, details)
  return {
    handle,
    minSat: Math.ceil(Number(details.minSendable) / 1000),
    maxSat: Math.floor(Number(details.maxSendable) / 1000),
    commentAllowed: details.commentAllowed,
    payee: details.address ?? details.domain,
    description: lnurlText(details.metadataStr),
  }
}

// Step 1 of an LNURL pay, where the endpoint mints the invoice this quote covers. `dollarBalance` is
// as in sparkPrepareSend, with the amount in USDB base units.
export async function sparkPrepareLnurlPay(
  handle: string,
  amount: number,
  comment?: string,
  spendAll = false,
  dollarBalance = false,
): Promise<SparkSendQuote> {
  const payRequest = lnurlPayRequests.get(handle)
  if (!payRequest) {
    throw new Error('lnurl-pay not parsed')
  }
  const prepared = await sending(() =>
    requireSdk().prepareLnurlPay({
      amount: BigInt(amount),
      payRequest,
      comment: comment && comment.length > 0 ? comment : undefined,
      validateSuccessActionUrl: undefined,
      tokenIdentifier: dollarBalance ? USDB.identifier : undefined,
      conversionOptions: dollarBalance ? dollarSale() : undefined,
      feePolicy: spendAll || dollarBalance ? FeePolicy.FeesIncluded : undefined,
    }),
  )
  const payHandle = `lnurl_prep_${++lnurlHandleSeq}`
  lnurlPayPrepared.set(payHandle, prepared)
  const invoiceMsat = prepared.invoiceDetails?.amountMsat
  return {
    handle: payHandle,
    amount: Number(prepared.amountSats),
    fee: Number(prepared.feeSats),
    // The second invoice is what the payee was asked for, so it is the figure that arrives.
    ...(spendAll || dollarBalance
      ? {
          ...feesIncludedQuote(Number(prepared.amountSats), Number(prepared.feeSats)),
          ...(invoiceMsat === undefined ? {} : { receives: Math.floor(Number(invoiceMsat) / 1000) }),
        }
      : {}),
    description: prepared.invoiceDetails?.description ?? undefined,
    // Without this a wallet holding only dollars reads as out of funds: the SDK has already prepared
    // the token sale, but the screen checks the balance against a conversion it never sees.
    conversion: sendConversionOf(prepared, dollarBalance),
  }
}

export type SparkLnurlPaid = { status: SparkSendStatus; successAction?: HistorySuccessAction }

// `key` as in sparkConfirmSendHeld: the SDK pays an LNURL through the same send, under the invoice this
// prepare minted, so the key guards it the same way (lnurl/pay.rs, send). Given one, a pay that throws
// stays held for sparkRetryHeldSend; refused, with the handle left prepared, when the pay takes no key.
export async function sparkConfirmLnurlPay(handle: string, key?: string): Promise<SparkLnurlPaid> {
  const prepared = lnurlPayPrepared.get(handle)
  if (!prepared) {
    throw new Error('lnurl-pay not prepared')
  }
  if (key !== undefined && (!sparkSendTakesKey(handle) || !UUID.test(key))) {
    throw new Error('lnurl-pay takes no key')
  }
  lnurlPayPrepared.delete(handle)
  const walletId = connectedWalletId
  const pay = async (sdk: BreezSdkInterface): Promise<HeldAnswer> => {
    const res = await sdk.lnurlPay({ prepareResponse: prepared, idempotencyKey: key })
    return { payment: res.payment, successAction: successActionOf(res.successAction) }
  }
  const res =
    key === undefined
      ? await sending(async () => pay(await signerFreeOfExit()))
      : await sendHeld(handle, key, walletId, pay)
  return { status: sentStatus(handle, res.payment, walletId), successAction: res.successAction }
}

// How long Try again waits for the read by key before it counts as no answer.
export const KEY_READ_MS = 5_000

// What the SDK's storage holds under a send's key, which is the id of the payment it names. `none` is
// the storage's answer that it holds no row (isUnknownPayment); any other failure, or no answer within
// KEY_READ_MS, is `unknown`.
function paymentByKey(key: string): Promise<Payment | 'none' | 'unknown'> {
  const read = Promise.resolve()
    .then(() => requireSdk().getPayment({ paymentId: key }))
    .then(
      (answer): Payment | 'none' | null => answer.payment,
      (cause: unknown) => (isUnknownPayment(cause) ? 'none' : null),
    )
  return answerWithin(read, KEY_READ_MS).then(found => found ?? 'unknown')
}

export type SparkRetried =
  | { read: 'unknown' }
  | { status: SparkSendStatus; successAction?: HistorySuccessAction }

// Try again on a held send. The payment under its key decides first, since a send that threw may have
// gone out: a payment found is answered as the confirm would have answered it and nothing is signed. Only
// the storage's own word that it holds no row sends again, the same request under the same key, which
// the SDK and the operators answer with the first payment if it did go out (payments/send/mod.rs, the
// key check; the transfer id is the key). A read that fails or does not answer, another wallet in front,
// or a send dropped while the read was out signs nothing and answers `unknown`. A send that throws again
// stays held. Refused when nothing is held under this handle and key, or a retry of it is running.
export async function sparkRetryHeldSend(handle: string, key: string): Promise<SparkRetried> {
  const held = heldSends.get(handle)
  if (!held || held.key !== key || held.retrying) {
    throw new Error('spark send not held')
  }
  held.retrying = true
  const stillHeld = () => heldSends.get(handle) === held
  try {
    return await sending(async (): Promise<SparkRetried> => {
      if (connectedWalletId !== held.walletId) {
        return { read: 'unknown' }
      }
      const found = await paymentByKey(key)
      if (found === 'unknown' || !stillHeld()) {
        return { read: 'unknown' }
      }
      // An LNURL pay found by its key carries the payee's success action, read as History reads it.
      if (found !== 'none') {
        heldSends.delete(handle)
        return {
          status: sentStatus(handle, found, held.walletId),
          successAction: detailEnrichment(found).successAction,
        }
      }
      const sdk = await signerFreeOfExit()
      if (!stillHeld() || connectedWalletId !== held.walletId) {
        return { read: 'unknown' }
      }
      const res = await held.resend(sdk)
      heldSends.delete(handle)
      return { status: sentStatus(handle, res.payment, held.walletId), successAction: res.successAction }
    })
  } finally {
    held.retrying = false
  }
}

// How long a confirmed send holds the screen for the SDK's own word. An invoice comes back pending at
// once (no `completionTimeoutSecs` is passed) and an LNURL pay has no such option at all, so the wait
// lives here, the same for both. The figure is the SDK's own example, not a measured payment.
export const SEND_WAIT_MS = 10_000

// The SDK's last word on one send, or null when this event is not that. The SDK sends PaymentSucceeded
// only for a Completed payment and PaymentFailed only for a Failed one (events.rs, from_payment).
export function sendOutcomeFromEvent(event: SdkEvent, paymentId: string): 'complete' | 'failed' | null {
  if (event.tag === SdkEvent_Tags.PaymentSucceeded && event.inner.payment.id === paymentId) {
    return 'complete'
  }
  if (event.tag === SdkEvent_Tags.PaymentFailed && event.inner.payment.id === paymentId) {
    return 'failed'
  }
  return null
}

// Sends whose end the confirm screen is still waiting to show itself. The record stays silent about
// them until the wait ends, so one end is never told twice.
const heldByScreen = new Set<string>()

// Tells the end of a recorded send, once, to the wallet that sent it, on the connection that sent it.
// The record gives the send up before anything is announced, so a process killed in between tells
// nothing rather than twice. A registry that cannot be read, a moved wallet, or nobody listening
// leaves the send in the record for a later read.
async function tellSettled(connection: Connection, payment: Payment, outcome: 'complete' | 'failed'): Promise<void> {
  const walletId = connection.walletId
  const paymentId = payment.id
  if (heldByScreen.has(paymentId) || !sendSettledHeard()) {
    return
  }
  const active = await getActiveWalletId()
  const here = () => live === connection && connectedWalletId === walletId && !heldByScreen.has(paymentId)
  if (!here() || (active ?? PRIMARY_ID) !== walletId) {
    return
  }
  if ((await settlePendingSend(walletId, paymentId)) && here()) {
    announceSendSettled(outcome, paymentFacts(payment))
  }
}

// What the SDK's SQLite storage answers for a payment id it holds no row for. rusqlite's
// QueryReturnedNoRows becomes StorageError::Implementation (persist/sqlite.rs, get_payment_by_id),
// and SdkError::StorageError carries it in its display form (error.rs).
const NO_PAYMENT_ROW = 'Underlying implementation error: Query returned no rows'

function isUnknownPayment(cause: unknown): boolean {
  if (!SdkError.instanceOf(cause)) {
    return false
  }
  const { tag, inner } = cause as { tag?: unknown; inner?: unknown }
  return tag === SdkError_Tags.StorageError && Array.isArray(inner) && inner[0] === NO_PAYMENT_ROW
}

// What the SDK stored for one recorded send. The SDK writes a payment before it sends its event
// (payments.rs, record_payment_update), so a read after an event never answers older than it.
//
// A send the storage holds no row for leaves the record, with no notice, only while the connection
// counts as synced from before the read until after it. The SDK logs and drops a failed write of a
// payment (utils/payments.rs, record_payment_update), so a missing row alone does not say the
// operators never saw the send. A synced connection is the closest sign that a sync could have
// stored it, not a proof: the SDK reports only a failed wallet sync, and a payment sync that fails
// beside one that passes is only logged (sdk/sync.rs), so such a send is dropped without its notice
// and no money moves. Any other failure keeps the send for a later read.
async function checkPendingSend(connection: Connection, paymentId: string): Promise<void> {
  const syncedBefore = connection.synced
  const payment = await connection.sdk.getPayment({ paymentId }).then(
    answer => answer.payment,
    async (cause: unknown) => {
      if (syncedBefore && connection.synced && isUnknownPayment(cause)) {
        await dropUnknownSend(connection.walletId, paymentId)
        return null
      }
      throw cause
    },
  )
  if (payment === null) {
    return
  }
  const status = toSendStatus(payment.status)
  if (status !== 'pending') {
    await tellSettled(connection, payment, status)
  }
}

function heardSendEnd(connection: Connection, event: SdkEvent): void {
  if (event.tag !== SdkEvent_Tags.PaymentSucceeded && event.tag !== SdkEvent_Tags.PaymentFailed) {
    return
  }
  const payment = event.inner.payment
  const outcome = sendOutcomeFromEvent(event, payment.id)
  if (payment.paymentType !== PaymentType.Send || outcome === null) {
    return
  }
  tellSettled(connection, payment, outcome).catch(() => undefined)
}

const PENDING_PAGE = 100

// Every send the SDK holds pending, conversion legs aside, which the screen never shows as a send.
async function stillPendingSends(connection: Connection): Promise<string[]> {
  const ids: string[] = []
  for (let offset = 0; ; offset += PENDING_PAGE) {
    const { payments } = await connection.sdk.listPayments({
      typeFilter: [PaymentType.Send],
      statusFilter: [PaymentStatus.Pending],
      assetFilter: undefined,
      paymentDetailsFilter: undefined,
      fromTimestamp: undefined,
      toTimestamp: undefined,
      offset,
      limit: PENDING_PAGE,
      sortAscending: undefined,
    })
    ids.push(...payments.filter(p => !isConversionLeg(p)).map(p => p.id))
    if (payments.length < PENDING_PAGE) {
      return ids
    }
  }
}

// Reads the end of every recorded send from what the SDK stored. The first sync of each connect
// stores an end reached while the app was away and sends no event for it (sdk/sync.rs,
// initial_synced_watcher; sync.rs, reconcile_pending_payments), so this runs at connect, at each
// first Synced and on a return from the background, and the events cover the rest. A torn record is
// rebuilt from the sends the SDK still holds pending and tells nothing; a read the platform refuses
// tells nothing and touches nothing.
function sweepPendingSends(connection: Connection): void {
  const sweep = async () => {
    const read = await readPendingSends(connection.walletId)
    if (read.kind === 'torn') {
      await rebuildPendingSends(connection.walletId, await stillPendingSends(connection))
      return
    }
    for (const paymentId of read.ids) {
      await checkPendingSend(connection, paymentId).catch(() => undefined)
    }
  }
  sweep().catch(() => undefined)
}

// Follows a send a confirm left pending for SEND_WAIT_MS. Resolves `complete` or `failed` when the
// SDK's word comes within the wait, and the screen shows it; `pending` when it does not, and from then
// on the wallet's record follows the send to its end.
//
// The SDK polls a Lightning send for about 185 s (lightning_sender.rs, MAX_POLL_ATTEMPTS) and then
// stops with no event and no write. Past that only a sync moves the row (sync.rs,
// reconcile_pending_payments), and a receiver holding the HTLC keeps it pending for days.
export function sparkFollowSend(handle: string): Promise<SparkSendStatus> {
  const connection = live
  const paymentId = unsettledSend?.handle === handle ? unsettledSend.paymentId : undefined
  if (!connection || paymentId === undefined) {
    return Promise.resolve('pending')
  }
  unsettledSend = null
  heldByScreen.add(paymentId)
  return new Promise(resolve => {
    let over = false
    let listener: string | undefined
    const remove = (id: string) => {
      connection.sdk.removeEventListener(id).catch(() => undefined)
    }
    const finish = (outcome: SparkSendStatus) => {
      if (over) {
        return
      }
      over = true
      clearTimeout(timer)
      if (listener !== undefined) {
        remove(listener)
      }
      resolve(outcome)
      if (outcome === 'pending') {
        heldByScreen.delete(paymentId)
        // A word the record skipped while the screen held the send is read back here.
        checkPendingSend(connection, paymentId).catch(() => undefined)
        return
      }
      // The screen shows this end itself, so the record lets the send go without a notice.
      settlePendingSend(connection.walletId, paymentId)
        .catch(() => false)
        .finally(() => heldByScreen.delete(paymentId))
    }
    const timer = setTimeout(() => finish('pending'), SEND_WAIT_MS)
    const follow = async () => {
      const id = await connection.sdk.addEventListener(
        shielded(event => {
          const outcome = sendOutcomeFromEvent(event, paymentId)
          if (outcome) {
            finish(outcome)
          }
        }),
      )
      if (over) {
        remove(id)
        return
      }
      listener = id
      // Read only now, since the word may have come between the send's return and the listener, and
      // from here on neither side of that gap can miss it.
      const { payment } = await connection.sdk.getPayment({ paymentId })
      const status = toSendStatus(payment.status)
      if (status !== 'pending') {
        finish(status)
      }
    }
    // A read that fails stays pending: the listener and the timer still end this.
    follow().catch(() => undefined)
  })
}

// LNURL-withdraw per LUD-03 pulls sats in, the invoice minted on the device and paid by the endpoint.
export type SparkLnurlWithdraw = {
  handle: string
  /** Minimum withdrawable, in sats, the endpoint quoting in millisats. */
  minSat: number
  maxSat: number
  description: string
}

const lnurlWithdrawRequests = new Map<string, LnurlWithdrawRequestDetails>()

// Held at the read as well as at the pull, so a voucher opened on a held wallet says so before an amount
// is asked for.
export async function sparkParseLnurlWithdraw(destination: string): Promise<SparkLnurlWithdraw> {
  const parsed = await (await receiverFreeOfExit()).parse(paymentInput(destination))
  const tag: string = parsed.tag
  if (tag !== 'LnurlWithdraw') {
    throw new Error('not an lnurl-withdraw voucher')
  }
  const details = (parsed.inner as [LnurlWithdrawRequestDetails])[0]
  const handle = `lnurl_wd_${++lnurlHandleSeq}`
  lnurlWithdrawRequests.set(handle, details)
  return {
    handle,
    minSat: Math.ceil(Number(details.minWithdrawable) / 1000),
    maxSat: Math.floor(Number(details.maxWithdrawable) / 1000),
    description: details.defaultDescription,
  }
}

// With completionTimeoutSecs unset the call returns at once, so an undefined payment is pending, not failed.
export async function sparkConfirmLnurlWithdraw(
  handle: string,
  amountSat: number,
): Promise<SparkSendStatus> {
  const details = lnurlWithdrawRequests.get(handle)
  if (!details) {
    throw new Error('lnurl-withdraw not parsed')
  }
  lnurlWithdrawRequests.delete(handle)
  const res = await sending(async () =>
    (await receiverFreeOfExit()).lnurlWithdraw({
      amountSats: BigInt(amountSat),
      withdrawRequest: details,
      completionTimeoutSecs: undefined,
    }),
  )
  return res.payment === undefined ? 'pending' : toSendStatus(res.payment.status)
}

// --- On-chain deposits, claiming or refunding what the deposit address received ---
// A deposit the SDK did not auto-claim stays stuck until claimed by hand, so Home surfaces it.

// Refused on price alone the deposit is still claimable, so the quoted fee travels with it to be
// approved by hand. Any other claim error is the latest attempt's, and the claim is tried again: by
// the card's Try again, and by the SDK on each sync for a mature deposit (sdk/sync.rs,
// check_and_claim_static_deposits).
export type SparkDeposit = {
  txid: string
  vout: number
  amountSat: number
  claimable: boolean
  quotedFeeSat?: number
  stage: DepositStage
  // Can go back to a Bitcoin address. A mature deposit with no error belongs to the automatic claim.
  refundable: boolean
  refundTxId?: string
  // `pending` is signed and stored but not seen on the network, `broadcast` was accepted by it.
  refundState?: 'pending' | 'broadcast'
  // Why the network refused the refund, which only a new one at a higher fee can fix.
  refundError?: string
}

// Where a pending deposit stands. `arriving` is on its way with nothing to do, `needsFee` waits for a
// fee to be accepted, `tooSmall` would credit under the dust limit after the claim fee, which no ceiling
// changes and the SDK's next pass clears if fees fall, `stuck` failed for another reason, and `returning`
// is being sent back. `stuck` is the last pass's failure, not a verdict: the SDK claims every deposit
// again on each sync and overwrites it, and a quote or fee read that failed on the network lands here
// too (`mature_quote_error`, sdk/deposits.rs, 0.28).
export type DepositStage = 'arriving' | 'needsFee' | 'tooSmall' | 'stuck' | 'returning'

function quotedClaimFee(error: DepositClaimError | undefined): number | undefined {
  return error?.tag === DepositClaimError_Tags.MaxDepositClaimFeeExceeded
    ? Number(error.inner.requiredFeeSats)
    : undefined
}

// A deposit credited early stays listed until the provider spends its output, and the operators' feed
// later marks it mature with no error, so maturity alone would offer money that already arrived.
function creditedEarly(d: DepositInfo): boolean {
  const tag = d.instantClaimStatus?.tag
  return tag === InstantClaimStatus_Tags.Claimed || tag === InstantClaimStatus_Tags.Submitted
}

function refundStateOf(d: DepositInfo): Pick<SparkDeposit, 'refundState' | 'refundError'> {
  if (d.refundState === undefined) {
    return {}
  }
  if (d.refundState.tag === RefundState_Tags.Broadcast) {
    return { refundState: 'broadcast' }
  }
  const { lastError } = d.refundState.inner
  return lastError === undefined
    ? { refundState: 'pending' }
    : { refundState: 'pending', refundError: lastError }
}

// A refused claim is recorded on a mature deposit only, so anything younger is still on its way.
function depositStage(d: DepositInfo, quotedFeeSat: number | undefined): DepositStage {
  if (d.refundTxId !== undefined) {
    return 'returning'
  }
  if (creditedEarly(d) || !d.isMature || d.claimError === undefined) {
    return 'arriving'
  }
  if (d.claimError.tag === DepositClaimError_Tags.DepositTooSmall) {
    return 'tooSmall'
  }
  return quotedFeeSat === undefined ? 'stuck' : 'needsFee'
}

export async function sparkListUnclaimedDeposits(): Promise<SparkDeposit[]> {
  const res = await requireSdk().listUnclaimedDeposits({})
  // Claimed is already a payment in the history, so it stays out or the money shows twice. Submitted
  // has no payment yet, so it stays in or the money shows nowhere.
  const pending = res.deposits.filter(
    d => d.instantClaimStatus?.tag !== InstantClaimStatus_Tags.Claimed,
  )
  return pending.map(d => {
    const quotedFeeSat = quotedClaimFee(d.claimError)
    return {
      txid: d.txid,
      vout: d.vout,
      amountSat: Number(d.amountSats),
      // claim_deposit does not refuse a deposit being refunded, so the refund has to rule it out here.
      claimable:
        d.isMature &&
        !creditedEarly(d) &&
        d.refundTxId === undefined &&
        (d.claimError === undefined || quotedFeeSat !== undefined),
      quotedFeeSat,
      stage: depositStage(d, quotedFeeSat),
      refundable:
        d.isMature && d.claimError !== undefined && d.refundTxId === undefined && !creditedEarly(d),
      ...(d.refundTxId === undefined ? {} : { refundTxId: d.refundTxId }),
      ...refundStateOf(d),
    }
  })
}

// Without an explicit ceiling the SDK falls back to the configured one, so a manual claim could never
// clear what the automatic pass refused. The ceiling given is stored on the deposit: a later automatic
// claim of it once mature runs under the larger of this and the configured one, and an early claim
// under this alone (`mature_claim_ceiling`, sdk/sync.rs, 0.27.2). Claiming without one clears it.
//
// 'deferred' means nothing was claimed and no call is needed: the automatic pass retries it. A mature
// deposit never defers, it settles or throws.
export async function sparkClaimDeposit(
  txid: string,
  vout: number,
  maxFeeSat?: number,
): Promise<SparkSendStatus | 'deferred'> {
  const res = await sending(async () =>
    (await receiverFreeOfExit()).claimDeposit({
      txid,
      vout,
      maxFee: maxFeeSat === undefined ? undefined : flatClaimCeiling(BigInt(maxFeeSat)),
    }),
  )
  switch (res.outcome.tag) {
    case ClaimDepositOutcome_Tags.Settled:
      return toSendStatus(res.outcome.inner.payment.status)
    // An early claim is accepted before it settles, so there is no payment yet.
    case ClaimDepositOutcome_Tags.Submitted:
      return 'pending'
    case ClaimDepositOutcome_Tags.Deferred:
      return 'deferred'
  }
}

// Fixed rather than a rate, so what arrives is exactly the amount less feeSat, the figure the person
// confirmed. The SDK stores the signed refund before it broadcasts and throws if the network refuses,
// so a throw here does not mean nothing happened: read the deposit again to see where it stands.
export async function sparkRefundDeposit(
  txid: string,
  vout: number,
  destinationAddress: string,
  feeSat: number,
): Promise<string> {
  const res = await sending(() =>
    requireSdk().refundDeposit({
      txid,
      vout,
      destinationAddress,
      fee: new Fee.Fixed({ amount: BigInt(feeSat) }),
    }),
  )
  return res.txId
}

// The Bitcoin address a refund may pay, or null for anything else. A BIP21 that names a Spark leg or an
// invoice resolves to that leg, so it is refused here rather than paid on-chain against its intent.
export async function sparkRefundAddress(input: string): Promise<string | null> {
  const info = await sparkInspectDestination(input)
  return info.kind === 'bitcoinAddress' ? (info.resolved ?? input.trim()) : null
}

// Rates in sat/vByte, mapping the SDK's fastest/half-hour/economy tiers onto fast/medium/slow.
export type SparkFeeRates = { fast: number; medium: number; slow: number }

export async function sparkRecommendedFees(): Promise<SparkFeeRates> {
  const fees = await requireSdk().recommendedFees()
  return {
    fast: Number(fees.fastestFee),
    medium: Number(fees.halfHourFee),
    slow: Number(fees.economyFee),
  }
}

// --- Recovering funds onto the chain ---
// The quote and the recovery go through unchanged: `recoverFunds` wants the quote it gave, and
// `checkRecoverFunds` the recovery it returned, which the SDK does not keep.

export type SparkRecoverQuote = PrepareRecoverFundsResponse
export type SparkRecovery = RecoverFundsResponse

// `done` is the SDK's word that every transaction confirmed, `redo` that these can no longer finish.
export type SparkRecoveryVerdict = 'valid' | 'done' | 'redo'
export type SparkRecoveryCheck = { recovery: SparkRecovery; verdict: SparkRecoveryVerdict }

// `ready` is broadcast now. `waiting` needs something it depends on to confirm first, `timelock` a block
// that has yet to come, and `unverified` is a step the chain could not be read for.
export type SparkRecoveryStage = 'confirmed' | 'ready' | 'waiting' | 'timelock' | 'unverified'

export type SparkRecoveryStep = {
  txid: string
  txHex: string
  // The child that pays for this step, which goes out with it as a pair.
  cpfpTxHex: string | undefined
  stage: SparkRecoveryStage
  cooperative: boolean
  spendableAtHeight: number | undefined
}

function recoveryStep(tx: SparkRecovery['transactions'][number]): SparkRecoveryStep {
  const stage = (): SparkRecoveryStage => {
    switch (tx.status.tag) {
      case ExitTransactionStatus_Tags.Confirmed:
        return 'confirmed'
      case ExitTransactionStatus_Tags.Ready:
        return 'ready'
      case ExitTransactionStatus_Tags.WaitingForTimelock:
        return 'timelock'
      case ExitTransactionStatus_Tags.Unverified:
        return 'unverified'
      default:
        return 'waiting'
    }
  }
  return {
    txid: tx.txid,
    txHex: tx.txHex,
    cpfpTxHex: tx.cpfpTxHex,
    stage: stage(),
    cooperative: tx.kind === RecoveryTxKind.Cooperative,
    spendableAtHeight:
      tx.status.tag === ExitTransactionStatus_Tags.WaitingForTimelock ? tx.status.inner.spendableAtHeight : undefined,
  }
}

// The transactions that pay the destination, which is what a relay's dust limit is held against.
export function sparkRecoveryPayouts(recovery: SparkRecovery): string[] {
  return recovery.transactions
    .filter(tx => tx.kind === RecoveryTxKind.Cooperative || tx.kind === RecoveryTxKind.Sweep)
    .map(tx => tx.txHex)
}

export const sparkLeafIsCooperative = (leaf: SparkRecovery['leaves'][number]): boolean =>
  leaf.method === RecoveryMethod.Cooperative

export function sparkRecoverySteps(recovery: SparkRecovery): SparkRecoveryStep[] {
  return recovery.transactions.map(recoveryStep)
}

// Why leaves stayed out of a quote. Unverified, FundsNotFound and NotRecoverable all come down to the
// device not holding, or not finding, what a recovery needs, whatever the fee rate. OperatorsUnavailable
// is the one that only asks to prepare again later, whatever else the quote holds.
export function sparkSkippedReasons(quote: SparkRecoverQuote): {
  feeTooHigh: boolean
  noData: boolean
  operators: boolean
} {
  const tags = quote.skipped.map(leaf => leaf.reason.tag)
  return {
    feeTooHigh: tags.includes(SkippedLeafReason_Tags.FeeExceedsValue),
    noData: tags.some(
      tag => tag !== SkippedLeafReason_Tags.FeeExceedsValue && tag !== SkippedLeafReason_Tags.OperatorsUnavailable,
    ),
    operators: tags.includes(SkippedLeafReason_Tags.OperatorsUnavailable),
  }
}

// A leaf out for either of these stayed out on a read that failed, not on anything the SDK knows of it.
export const sparkLeafUnverified = (quote: SparkRecoverQuote): boolean =>
  quote.skipped.some(
    leaf =>
      leaf.reason.tag === SkippedLeafReason_Tags.Unverified ||
      leaf.reason.tag === SkippedLeafReason_Tags.OperatorsUnavailable,
  )

// Whether the chain was read whole for this quote, or its figures rest on a read that failed.
export function sparkQuoteReadChain(quote: SparkRecoverQuote): boolean {
  const { unverifiedNodeIds, unverifiableConfirmedNodeIds } = quote.exitChainState
  return (
    unverifiedNodeIds.length === 0 && unverifiableConfirmedNodeIds.length === 0 && !sparkLeafUnverified(quote)
  )
}

export type SparkFundingStrategy = CpfpFundingStrategy

// 'all' reaches the leaves still in the balance, which is for the day the operators are gone. A repeat
// of a recovery names its leaves, the only selection that keeps one a new fee rate would drop.
export type SparkRecoverSelection = 'recoverable' | 'all' | { leafIds: string[] }

function exitLeaves(selection: SparkRecoverSelection): ExitLeafSelection {
  if (selection === 'recoverable') {
    return new ExitLeafSelection.RecoverableOnly()
  }
  return selection === 'all'
    ? new ExitLeafSelection.All()
    : new ExitLeafSelection.Specific({ leafIds: selection.leafIds })
}

// The rate a recovery is prepared at, or null when the SDK cannot say. A recovery is built for that one
// rate, and a guess below the relay minimum goes nowhere, so the caller stops instead of choosing.
export async function sparkExitFeeRate(tier: 'medium' | 'fast' = 'medium'): Promise<bigint | null> {
  try {
    const rate = (await sparkRecommendedFees())[tier]
    return Number.isFinite(rate) && rate > 0 ? BigInt(Math.ceil(rate)) : null
  } catch {
    return null
  }
}

// Funding is always P2WPKH, the address exitFeeKey derives. The SDK ignores the kind when the quote
// has nothing to fund.
export async function sparkPrepareRecoverFunds(request: {
  feeRateSatPerVbyte: bigint
  destination: string
  selection: SparkRecoverSelection
  // Unset funds one UTXO per branch. A plan hands back the strategy it was built with.
  fundingStrategy?: SparkFundingStrategy
}): Promise<SparkRecoverQuote> {
  return sending(() =>
    requireSdk().prepareRecoverFunds({
      feeRateSatPerVbyte: request.feeRateSatPerVbyte,
      destination: request.destination,
      fundingKind: new CpfpFundingKind.P2wpkh(),
      fundingStrategy: request.fundingStrategy,
      selection: exitLeaves(request.selection),
    }),
  )
}

export type SparkExitFunding = {
  utxos: { txid: string; vout: number; valueSat: number }[]
  // Compressed, in hex, as the SDK's P2wpkh input asks.
  publicKey: string
  secretKey: Uint8Array
}

// A quote with no `funding` takes neither inputs nor a signer, as the doc says. The bytes the signer
// is built from are a copy, wiped once the call ends.
export async function sparkRecoverFunds(
  quote: SparkRecoverQuote,
  funding?: SparkExitFunding,
): Promise<SparkRecovery> {
  const sdk = requireSdk()
  if (quote.funding === undefined || funding === undefined) {
    return sending(() => sdk.recoverFunds({ prepared: quote, fundingInputs: [] }, undefined))
  }
  const secret = Uint8Array.from(funding.secretKey)
  const fundingInputs = funding.utxos.map(
    utxo =>
      new CpfpInput.P2wpkh({
        txid: utxo.txid,
        vout: utxo.vout,
        valueSats: BigInt(utxo.valueSat),
        pubkey: funding.publicKey,
      }),
  )
  try {
    return await sending(() =>
      sdk.recoverFunds({ prepared: quote, fundingInputs }, singleKeyCpfpSigner(secret.buffer)),
    )
  } finally {
    secret.fill(0)
  }
}

export async function sparkCheckRecoverFunds(recovery: SparkRecovery): Promise<SparkRecoveryCheck> {
  const answer = await requireSdk().checkRecoverFunds({ recovery })
  const verdict: SparkRecoveryVerdict =
    answer.verdict.tag === RecoveryVerdict_Tags.Done
      ? 'done'
      : answer.verdict.tag === RecoveryVerdict_Tags.Redo
        ? 'redo'
        : 'valid'
  return { recovery: answer.recovery, verdict }
}

// The utxos a recovery was built from, in the form a new build of it takes. A funding input is always
// P2WPKH here, so any other kind reads as absent rather than as an input of the wrong shape.
export function sparkRecoveryFundingUtxos(recovery: SparkRecovery): SparkExitFunding['utxos'] {
  return recovery.fundingInputs.flatMap(input =>
    input.tag === CpfpInput_Tags.P2wpkh
      ? [{ txid: input.inner.txid, vout: input.inner.vout, valueSat: Number(input.inner.valueSats) }]
      : [],
  )
}

// The funding a recovery asks for at the least, as the SDK says when what it was given falls short.
export function sparkMissingFunding(cause: unknown): number | null {
  const { tag, inner } = (cause ?? {}) as { tag?: unknown; inner?: { requiredSats?: unknown } }
  return tag === SdkError_Tags.InsufficientCpfpFunds && typeof inner?.requiredSats === 'bigint'
    ? Number(inner.requiredSats)
    : null
}

// A kept recovery the SDK cannot take back, as after an upgrade: the check refuses it as input, and
// what it names is still good for building again.
export function sparkRecoveryRefused(cause: unknown): boolean {
  return (cause as { tag?: unknown } | null)?.tag === SdkError_Tags.InvalidInput
}

// A Bitcoin address of the network the wallet runs on, as typed, for the end of an exit. Anything
// around it is refused rather than read: a BIP21 can carry other legs, and an exit pays only an address.
export type SparkExitDestination =
  | { status: 'ok'; address: string }
  // The address parsed, and the wallet could not read its own to compare it with.
  | { status: 'unchecked'; address: string }
  | { status: 'refused'; reason: 'notAddress' | 'uri' | 'own' }

const NOT_A_BARE_ADDRESS = /[:?=&\s]/
const OWN_ADDRESS_WAIT_MS = 10_000

export async function sparkExitDestination(input: string): Promise<SparkExitDestination> {
  const text = input.trim()
  if (NOT_A_BARE_ADDRESS.test(text)) {
    return { status: 'refused', reason: 'uri' }
  }
  const sdk = requireSdk()
  const parsed = await sdk.parse(text).catch(() => null)
  if (parsed?.tag !== 'BitcoinAddress') {
    return { status: 'refused', reason: 'notAddress' }
  }
  const { address, network } = (parsed.inner as readonly [BitcoinAddressDetails])[0]
  if (network !== BitcoinNetwork.Bitcoin) {
    return { status: 'refused', reason: 'notAddress' }
  }
  // Paying the wallet's own address hands the funds back to the operators the exit is leaving. They
  // are the ones who answer this read, so with them gone it fails. That says nothing about the address
  // and must not stop the exit on the day it exists for, so the person gets the choice.
  const own = await answerWithin(ownReceive('onchain').catch(() => null), OWN_ADDRESS_WAIT_MS)
  if (own === null) {
    return { status: 'unchecked', address }
  }
  if (own.destination.toLowerCase() === address.toLowerCase()) {
    return { status: 'refused', reason: 'own' }
  }
  return { status: 'ok', address }
}

// --- Contacts (an address book of saved payees) ---
// The SDK owns the storage, and a saved payee pays through the LNURL-pay flow.

export type SparkContact = {
  id: string
  name: string
  /** A Lightning address (user@domain), the SDK's paymentIdentifier. */
  address: string
}

export async function sparkListContacts(): Promise<SparkContact[]> {
  const contacts = await requireSdk().listContacts({ offset: undefined, limit: undefined })
  return contacts.map(c => ({ id: c.id, name: c.name, address: c.paymentIdentifier }))
}

export async function sparkAddContact(name: string, address: string): Promise<SparkContact> {
  const c = await requireSdk().addContact({ name, paymentIdentifier: address })
  return { id: c.id, name: c.name, address: c.paymentIdentifier }
}

export async function sparkUpdateContact(id: string, name: string, address: string): Promise<void> {
  await requireSdk().updateContact({ id, name, paymentIdentifier: address })
}

export async function sparkDeleteContact(id: string): Promise<void> {
  await requireSdk().deleteContact(id)
}

// A webhook the Spark provider holds for the wallet, which it POSTs the wallet's payment events to,
// signed with the secret it was registered with (guide/webhooks.html). `events` are the binding's tags,
// and an event this binding does not know reads as `Unknown:<name>`.
export type SparkWebhook = {
  id: string
  url: string
  events: string[]
}

function listWebhooksOn(sdk: BreezSdkInterface): Promise<SparkWebhook[]> {
  return sdk.listWebhooks().then(hooks =>
    hooks.map(h => ({
      id: h.id,
      url: h.url,
      events: h.eventTypes.map(e => (e.tag === WebhookEventType_Tags.Unknown ? `Unknown:${e.inner[0]}` : e.tag)),
    })),
  )
}

// Every payment event the provider has: a Lightning receive on an invoice the wallet made, a Lightning
// send that finished either way (a hold invoice settling hours later included), an on-chain send, and
// an on-chain deposit claimed. Resolves to the provider's id for the webhook.
async function registerWebhookOn(sdk: BreezSdkInterface, url: string, secret: string): Promise<string> {
  const { webhookId } = await sdk.registerWebhook({
    url,
    secret,
    eventTypes: [
      new WebhookEventType.LightningReceiveFinished(),
      new WebhookEventType.LightningSendFinished(),
      new WebhookEventType.CoopExitFinished(),
      new WebhookEventType.StaticDepositFinished(),
    ],
  })
  return webhookId
}

export function sparkListWebhooks(): Promise<SparkWebhook[]> {
  return listWebhooksOn(requireSdk())
}

export function sparkRegisterWebhook(url: string, secret: string): Promise<string> {
  return registerWebhookOn(requireSdk(), url, secret)
}

export async function sparkUnregisterWebhook(webhookId: string): Promise<void> {
  await requireSdk().unregisterWebhook({ webhookId })
}

export type SparkWebhookSession = {
  list(): Promise<SparkWebhook[]>
  register(url: string, secret: string): Promise<string>
  unregister(webhookId: string): Promise<void>
}

// The webhook calls of one connection, refused when that connection is not `walletId`'s, refused at
// each call when its identity is not `pubkey`, and refused again once it is no longer live. A pass
// that started on one wallet therefore never lists, removes or registers on the wallet switched to,
// nor on the same id opened with other words, whose webhooks, secret and removal marker are their own.
export function sparkWebhookSession(walletId: string, pubkey: string): SparkWebhookSession {
  const connection = requireConnection()
  if (connection.walletId !== walletId) {
    throw new Error('spark connected as another wallet')
  }
  const sdk = async (): Promise<BreezSdkInterface> => {
    const identity = live === connection ? (connection.identity ?? (await identityOf(connection))) : null
    if (live !== connection) {
      throw new Error('spark not connected')
    }
    if (identity !== pubkey) {
      throw new Error('spark connected as another identity')
    }
    return connection.sdk
  }
  return {
    list: async () => listWebhooksOn(await sdk()),
    register: async (url, secret) => registerWebhookOn(await sdk(), url, secret),
    unregister: async webhookId => {
      await (await sdk()).unregisterWebhook({ webhookId })
    },
  }
}

// The pools pair bitcoin with a token, so one token and the direction name both sides.
type PreparedConversion = {
  prepared: PrepareSendPaymentResponse
  tokenId: string | undefined
  fromBitcoin: boolean
}

const preparedConversions = new Map<string, PreparedConversion>()
let convHandleSeq = 0

export type SparkConvertQuote = {
  handle: string
  /** What leaves, in base units of the source asset, so sats from BTC and token units from a token. */
  spentBaseUnits: number
  /** What arrives, in base units of the destination asset. */
  receivedBaseUnits: number
  /** The two figures above as the SDK gave them, since a double drops a token's digits past
   *  about 15. A figure is drawn from these only while it still equals its Number, so a pair that
   *  replaces one leg's figure never draws the other leg's. */
  spentExact?: bigint
  receivedExact?: bigint
  /** What the pool is expected to give when `receivedBaseUnits` is the floor of an exact input. */
  expectedBaseUnits?: number
  /** Conversion fee, in sats when converting from BTC, else in token base units. */
  feeBaseUnits: number | undefined
}

// Slippage ceiling in basis points. The SDK's 0.1% default rejects real conversions, because the thin
// Flashnet USDB pool drifts more than that between prepare and confirm.
const CONVERT_MAX_SLIPPAGE_BPS = 100

// On an exact input the SDK's amountOut is the floor it signs, the pool's own answer cut by the
// slippage allowed (ConversionAmount::AmountIn in flashnet.rs), so a cost read from it counts the
// whole allowance as if the pool had charged it. The two exact-input calls here allow the same.
function expectedOfFloor(floor: bigint): number {
  return Math.round((Number(floor) * 10_000) / (10_000 - CONVERT_MAX_SLIPPAGE_BPS))
}

// One prepared conversion for a desired OUTPUT in destination base units. Direction is inferred from
// which side is BTC, so an undefined `toTokenId` means a conversion to BTC.
async function prepareConvertForOutput(
  selfAddress: string,
  fromTokenId: string | undefined,
  toTokenId: string | undefined,
  outBaseUnits: number | bigint,
): Promise<SparkConvertQuote> {
  const conversionType =
    toTokenId === undefined
      ? new ConversionType.ToBitcoin({ fromTokenIdentifier: fromTokenId ?? '' })
      : new ConversionType.FromBitcoin()
  const prepared = await requireSdk().prepareSendPayment({
    paymentRequest: new PaymentRequest.Input({ input: selfAddress }),
    // A typed output is exact already, while the search's own steps are doubles to round.
    amount:
      typeof outBaseUnits === 'bigint'
        ? outBaseUnits > 0n
          ? outBaseUnits
          : 1n
        : BigInt(Math.max(1, Math.round(outBaseUnits))),
    tokenIdentifier: toTokenId,
    conversionOptions: ConversionOptions.create({
      conversionType,
      maxSlippageBps: CONVERT_MAX_SLIPPAGE_BPS,
    }),
    feePolicy: undefined,
  })
  const est = prepared.conversionEstimate
  const handle = `spark_conv_${++convHandleSeq}`
  preparedConversions.set(handle, {
    prepared,
    tokenId: toTokenId ?? fromTokenId,
    fromBitcoin: toTokenId !== undefined,
  })
  return {
    handle,
    spentBaseUnits: est ? Number(est.amountIn) : 0,
    receivedBaseUnits: est ? Number(est.amountOut) : Number(prepared.amount),
    ...(est ? { spentExact: est.amountIn } : {}),
    receivedExact: est ? est.amountOut : prepared.amount,
    feeBaseUnits: est ? Number(est.fee) : undefined,
  }
}

// The SDK has no standalone convert, so this is a send to the wallet's own Spark address carrying a
// conversion step. The conversion is exact-OUT, hence `receiveBaseUnits` is the desired output, a bigint
// when typed in a token, since a double cannot carry an 18-place figure.
export function sparkPrepareConvert(
  fromTokenId: string | undefined,
  toTokenId: string | undefined,
  receiveBaseUnits: number | bigint,
): Promise<SparkConvertQuote> {
  return sending(async () => {
    const selfAddress = (await ownReceive('spark')).destination
    return prepareConvertForOutput(selfAddress, fromTokenId, toTokenId, receiveBaseUnits)
  })
}

// The SDK conversion is exact-OUT only, so a typed spend cannot be pinned and the output is
// corrected instead until conversionEstimate.amountIn matches. A dust or minimum floor can push the
// smallest valid swap past the target, in which case that quote is returned and shows a larger spend.
// A token spent into sats takes its exact input. Sats are whole, so an exact output reaches the spend
// only to within one sat of token, left behind as a remainder. With the token id and an amount in its
// base units the SDK quotes the sats out for that input, the shape Breez's own mainnet tests use, and
// at confirm it converts exactly that input (AmountIn) and, to the wallet's own address, sends nothing.
async function prepareConvertForInput(
  selfAddress: string,
  fromTokenId: string,
  spendBaseUnits: number | bigint,
): Promise<SparkConvertQuote> {
  const prepared = await requireSdk().prepareSendPayment({
    paymentRequest: new PaymentRequest.Input({ input: selfAddress }),
    amount: BigInt(spendBaseUnits),
    tokenIdentifier: fromTokenId,
    conversionOptions: ConversionOptions.create({
      conversionType: new ConversionType.ToBitcoin({ fromTokenIdentifier: fromTokenId }),
      maxSlippageBps: CONVERT_MAX_SLIPPAGE_BPS,
    }),
    feePolicy: undefined,
  })
  const est = prepared.conversionEstimate
  // Without an estimate the SDK would send the token to the wallet's own address, not convert it.
  if (!est) {
    throw new Error('conversion estimate missing')
  }
  const handle = `spark_conv_${++convHandleSeq}`
  preparedConversions.set(handle, { prepared, tokenId: fromTokenId, fromBitcoin: false })
  return {
    handle,
    spentBaseUnits: Number(est.amountIn),
    receivedBaseUnits: Number(est.amountOut),
    spentExact: est.amountIn,
    receivedExact: est.amountOut,
    expectedBaseUnits: expectedOfFloor(est.amountOut),
    feeBaseUnits: Number(est.fee),
  }
}

// One `sending` for the whole search, since a reconnect between two of its prepares fails the quote.
// A token spent into sats goes in exactly, as a bigint when typed; the search over sats reads a double.
export function sparkPrepareConvertBySpend(
  fromTokenId: string | undefined,
  toTokenId: string | undefined,
  spendBaseUnits: number | bigint,
  initialOut: number,
): Promise<SparkConvertQuote> {
  return sending(() => prepareConvertBySpend(fromTokenId, toTokenId, spendBaseUnits, initialOut))
}

async function prepareConvertBySpend(
  fromTokenId: string | undefined,
  toTokenId: string | undefined,
  exactSpend: number | bigint,
  initialOut: number,
): Promise<SparkConvertQuote> {
  const selfAddress = (await ownReceive('spark')).destination
  if (fromTokenId !== undefined && toTokenId === undefined) {
    return prepareConvertForInput(selfAddress, fromTokenId, exactSpend)
  }
  const spendBaseUnits = Number(exactSpend)
  const created: string[] = []
  const seen = new Set<number>()
  let out = Math.max(1, Math.round(initialOut))
  let last: SparkConvertQuote | null = null
  let best: SparkConvertQuote | null = null
  for (let i = 0; i < 8; i++) {
    // Stops the down-nudge below from oscillating between the last-over and first-under output.
    if (seen.has(out)) {
      break
    }
    seen.add(out)
    const quote = await prepareConvertForOutput(selfAddress, fromTokenId, toTokenId, out)
    created.push(quote.handle)
    last = quote
    const spent = quote.spentBaseUnits
    // Largest quote that does not overspend. With none fitting, `last` stands in.
    if (spent > 0 && spent <= spendBaseUnits && (best === null || spent > best.spentBaseUnits)) {
      best = quote
    }
    if (spent === spendBaseUnits || spent <= 0) {
      break
    }
    let next = Math.max(1, Math.round((out * spendBaseUnits) / spent))
    if (next === out) {
      // The proportional step rounds back to the same integer output near the target. A quote that
      // still overspends would stall one unit over budget, so nudging down one reaches the largest that
      // fits.
      if (spent <= spendBaseUnits) {
        break
      }
      next = out - 1
    }
    if (next < 1) {
      break
    }
    out = next
  }
  const chosen = best ?? last ?? (await prepareConvertForOutput(selfAddress, fromTokenId, toTokenId, out))
  for (const handle of created) {
    if (handle !== chosen.handle) {
      preparedConversions.delete(handle)
    }
  }
  return chosen
}

// Frees a quote the UI dropped, so re-quoting on each keystroke does not pile responses up in memory.
export function sparkDiscardConvertQuote(handle: string): void {
  preparedConversions.delete(handle)
}

export async function sparkConfirmConvert(handle: string): Promise<SparkSendStatus> {
  return (await sparkConfirmConvertLeg(handle)).status
}

// What the SDK quoted, for the row of a conversion it says little about. Detached, since the money has
// moved by now: a conversion never waits on its note nor fails with it. The log carries no amount and
// no id. The estimate's fee is in the asset going in (ConversionEstimate.fee).
function noteConversion(
  sdk: BreezSdkInterface,
  walletId: string | null,
  { prepared, tokenId, fromBitcoin }: PreparedConversion,
  paymentId: string | undefined,
  era: number,
): void {
  const estimate = prepared.conversionEstimate
  if (!estimate || !walletId || !paymentId || tokenId === undefined) {
    return
  }
  const write = async () => {
    const res = await sdk.getTokensMetadata({ tokenIdentifiers: [tokenId] })
    const meta = res.tokensMetadata.find(entry => entry.identifier === tokenId)
    if (!meta) {
      throw new Error('token not known')
    }
    const token = { ticker: meta.ticker, decimals: meta.decimals }
    const bitcoin = { ticker: null, decimals: 0 }
    const [from, to] = fromBitcoin ? [bitcoin, token] : [token, bitcoin]
    await keepConversionNote(
      walletId,
      paymentId,
      {
        from: { ...from, baseUnits: estimate.amountIn.toString() },
        to,
        fee: { ...from, baseUnits: estimate.fee.toString() },
      },
      era,
    )
  }
  write().catch(() => console.warn('conversion note not kept'))
}

// A conversion to the wallet's own address returns once the converted side has landed, so the
// payment's amount is what arrived, in the destination's base units, which is the most a second leg
// can spend. That payment is the leg that arrived, the one row the conversion has in the list.
export async function sparkConfirmConvertLeg(
  handle: string,
): Promise<{ status: SparkSendStatus; receivedBaseUnits: number }> {
  const quote = preparedConversions.get(handle)
  if (!quote) {
    throw new Error('spark conversion not prepared')
  }
  preparedConversions.delete(handle)
  // Read before the send, since the wallet can change while it runs and the note belongs to this one.
  // The signer comes from the same connection, or the exit check refuses.
  const walletId = connectedWalletId
  const era = conversionNotesEra(walletId)
  let sdk!: BreezSdkInterface
  const res = await sending(async () => {
    sdk = await signerFreeOfExit()
    return sdk.sendPayment({
      prepareResponse: quote.prepared,
      options: undefined,
      idempotencyKey: undefined,
    })
  })
  const status = toSendStatus(res.payment.status)
  if (status !== 'failed') {
    noteConversion(sdk, walletId, quote, res.payment.id, era)
  }
  return { status, receivedBaseUnits: Number(res.payment.amount ?? 0) }
}

// minFrom is the least spendable in source base units, minTo the least receivable in destination units.
export type SparkConvertLimits = { minFromBaseUnits?: number; minToBaseUnits?: number }

export async function sparkConversionLimits(
  fromTokenId: string | undefined,
  toTokenId: string | undefined,
): Promise<SparkConvertLimits> {
  const conversionType =
    toTokenId === undefined
      ? new ConversionType.ToBitcoin({ fromTokenIdentifier: fromTokenId ?? '' })
      : new ConversionType.FromBitcoin()
  const res = await requireSdk().fetchConversionLimits({ conversionType, tokenIdentifier: toTokenId })
  return {
    minFromBaseUnits: res.minFromAmount === undefined ? undefined : Number(res.minFromAmount),
    minToBaseUnits: res.minToAmount === undefined ? undefined : Number(res.minToAmount),
  }
}

// --- Stable balance, holding the wallet's value in a dollar token instead of in BTC ---
// Eligible tokens are declared at connect in buildConfig, and this is the runtime switch. Funds never
// leave the device's control, as a conversion is an AMM swap signed here.

export async function sparkGetStableBalance(): Promise<boolean> {
  const settings = await requireSdk().getUserSettings()
  return settings.stableBalanceActiveLabel !== undefined
}

// Turning it off converts the token balance back to BTC, so both directions move user funds.
// Notified right after the stable balance is switched, so chrome that follows the mode repaints on
// the spot rather than waiting for the next payment or reconnect.
const stableBalanceListeners = new Set<(active: boolean) => void>()

export function onStableBalanceChanged(cb: (active: boolean) => void): () => void {
  stableBalanceListeners.add(cb)
  return () => {
    stableBalanceListeners.delete(cb)
  }
}

// Counted as a send, since the switch converts the balance on the instance a reconnect would drop.
// Turning it on sells the wallet's sats, so it waits out an exit. Turning it off sells only the token,
// whose fee is the token's, so it is not held; a connection opened during an exit has no stable balance
// (buildConfig), reads it as off, and the SDK refuses a change to it until the exit ends.
export async function sparkSetStableBalance(active: boolean): Promise<void> {
  await sending(async () =>
    (active ? await signerFreeOfExit() : requireSdk()).updateUserSettings({
      sparkPrivateModeEnabled: undefined,
      stableBalanceActiveLabel: active
        ? new StableBalanceActiveLabel.Set({ label: STABLE_BALANCE_LABEL })
        : new StableBalanceActiveLabel.Unset(),
      // Undefined leaves the setting unchanged, as with sparkPrivateModeEnabled above.
      sparkMasterIdentityPublicKey: undefined,
    }),
  )
  stableBalanceListeners.forEach(cb => cb(active))
}

function historyStatus(status: PaymentStatus): HistoryStatus {
  if (status === PaymentStatus.Failed) {
    return 'failed'
  }
  if (status === PaymentStatus.Pending) {
    return 'pending'
  }
  return 'complete'
}

// What a notice may say about a payment: its rail, its raw amount, and a token's amount in the token's
// unit. A token payment whose record carries no metadata has no unit to read, and says so rather than
// passing its base units off as sats.
// A send past Spark (Orchestra or Boltz) leaves on a Spark transfer and is delivered on another chain,
// so the transfer's rail is not how it went, and the card names none, as the send overlay does.
function paymentFacts(p: Payment): PaymentFacts {
  const crossChain = detailCrossChainSend(p).crossChainSend !== undefined
  const rail = crossChain ? undefined : detailMethod(p)
  const asset = detailAsset(p)
  const token = p.method === SdkPaymentMethod.Token || p.details?.tag === 'Token'
  return {
    sat: Number(p.amount),
    ...(rail ? { rail } : {}),
    ...(crossChain ? { crossChain: true } : {}),
    ...(asset ? { asset: { assetId: asset.assetId, amount: asset.amount } } : token ? { tokenUnread: true } : {}),
  }
}

// The SDK notes payment details can be empty, hence the fallback to the p.method enum.
function detailMethod(p: Payment): PaymentMethod | undefined {
  const details = p.details
  if (details) {
    const tag: string = details.tag
    if (tag === 'Lightning') {
      return 'lightning'
    }
    if (tag === 'Withdraw' || tag === 'Deposit') {
      return 'bitcoin'
    }
    if (tag === 'Spark' || tag === 'Token') {
      return 'spark'
    }
  }
  switch (p.method) {
    case SdkPaymentMethod.Lightning:
      return 'lightning'
    case SdkPaymentMethod.Deposit:
    case SdkPaymentMethod.Withdraw:
      return 'bitcoin'
    case SdkPaymentMethod.Spark:
    case SdkPaymentMethod.Token:
      return 'spark'
    default:
      return undefined
  }
}

// Also read for the answer to a send, which carries the same processed action. An encrypted action
// the SDK could not open has nothing to show, and neither has one it has no preimage for yet.
export function successActionOf(action: SuccessActionProcessed | undefined): HistorySuccessAction | undefined {
  if (action?.tag === SuccessActionProcessed_Tags.Message) {
    return { kind: 'message', text: action.inner.data.message }
  }
  if (action?.tag === SuccessActionProcessed_Tags.Url) {
    const { url, description, matchesCallbackDomain } = action.inner.data
    return { kind: 'url', url, description, ...(matchesCallbackDomain ? {} : { foreignHost: true }) }
  }
  if (action?.tag === SuccessActionProcessed_Tags.Aes) {
    const { result } = action.inner
    return result.tag === AesSuccessActionDataResult_Tags.Decrypted
      ? { kind: 'message', text: result.inner.data.plaintext, description: result.inner.data.description }
      : undefined
  }
  return undefined
}

// A receive has no counterparty to name: the Lightning node key is the wallet's own side, and a Spark
// invoice is what it asked for, so that one reads as the invoice. A token's txHash is a Spark hash and
// a Spark payment's id is its transfer id. Neither is a Bitcoin txid, so neither is surfaced as txId.
function detailEnrichment(p: Payment): Pick<
  HistoryItem,
  | 'txId'
  | 'description'
  | 'destination'
  | 'lnAddress'
  | 'invoice'
  | 'transferRef'
  | 'paymentHash'
  | 'preimage'
  | 'comment'
  | 'successAction'
> {
  const details = p.details
  if (!details) {
    return {}
  }
  const sent = p.paymentType === PaymentType.Send
  const inner = details.inner
  if ('destinationPubkey' in inner) {
    const pay = sent ? inner.lnurlPayInfo : undefined
    return {
      description: inner.description ?? undefined,
      // The lightning address takes priority over the raw node pubkey as the counterparty.
      destination: sent ? pay?.lnAddress ?? inner.destinationPubkey : undefined,
      lnAddress: pay?.lnAddress,
      invoice: inner.invoice || undefined,
      paymentHash: inner.htlcDetails?.paymentHash || undefined,
      preimage: inner.htlcDetails?.preimage || undefined,
      comment: pay?.comment?.trim() ? pay.comment : undefined,
      successAction: successActionOf(pay?.processedSuccessAction),
    }
  }
  if ('txId' in inner) {
    return { txId: inner.txId }
  }
  if ('invoiceDetails' in inner) {
    const invoice = inner.invoiceDetails?.invoice
    return {
      description: inner.invoiceDetails?.description ?? undefined,
      destination: sent ? invoice : undefined,
      invoice: sent ? undefined : invoice,
      transferRef: 'txHash' in inner ? inner.txHash : p.id,
    }
  }
  return {}
}

// `p.amount` on a token payment is that token's base units, so without this 10 USDB reads as "10 sats".
function detailAsset(p: Payment): HistoryAsset | null {
  const details = p.details
  if (details && details.tag === 'Token' && 'metadata' in details.inner) {
    const meta = details.inner.metadata
    return {
      assetId: meta.identifier,
      ticker: meta.ticker,
      amount: formatAssetAmount(Number(p.amount), meta.decimals),
      fee: positiveBaseUnits(p.fees, meta.decimals),
    }
  }
  return null
}

// A cross-chain receive arrives as a plain transfer the SDK later annotates with its source. On a send
// the same info names the destination, so it is read on receives only.
function detailCrossChain(p: Payment): Pick<HistoryItem, 'crossChain'> {
  if (p.paymentType !== PaymentType.Receive) {
    return {}
  }
  const details = p.details
  const info = details && 'conversionInfo' in details.inner ? details.inner.conversionInfo : undefined
  if (info?.tag !== ConversionInfo_Tags.Orchestra) {
    return {}
  }
  const o = info.inner
  return {
    crossChain: {
      chain: o.chain,
      asset: o.asset,
      amountIn: o.assetAmountIn === undefined ? undefined : formatBaseUnitsExact(o.assetAmountIn, o.assetDecimals),
      txHash: o.externalTxHash,
    },
  }
}

// A send's info names where it went and how far it got. Boltz has no transaction to name: its
// `bridgeRef` is a bridge's tracking handle, not a transaction on the chain.
function detailCrossChainSend(p: Payment): Pick<HistoryItem, 'crossChainSend' | 'destination'> {
  if (p.paymentType !== PaymentType.Send) {
    return {}
  }
  const details = p.details
  const info = details && 'conversionInfo' in details.inner ? details.inner.conversionInfo : undefined
  if (!info || info.tag === ConversionInfo_Tags.Amm) {
    return {}
  }
  const o = info.inner
  const figure = (value: bigint) => formatBaseUnitsExact(value, o.assetDecimals)
  return {
    destination: o.recipientAddress,
    crossChainSend: {
      chain: o.chain,
      asset: o.asset,
      estimatedOut: figure(o.estimatedOut),
      deliveredAmount: o.deliveredAmount === undefined ? undefined : figure(o.deliveredAmount),
      // A zero is a provider's unset figure as often as a real one, and "0 USDT" would call it free.
      feeAmount: o.feeAmount ? figure(o.feeAmount) : undefined,
      txHash: 'externalTxHash' in o ? o.externalTxHash : undefined,
    },
  }
}

const PROVIDER_NAME: Record<ConversionProvider, string> = {
  [ConversionProvider.Amm]: 'Flashnet',
  [ConversionProvider.Orchestra]: 'Orchestra',
  [ConversionProvider.Boltz]: 'Boltz',
}

// The cross-chain provider wins over the pool that funded the same send, since it is the one that
// delivered it. A conversion to the wallet's own address has only the info, with no step listed.
function detailProvider(p: Payment): string | undefined {
  const details = p.details
  const info = details && 'conversionInfo' in details.inner ? details.inner.conversionInfo : undefined
  if (info?.tag === ConversionInfo_Tags.Orchestra) {
    return PROVIDER_NAME[ConversionProvider.Orchestra]
  }
  if (info?.tag === ConversionInfo_Tags.Boltz) {
    return PROVIDER_NAME[ConversionProvider.Boltz]
  }
  const steps = p.conversionDetails?.conversions ?? []
  const step = steps.find(c => c.provider !== ConversionProvider.Amm) ?? steps[0]
  if (step) {
    return PROVIDER_NAME[step.provider]
  }
  return info ? PROVIDER_NAME[ConversionProvider.Amm] : undefined
}

// A plain LUD-12 comment on a non-zap receive stays hidden by policy, so a value here always means a zap.
function detailZap(p: Payment): { zap?: { comment?: string } } {
  const details = p.details
  if (!details || !('destinationPubkey' in details.inner)) {
    return {}
  }
  const meta = details.inner.lnurlReceiveMetadata
  const { isZap, comment } = parseZap(meta?.nostrZapRequest, meta?.senderComment)
  return isZap ? { zap: { comment } } : {}
}

// The conversion info of one of a conversion's own legs, which is what the SDK itself reads a
// conversion child by (`Payment::is_conversion_child`). A send or a receive that a conversion only
// funded or followed carries none, and neither does a cross-chain arrival.
function ammInfo(p: Payment) {
  const details = p.details
  const info = details && 'conversionInfo' in details.inner ? details.inner.conversionInfo : undefined
  return info?.tag === ConversionInfo_Tags.Amm ? info.inner : undefined
}

// conversionDetails alone cannot tell a self-conversion from a real receive that stable balance then
// converted. The payment is the conversion when its asset is the conversion's destination, not its source.
// Only an AMM step is the wallet swapping its own balance: the SDK also writes a cross-chain arrival
// as a step (the paid asset on another chain in, the Spark asset out), and that is money arriving.
// A conversion to the wallet's own address, which is how Convert runs, carries no conversionDetails:
// its AMM info and purpose sit on the details, and the purpose names it. A refund from the pool has no
// purpose, and it stays a receive. The leg that left is listed only until the SDK links it away, or
// for good when the conversion did not finish, and a conversion is all it is.
function isConversionLeg(p: Payment): boolean {
  const info = ammInfo(p)
  if (info) {
    return p.paymentType === PaymentType.Send || info.purpose !== undefined
  }
  if (p.paymentType !== PaymentType.Receive) {
    return false
  }
  const steps = p.conversionDetails?.conversions.filter(step => step.provider === ConversionProvider.Amm)
  if (!steps || steps.length === 0) {
    return false
  }
  // `identifier` is undefined for sats and the token id otherwise, matching what detailAsset yields.
  const asset = detailAsset(p)?.assetId
  return steps.some(step => step.to.asset.identifier === asset && step.from.asset.identifier !== asset)
}

// The leg the pool sent back carries the AMM info on its own details. A real receive reaches the same
// status only through the step of a child leg, which says nothing about the money it brought in.
function isPoolRefund(p: Payment): boolean {
  return (
    p.paymentType === PaymentType.Receive &&
    !isConversionLeg(p) &&
    ammInfo(p)?.status === ConversionStatus.Refunded
  )
}

function positiveBaseUnits(value: bigint, decimals: number): string | undefined {
  return value > 0n ? formatBaseUnitsExact(value, decimals) : undefined
}

function conversionSide(side: ConversionSide): HistoryConversionSide {
  const { identifier, decimals, ticker } = side.asset
  return {
    ticker: identifier === undefined ? null : ticker,
    assetId: identifier,
    amount: formatBaseUnitsExact(side.amount, decimals),
    fee: positiveBaseUnits(side.fee, decimals),
  }
}

// The AMM fee sits on the token's leg and is in that token's base units, whichever way the conversion
// ran (`FeeSplit` in the SDK), so a sats leg has only its own transfer fee.
function ownSide(p: Payment, feeOnLeg: bigint | undefined): HistoryConversionSide {
  const details = p.details
  if (details?.tag === 'Token' && 'metadata' in details.inner) {
    const { ticker, decimals, identifier } = details.inner.metadata
    return {
      ticker,
      assetId: identifier,
      amount: formatBaseUnitsExact(p.amount, decimals),
      fee: positiveBaseUnits(p.fees + (feeOnLeg ?? 0n), decimals),
    }
  }
  return { ticker: null, amount: formatBaseUnitsExact(p.amount, 0), fee: positiveBaseUnits(p.fees, 0) }
}

function conversionStatusOf(status: ConversionStatus): HistoryConversionStatus {
  switch (status) {
    case ConversionStatus.Completed:
      return 'complete'
    case ConversionStatus.Pending:
      return 'pending'
    case ConversionStatus.RefundNeeded:
      return 'refundPending'
    case ConversionStatus.Refunded:
      return 'refunded'
    default:
      return 'failed'
  }
}

function detailConversion(p: Payment): HistoryConversion | undefined {
  const info = ammInfo(p)
  const conversions = p.conversionDetails?.conversions
  const step = conversions?.find(c => c.provider === ConversionProvider.Amm)
  // An empty list is a receive dollar mode has queued or given up on: the status is all there is yet.
  // A list with no AMM step is a cross-chain payment, whose status is not a conversion of the wallet's.
  const status = step?.status ?? info?.status ?? (conversions?.length === 0 ? p.conversionDetails?.status : undefined)
  if (status === undefined) {
    return undefined
  }
  const conversion: HistoryConversion = {
    status: conversionStatusOf(status),
    automatic: info?.purpose?.tag === ConversionPurpose_Tags.AutoConversion,
  }
  if (step) {
    return { ...conversion, from: conversionSide(step.from), to: conversionSide(step.to) }
  }
  if (!isConversionLeg(p)) {
    return conversion
  }
  const own = ownSide(p, info?.fee)
  if (p.paymentType === PaymentType.Send) {
    return { ...conversion, from: own }
  }
  // The pools pair bitcoin with a token, so a token that arrived was bought with sats, while sats
  // that arrived do not say which token paid for them.
  return own.ticker === null ? { ...conversion, to: own } : { ...conversion, from: { ticker: null }, to: own }
}

// Where the far side of a cross-chain send stands. The SDK tracks it apart from the Spark transfer
// (guide/cross_chain.html, Status lifecycle). The info is on the details from the start, and the step
// exists once the SDK rebuilds conversionDetails from it. conversionDetails.status is not read: on a
// send the dollar wallet funded it is the funding conversion's.
function sendDelivery(p: Payment): HistoryConversionStatus | undefined {
  if (p.paymentType !== PaymentType.Send) {
    return undefined
  }
  const details = p.details
  const info = details && 'conversionInfo' in details.inner ? details.inner.conversionInfo : undefined
  const status =
    info && info.tag !== ConversionInfo_Tags.Amm
      ? info.inner.status
      : p.conversionDetails?.conversions.find(step => step.provider !== ConversionProvider.Amm)?.status
  return status === undefined ? undefined : conversionStatusOf(status)
}

// How long a receive reads as pending for the conversion queued after it. The SDK can leave that
// conversion pending for good (stable_balance/queue.rs, another install converted it; conversions.rs,
// skipped with nothing written), so past this the receive's own status stands, and the detail still
// names the conversion's. Ten times the queue's 120 s, a choice rather than a measure.
export const RECEIVE_CONVERSION_PENDING_MS = 10 * 60 * 1000

function conversionStillRunning(p: Payment, conversion: HistoryConversion | undefined): boolean {
  return (
    p.paymentType === PaymentType.Receive &&
    conversion?.status === 'pending' &&
    Date.now() - Number(p.timestamp) * 1000 < RECEIVE_CONVERSION_PENDING_MS
  )
}

function undelivered(status: HistoryConversionStatus | undefined): boolean {
  return status === 'failed' || status === 'refundPending' || status === 'refunded'
}

// A payment's own status says the transfer settled, and on a conversion's leg that is the part that
// went to the pool. When the conversion then did not deliver, the leg has to read as what it became.
// A cross-chain send is the same on the provider's leg. A receive that a conversion failed after is
// still money in, in sats, so only a conversion in flight holds it back.
function legStatus(
  p: Payment,
  conversion: HistoryConversion | undefined,
  delivery: HistoryConversionStatus | undefined,
): HistoryStatus {
  const own = historyStatus(p.status)
  if (isConversionLeg(p)) {
    return undelivered(conversion?.status) ? 'failed' : own
  }
  if (undelivered(delivery)) {
    return 'failed'
  }
  if (own !== 'complete') {
    return own
  }
  return delivery === 'pending' || conversionStillRunning(p, conversion) ? 'pending' : own
}

function sparkPaymentToHistory(p: Payment): HistoryItem {
  const conversion = detailConversion(p)
  const delivery = sendDelivery(p)
  return {
    id: p.id,
    direction: isConversionLeg(p) ? 'converted' : p.paymentType === PaymentType.Receive ? 'received' : 'sent',
    status: legStatus(p, conversion, delivery),
    amountSat: Number(p.amount),
    feesSat: Number(p.fees),
    timestamp: Number(p.timestamp),
    asset: detailAsset(p),
    method: detailMethod(p),
    ...detailEnrichment(p),
    ...detailZap(p),
    ...detailCrossChain(p),
    ...detailCrossChainSend(p),
    provider: detailProvider(p),
    ...(conversion ? { conversion } : {}),
    ...(isPoolRefund(p) ? { poolRefund: true as const } : {}),
    ...(delivery ? { delivery } : {}),
  }
}

// For a status refetch of one payment, or a notification deep-link that carries only the id.
export async function sparkGetPayment(paymentId: string): Promise<HistoryItem> {
  const walletId = connectedWalletId
  const res = await requireSdk().getPayment({ paymentId })
  const [item] = await withConversionNotes([sparkPaymentToHistory(res.payment)], walletId)
  return item
}

export type HistoryAssetFilter = 'bitcoin' | { tokenIdentifier: string }

function toAssetFilter(filter: HistoryAssetFilter | undefined): AssetFilter | undefined {
  if (filter === undefined) {
    return undefined
  }
  return filter === 'bitcoin'
    ? new AssetFilter.Bitcoin()
    : new AssetFilter.Token({ tokenIdentifier: filter.tokenIdentifier })
}

// Newest-first, since sortAscending is unset. `asset` narrows the query, which matters at a small limit.
export async function sparkListHistory(
  limit = 50,
  asset?: HistoryAssetFilter,
  offset?: number,
): Promise<HistoryItem[]> {
  const walletId = connectedWalletId
  const res = await requireSdk().listPayments({
    typeFilter: undefined,
    statusFilter: undefined,
    assetFilter: toAssetFilter(asset),
    paymentDetailsFilter: undefined,
    fromTimestamp: undefined,
    toTimestamp: undefined,
    offset,
    limit,
    sortAscending: undefined,
  })
  return withConversionNotes(res.payments.map(sparkPaymentToHistory), walletId)
}

export async function sparkSyncWallet(): Promise<void> {
  const connection = requireConnection()
  const answer = await connection.sdk.syncWallet({})
  noteSyncFailure(connection, answer.lastSyncError)
}

async function refreshOnce(connection: Connection): Promise<void> {
  const before = connection.heard
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<void>(resolve => {
    timer = setTimeout(resolve, SYNC_WAIT_MS)
  })
  await new Promise<void>(resolve => {
    const finish = () => resolve()
    connection.onHeard = finish
    limit.then(finish)
    // In a wrapper so a call that throws ends the wait as a rejection does.
    const syncing = async () => connection.sdk.syncWallet({})
    // The answer can land after a Synced ended the wait, and it still speaks for this pull's sync.
    syncing().then(answer => {
      noteSyncFailure(connection, answer.lastSyncError)
      finish()
    }, finish)
  })
  connection.onHeard = null
  // Read here as well as on the event, since the screen reads the state as soon as this ends. The SDK
  // sets a failure before the Synced for the part that worked, and the answer that also carries it
  // lands only after the exit data collection. The same limit holds, and a read past it is no proof.
  const failed =
    connection.heard === before ||
    (await Promise.race([syncReportsFailure(connection), limit.then(() => true)]))
  clearTimeout(timer)
  if (failed) {
    markNotCurrent(connection)
  }
}

let refresh: { connection: Connection; done: Promise<void> } | null = null

// A pull to refresh: resolves at the first of a Synced, syncWallet answering, or SYNC_WAIT_MS, plus one
// read, and the screen reads after it. Only Synced counts as a sync. The SDK resolves Ok over a failed
// wallet sync and reports it in the read and the answer (docs/breez-sdk-binding.md), so a reported
// failure, a read that fails, or a resolve or a rejection with no Synced, leaves the connection
// unsynced, past its wait. It never reconnects and
// never counts as a send, and two pulls share one sync, since a sync costs network each time.
export function sparkRefreshWallet(): Promise<void> {
  const connection = live
  if (!connection) {
    return Promise.resolve()
  }
  if (refresh?.connection === connection) {
    return refresh.done
  }
  const done: Promise<void> = refreshOnce(connection).finally(() => {
    if (refresh?.done === done) {
      refresh = null
    }
  })
  refresh = { connection, done }
  return done
}

// Fires on any SDK event, broad on purpose, favouring correctness over minimal refetches.
export async function sparkSubscribeToPayments(onChange: () => void): Promise<() => void> {
  return sparkAddEventListener(() => onChange())
}

// Only money arriving from someone produces an update. Extracted from the subscriber so it can be
// unit-tested.
export type ReceiveStage = 'incoming' | 'received' | 'failed'
// `sat` is the payment's raw amount, which for a token is its base units, so a token receive also
// carries `asset` and is shown in its own unit.
export type ReceiveUpdate = {
  id: string
  stage: ReceiveStage
  sat: number
  asset?: HistoryAsset
  // The rail the record says the payment came over, absent when it names none.
  rail?: NoticeRail
  zap?: { comment?: string }
}

// A receive the provider brought from another chain ends on a Spark transfer, so the transfer's rail
// is not how it came, and the notice names none.
function withAssetAndRail(p: Payment): { asset?: HistoryAsset; rail?: NoticeRail } {
  const asset = detailAsset(p)
  const rail = detailCrossChain(p).crossChain ? undefined : detailMethod(p)
  return { ...(asset ? { asset } : {}), ...(rail ? { rail } : {}) }
}

// The pool's delivery of a conversion starts its claim before the swap's answer lets the SDK write
// the conversion's info on it, so its pending event is a bare transfer like any other, and the success
// that would take an announcement down never comes, since the SDK holds back a conversion child's
// events by then. Its success can land bare too, so sparkSubscribeToReceives reads it again before
// announcing. Only a transfer with nothing else on it can be that delivery.
function mayBeConversionDelivery(p: Payment): boolean {
  const details = p.details
  if (details?.tag !== 'Spark' && details?.tag !== 'Token') {
    return false
  }
  const { invoiceDetails, conversionInfo } = details.inner
  const htlc = 'htlcDetails' in details.inner ? details.inner.htlcDetails : undefined
  return invoiceDetails === undefined && conversionInfo === undefined && htlc === undefined
}

function receivedUpdate(p: Payment): ReceiveUpdate {
  return { id: p.id, stage: 'received', sat: Number(p.amount), ...withAssetAndRail(p), ...detailZap(p) }
}

export function receiveUpdateFromEvent(event: SdkEvent): ReceiveUpdate | null {
  if (event.tag === SdkEvent_Tags.PaymentSucceeded && event.inner.payment.paymentType === PaymentType.Receive) {
    const p = event.inner.payment
    return isConversionLeg(p) ? null : receivedUpdate(p)
  }
  if (event.tag === SdkEvent_Tags.PaymentPending && event.inner.payment.paymentType === PaymentType.Receive) {
    const p = event.inner.payment
    return isConversionLeg(p) || mayBeConversionDelivery(p)
      ? null
      : { id: p.id, stage: 'incoming', sat: Number(p.amount), ...withAssetAndRail(p) }
  }
  if (event.tag === SdkEvent_Tags.PaymentFailed && event.inner.payment.paymentType === PaymentType.Receive) {
    const p = event.inner.payment
    return isConversionLeg(p) ? null : { id: p.id, stage: 'failed', sat: Number(p.amount) }
  }
  return null
}

// How long a bare transfer that settled waits before it is announced. The pool's delivery can settle
// before the swap's answer lets the SDK write the conversion's info on it, or on another install before
// real-time sync brings that info, and an overlay once up cannot be taken back. The swap's answer is
// expected right after the pool sends the delivery, and this figure is a judgement rather than a
// measured bound: an answer later than it announces the delivery as a payment, and a bare transfer from
// someone is announced that much later.
export const CONVERSION_INFO_WAIT_MS = 3_000

// Enough to hold a burst of payments, and bounded since a subscription lives as long as its connection.
const ANNOUNCED_MEMORY = 64

// Whether this event is the first this subscription saw of the payment.
function firstSighting(seen: Set<string>, id: string): boolean {
  if (seen.has(id)) {
    return false
  }
  seen.add(id)
  if (seen.size > ANNOUNCED_MEMORY) {
    seen.delete(seen.values().next().value as string)
  }
  return true
}

// A bare receive reaches the screen only after a second read of the payment, on the connection it
// arrived on. A move of the active wallet during the wait leaves that connection up until Home
// reconnects, so the registry is asked too, and a registry that cannot be read announces nothing,
// since History holds the record either way.
function announceAfterRecheck(
  connection: Connection,
  walletId: string | null,
  payment: Payment,
  stopped: () => boolean,
  onUpdate: (update: ReceiveUpdate) => void,
): void {
  const here = () => !stopped() && live === connection
  const check = async () => {
    if (!here()) {
      return
    }
    // A read that fails announces what the event said: a real receive with no notice is the worse
    // of the two, and History holds the record.
    const current = await connection.sdk
      .getPayment({ paymentId: payment.id })
      .then(res => res.payment)
      .catch(() => payment)
    const active = await getActiveWalletId()
    if (!isConversionLeg(current) && here() && (active ?? PRIMARY_ID) === walletId) {
      onUpdate(receivedUpdate(current))
    }
  }
  check().catch(() => undefined)
}

export async function sparkSubscribeToReceives(
  onUpdate: (update: ReceiveUpdate) => void,
): Promise<() => void> {
  const connection = requireConnection()
  const walletId = connectedWalletId
  const seen = new Set<string>()
  const waits = new Set<ReturnType<typeof setTimeout>>()
  let stopped = false
  const off = await sparkAddEventListener(event => {
    const update = receiveUpdateFromEvent(event)
    if (update === null) {
      return
    }
    if (event.tag !== SdkEvent_Tags.PaymentSucceeded) {
      onUpdate(update)
      return
    }
    const payment = event.inner.payment
    if (!firstSighting(seen, payment.id)) {
      return
    }
    if (!mayBeConversionDelivery(payment)) {
      onUpdate(update)
      return
    }
    const wait = setTimeout(() => {
      waits.delete(wait)
      announceAfterRecheck(connection, walletId, payment, () => stopped, onUpdate)
    }, CONVERSION_INFO_WAIT_MS)
    waits.add(wait)
  })
  return () => {
    stopped = true
    waits.forEach(clearTimeout)
    waits.clear()
    off()
  }
}

// Moonpay handles KYC and fiat collection and delivers BTC straight to the wallet, so no fiat or BTC
// passes through Voltz and no spread is taken (condition #3). Unset delivery is bitcoin with no amount.
// MoonpayDelivery.CrossChain buys USDC on Solana instead, which adds a provider to the leg.
// The SDK hands Moonpay the wallet's static deposit address (buy.rs in SDK 0.28.0), so a purchase is a
// receive and waits out an exit as every other receive does.
export async function sparkBuyBitcoinUrl(amountSat?: number): Promise<string> {
  const res = await (await receiverFreeOfExit()).buyBitcoin(
    new BuyBitcoinRequest.Moonpay({
      delivery: amountSat === undefined ? undefined : new MoonpayDelivery.Bitcoin({ amountSat: BigInt(amountSat) }),
      redirectUrl: undefined,
    }),
  )
  return res.url
}

// Non-custodial, as the server holds only a username -> node map and the device mints each invoice.
export type SparkLnAddress = {
  username: string
  /** The full user@domain address. The SDK owns the domain and only the username is chosen. */
  address: string
  /** The bech32 LNURL for the QR, so a scanner that cannot resolve LUD-16 still pays. */
  lnurl: string
}

function toLnAddress(info: LightningAddressInfo): SparkLnAddress {
  return { username: info.username, address: info.lightningAddress, lnurl: info.lnurl.bech32 }
}

// Read for a screen to show or to compare, so a held wallet's address is not read at all.
export async function sparkGetLnAddress(): Promise<SparkLnAddress | null> {
  const connection = requireConnection()
  await addressFreeOfExit(connection.walletId)
  const info = await connection.sdk.getLightningAddress()
  return info ? toLnAddress(info) : null
}

// Every register and claim names the description, since from 0.28 the SDK sends none without it and
// signs an empty field, which the deployed gateway and LNURL server refuse with 401. A connection
// with no domain has no LNURL server, and the SDK refuses before any request.
function addressDescription(connection: Connection, username: string): string {
  return defaultAddressDescription(username, connection.addressDomain ?? '')
}

// Whether an address answers on the domain the wallet is configured for. No configured domain means
// the SDK default is in use and whatever it handed back is right.
export function addressServesDomain(address: string, domain: string | undefined): boolean {
  return !domain || address.toLowerCase().endsWith(`@${domain.toLowerCase()}`)
}

export function usernameOf(address: string): string {
  return address.split('@')[0] ?? ''
}

// Every change of this device's address waits its turn: the customer's register, the transfer
// claim, the delete and each automatic register. A wallet holds one address and registering is
// replacing, so two of them interleaved could leave a generated name over the one just chosen.
let addressTurn: Promise<unknown> = Promise.resolve()

// How long an automatic work may keep starting calls once its turn began. Each LNURL server call
// ends only at the SDK's own 60 s timeout (platform-utils REQUEST_TIMEOUT at 0.27.2), and the mint
// loop makes up to 15 of them, so a server that stops answering would otherwise hold the customer's
// own register behind it for minutes. Past it the work ends with nothing, as when the memory moved;
// a call already in flight is never abandoned, so the next work starts only after it settles and
// two registers never interleave. The customer's register is a single call and is never cut.
export const ADDRESS_TURN_LIMIT_MS = 30_000

// When the work that holds the turn stops starting calls.
type TurnClock = { endsAt: number }

function inAddressTurn<T>(work: (clock: TurnClock) => Promise<T>): Promise<T> {
  addressWorks += 1
  const run = addressTurn.then(() => work({ endsAt: Date.now() + ADDRESS_TURN_LIMIT_MS }))
  addressTurn = run.catch(() => undefined)
  // Settled before the caller resumes, since it is the first reaction on `run`.
  const settled = (): void => {
    addressWorks -= 1
  }
  run.then(settled, settled)
  return run
}

// Read before each SDK call of an automatic work. A cut ends the whole ensure, so a cut claim never
// falls through to a mint that would start the same wait over.
function overdue(scope: EnsureScope, clock: TurnClock): boolean {
  if (Date.now() < clock.endsAt) {
    return false
  }
  scope.cut = true
  return true
}

// The same turn, for a deletion request: its mark is written inside it, so an automatic register
// queued behind the request finds the mark and stops, and one queued ahead of it finishes first.
export function sparkInAddressTurn<T>(work: () => Promise<T>): Promise<T> {
  return inAddressTurn(work)
}

// A wallet that asked for its data to be deleted, or gave its address up, gets no address made for
// it until it asks for one again (deletionMark.ts). Looked up by the wallet's id and by its key, as
// every other stop looks it up, so a seed marked here under another id is held the same way.
async function heldOn(connection: Connection, walletId: string): Promise<boolean> {
  const pubkey = connection.identity ?? (await identityOf(connection).catch(() => null))
  return deletionHolds({ walletId, pubkey })
}

async function heldByDeletion(scope: EnsureScope): Promise<boolean> {
  return heldOn(scope.connection, scope.walletId)
}

// The gateway refuses a key whose data was deleted with `deleted`. Passed up rather than read as a
// name that failed, so the screen can read the wallet's status instead of showing no address and no
// reason (deletion.ts, ensureLnAddressOrAdopt), and noted, so the status is read even when no screen
// asked (deletionMark.ts, noteGatewayDeleted).
function rethrowDeleted(err: unknown, connection: Connection): void {
  if (gatewayRefusal(err) === 'deleted') {
    noteGatewayDeleted({ pubkey: connection.identity })
    throw err
  }
}

// The same notice for a call the customer made, whose refusal the screen reads as it comes.
function noteIfDeleted(err: unknown, connection: Connection): void {
  if (gatewayRefusal(err) === 'deleted') {
    noteGatewayDeleted({ pubkey: connection.identity })
  }
}

// What one ensure is bound to, taken when it starts. The memory it reads and writes is the
// connected wallet's, and a switch of either the connection or the active wallet while it runs ends
// it before anything else is registered or written.
type EnsureScope = {
  connection: Connection
  walletId: string
  activeAtStart: string | null
  domain: string | undefined
  // The address memory as the ensure found it.
  held: string | null
  // Set when a work of this ensure reached ADDRESS_TURN_LIMIT_MS, which ends the ensure with nothing.
  cut: boolean
}

async function switchedFrom(scope: EnsureScope): Promise<boolean> {
  return live !== scope.connection || (await getActiveWalletId()) !== scope.activeAtStart
}

// Read inside the turn, before an automatic register. A delete forgets the name before it gives the
// address up, so a register queued behind that delete finds the memory changed and stops rather
// than undo it.
async function memoryMoved(scope: EnsureScope): Promise<boolean> {
  return (await lastLnAddress(scope.walletId)) !== scope.held
}

// Claims one name as an automatic step, or answers null if it is unavailable or refused. Shared by
// the claim back, the first name and the move to a new domain, so all three take the same path.
//
// The address is read again inside the turn: a name the customer chose while this waited is the one
// kept, and is what this answers, so this path never replaces it. With `remember`, the answer is
// noted inside the same turn, so a register or a delete queued behind it is never noted over.
function claimInTurn(
  scope: EnsureScope,
  username: string,
  remember: boolean,
): Promise<SparkLnAddress | null> {
  return inAddressTurn(async clock => {
    const claimed = await claim(scope, username, clock)
    if (claimed && remember) {
      await rememberFor(scope, claimed)
    }
    return claimed
  })
}

// claimInTurn's work, which runs only inside the turn.
async function claim(scope: EnsureScope, username: string, clock: TurnClock): Promise<SparkLnAddress | null> {
  const client = scope.connection.sdk
  const now = await client.getLightningAddress()
  if (now && addressServesDomain(now.lightningAddress, scope.domain)) {
    return toLnAddress(now)
  }
  if (!username || (await memoryMoved(scope)) || (await heldByDeletion(scope))) {
    return null
  }
  if (overdue(scope, clock)) {
    return null
  }
  if (!(await client.checkLightningAddressAvailable({ username }))) {
    return null
  }
  if ((await switchedFrom(scope)) || overdue(scope, clock)) {
    return null
  }
  try {
    return toLnAddress(
      await client.registerLightningAddress({
        username,
        description: addressDescription(scope.connection, username),
      }),
    )
  } catch (err) {
    rethrowDeleted(err, scope.connection)
    return null
  }
}

// Notes the address against the wallet the ensure started on, unless the wallet changed meanwhile.
async function rememberFor(scope: EnsureScope, address: SparkLnAddress): Promise<void> {
  if (!(await switchedFrom(scope)) && !(await heldByDeletion(scope))) {
    await rememberLnAddress(address.address, scope.walletId)
  }
}

// The generated-name loop, for a wallet with no name to go back to. `avoid` is a name this path
// must not register, which only matters for the one a refund took back.
function mintInTurn(scope: EnsureScope, avoid?: string): Promise<SparkLnAddress | null> {
  const client = scope.connection.sdk
  return inAddressTurn(async clock => {
    const now = await client.getLightningAddress()
    if (now && addressServesDomain(now.lightningAddress, scope.domain)) {
      return toLnAddress(now)
    }
    if ((await memoryMoved(scope)) || (await heldByDeletion(scope))) {
      return null
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const username = randomUsername()
      if (username === avoid) {
        continue
      }
      if (overdue(scope, clock)) {
        return null
      }
      if (!(await client.checkLightningAddressAvailable({ username }))) {
        // Five refusals in a row is not collision: the generator has ~92k combinations. It means the
        // domain is turning this wallet away, and the wallet ends up with no address and no reason.
        console.warn('lightning address unavailable:', username)
        continue
      }
      if ((await switchedFrom(scope)) || overdue(scope, clock)) {
        return null
      }
      try {
        // A register that answers past the limit landed, so it is noted and handed back like any other.
        const minted = toLnAddress(
          await client.registerLightningAddress({
            username,
            description: addressDescription(scope.connection, username),
          }),
        )
        await rememberFor(scope, minted)
        return minted
      } catch (err) {
        rethrowDeleted(err, scope.connection)
        if (overdue(scope, clock)) {
          return null
        }
        // The name can be taken between check and register, so take an address if one exists by now.
        const taken = await client.getLightningAddress()
        if (taken) {
          return toLnAddress(taken)
        }
        // A wallet with no address cannot be paid at all, and swallowing the reason leaves the screen
        // blank with nothing to go on. The refusal is the gateway's, so it names what to fix.
        console.warn('lightning address refused:', username, (err as Error)?.message ?? err)
      }
    }
    return null
  })
}

// Asks the gateway what became of the remembered name, or answers null for no answer. Signed on
// the connection the ensure started on, as that wallet's identity; a switch makes the signature
// refuse, which is no answer too.
//
// Each ask spends one of the gateway's ten costly requests a minute, a window kept per caller IP and
// shared with quotes and store orders, so a wallet in this state that opens address screens in a
// row can leave a purchase refused with 429 until the minute turns. A 429 here is no answer.
async function askNameState(scope: EnsureScope, held: string): Promise<NameState | null> {
  const host = held.split('@')[1]?.toLowerCase()
  // Only a name remembered on the domain in use is asked about. A name on another domain says
  // nothing about which first name this domain keeps for the wallet.
  if (!scope.domain || !host || !addressServesDomain(held, scope.domain)) {
    return null
  }
  try {
    const pubkey = scope.connection.identity ?? (await identityOf(scope.connection))
    return await readNameState(
      { pubkey, sign: message => sparkSignMessage(message, pubkey) },
      host,
      usernameOf(held),
    )
  } catch {
    return null
  }
}

// An empty read for a wallet that remembers a name. Without an answer from the gateway the name is
// claimed back, which succeeds once the domain serves again and answers null meanwhile. A name the
// gateway says a refund took back, with nothing live for the wallet, is the one case that moves on,
// to the wallet's first name (free and its own) or, with none, a generated one.
async function restoreHeld(scope: EnsureScope, held: string): Promise<SparkLnAddress | null> {
  const name = usernameOf(held)
  const step = nextStep(await askNameState(scope, held), name)
  switch (step.kind) {
    case 'claimHeld':
      return claimInTurn(scope, name, false)
    case 'registerGiven':
      return claimInTurn(scope, step.username, true)
    case 'mint':
      return mintInTurn(scope, name)
    case 'stop':
      if (step.warn) {
        console.warn('lightning address not restored:', step.warn)
      }
      return null
  }
}

// Asks the gateway about the wallet's key alone on the domain in use, or answers null for no answer.
// Signed and bounded as askNameState, and asked once per ensure.
async function askKeyState(scope: EnsureScope): Promise<NameState | null> {
  if (!scope.domain) {
    return null
  }
  try {
    const pubkey = scope.connection.identity ?? (await identityOf(scope.connection))
    return await readKeyState(
      { pubkey, sign: message => sparkSignMessage(message, pubkey) },
      scope.domain.toLowerCase(),
    )
  } catch {
    return null
  }
}

// An empty read for a wallet that remembers no name: a restore, on Android always, or a wallet whose
// memory a transfer or a removal of its address cleared. The payment guard makes only a wallet's first
// name free once it has one, so minting first would be refused for every generated name and leave the
// wallet with no address on every open. The gateway is asked first; without an answer the wallet
// mints as before.
async function startWithoutMemory(scope: EnsureScope): Promise<SparkLnAddress | null> {
  const step = keyStep(await askKeyState(scope))
  switch (step.kind) {
    case 'mint':
      return mintInTurn(scope)
    case 'registerGiven':
      return claimInTurn(scope, step.username, true)
    case 'noteLive':
      // The address exists and is not touched. It is remembered, so an empty read later, with the
      // gateway not answering, claims it back rather than minting over it.
      await inAddressTurn(() => noteUnlessMoved(scope, `${step.username}@${scope.domain!.toLowerCase()}`))
      return null
    case 'stop':
      console.warn('lightning address not started:', step.warn)
      return null
  }
}

// Notes an address the ensure did not register, unless the memory, the wallet or its deletion state
// moved while it waited: a name the customer chose meanwhile is the one kept.
async function noteUnlessMoved(scope: EnsureScope, address: string): Promise<void> {
  if (await memoryMoved(scope)) {
    return
  }
  if (!(await switchedFrom(scope)) && !(await heldByDeletion(scope))) {
    await rememberLnAddress(address, scope.walletId)
  }
}

async function ensureLnAddress(scope: EnsureScope): Promise<SparkLnAddress | null> {
  const client = scope.connection.sdk
  const existing = await client.getLightningAddress()
  if (existing && addressServesDomain(existing.lightningAddress, scope.domain)) {
    const address = toLnAddress(existing)
    // Noted in the turn, as claim and mint note theirs: a delete holding it forgets the name before it
    // writes its mark, and a note landing between the two would put the deleted name back.
    await inAddressTurn(() => rememberFor(scope, address))
    return address
  }
  // An address left over from another domain is dead: a payer resolving it asks a host that has no
  // record of the name. The cached copy still reads fine on screen, which is what makes it worse
  // than having none, so the same name is claimed on the domain in use before falling back.
  if (existing) {
    const kept = await claimInTurn(scope, usernameOf(existing.lightningAddress), true)
    if (kept || scope.cut) {
      return kept
    }
  }
  // A wallet that has had an address does not get a new one made for it. The read above comes back
  // empty while the domain is off the edge, and minting then replaces the name the customer chose
  // with a generated one, permanently: a wallet holds one address, so registering is replacing.
  // Opening the receive screen while the domain is frozen would be enough to lose a chosen name that
  // way, with nothing anywhere recording that it happened.
  if (!existing && scope.held) {
    return restoreHeld(scope, scope.held)
  }
  if (!existing) {
    return startWithoutMemory(scope)
  }
  return mintInTurn(scope)
}

// One ensure per connection at a time. Every screen that shows an address asks on mount, and two of
// them racing would each decide to register. Keyed by the connection rather than the wallet id: an
// ensure bound to a connection that was replaced ends with nothing, and a screen asking on the
// wallet's new connection would otherwise be handed that ending.
const ensuring = new Map<Connection, Promise<SparkLnAddress | null>>()

// The SDK does not assign an address on connect, so without this call the receive screen has none to
// show. Idempotent, since a later call returns the existing address.
export async function sparkEnsureLnAddress(): Promise<SparkLnAddress | null> {
  const connection = requireConnection()
  const walletId = connectedWalletId
  if (walletId === null) {
    throw new Error('spark not connected')
  }
  const running = ensuring.get(connection)
  if (running) {
    return running
  }
  const domain = lnurlDomainInUse
  const run = (async () => {
    // The address is not even read, since the screen shows the deletion's state instead, and an address the
    // SDK still reads during a pending deletion is not one to hand to a payer.
    if (await heldOn(connection, walletId)) {
      return null
    }
    // Every register this ensure can make runs inside it (ensureLnAddress), so the one check covers them.
    await addressFreeOfExit(walletId)
    const activeAtStart = await getActiveWalletId()
    const held = await lastLnAddress(walletId)
    return ensureLnAddress({ connection, walletId, activeAtStart, domain, held, cut: false })
  })().finally(() => {
    ensuring.delete(connection)
  })
  ensuring.set(connection, run)
  return run
}

export async function sparkCheckLnAddress(username: string): Promise<boolean> {
  return requireSdk().checkLightningAddressAvailable({ username })
}

// The address is minted from the device's own key, so custody stays on the device (condition #1).
//
// A register for one wallet, a name paid for as that wallet or taken free on its sheet, names it
// (`paidBy`) and goes only on that wallet's connection, by the take's rule (sparkTakeLnAddress). Read
// right before the register, a live connection that is another wallet's registers nothing and answers
// null, and a paid proof stays with the wallet that paid. So does any register whose connection a
// reconnect replaced while it waited for its turn, paid or not, since the instance it would run on is
// the one dropped.
export async function sparkRegisterLnAddress(
  username: string,
  description?: string,
  paidBy?: string,
): Promise<SparkLnAddress | null> {
  const connection = requireConnection()
  const client = connection.sdk
  const walletId = connectedWalletId ?? undefined
  return inAddressTurn(async () => {
    if (walletId && (await heldOn(connection, walletId))) {
      throw deletedError()
    }
    await addressFreeOfExit(connection.walletId)
    if (live !== connection || (paidBy !== undefined && walletId !== paidBy)) {
      return null
    }
    let info: LightningAddressInfo
    try {
      info = await client.registerLightningAddress({
        username,
        description: description ?? addressDescription(connection, username),
      })
    } catch (err) {
      noteIfDeleted(err, connection)
      throw err
    }
    const address = toLnAddress(info)
    // Remembered here too, and this is the path that matters most: it is the one the customer
    // chooses. Without it the memory keeps whatever was seen last, and an empty read months later
    // would claim back a name they had already replaced.
    await rememberLnAddress(address.address, walletId)
    return address
  })
}

// Puts a paid name on the wallet only while it answers on no address at all (recover.ts, takeName).
// The address is read and the name registered in one turn of the address queue, so two takers of one
// name, the sheet and the sweep, register it once, and a register that lands between a read and a
// register made in two turns is never replaced. `unread` is an address that could not be read, which
// is not an address that is absent; a register the server refuses rejects.
//
// A taker that paid as one wallet names it (`walletId`), and the name goes only on that wallet's
// connection. A switch while the take waits for its turn, or while it reads, leaves the live connection
// on another wallet, whose key would register the name; `elsewhere` then says nothing was read or
// registered, and the proof stays with the wallet that paid.
export type LnAddressTake =
  | { held: SparkLnAddress }
  | { unread: true }
  | { registered: SparkLnAddress }
  | { elsewhere: true }

export function sparkTakeLnAddress(username: string, walletId?: string): Promise<LnAddressTake> {
  return inAddressTurn(async (): Promise<LnAddressTake> => {
    if (walletId !== undefined && connectedWalletId !== walletId) {
      return { elsewhere: true }
    }
    let connection: Connection
    let info: LightningAddressInfo | undefined | null
    try {
      connection = requireConnection()
    } catch {
      return { unread: true }
    }
    // Before the read, so a held wallet asks the SDK nothing; the sweep then waits (recover.ts, takeName).
    await addressFreeOfExit(connection.walletId)
    try {
      info = await connection.sdk.getLightningAddress()
    } catch {
      return { unread: true }
    }
    if (info) {
      return { held: toLnAddress(info) }
    }
    const owner = walletId ?? connectedWalletId ?? undefined
    if (owner && (await heldOn(connection, owner))) {
      throw deletedError()
    }
    // Read again right before the register, since the reads above let a reconnect land.
    if (walletId !== undefined && live !== connection) {
      return { elsewhere: true }
    }
    let registered: LightningAddressInfo
    try {
      registered = await connection.sdk.registerLightningAddress({
        username,
        description: addressDescription(connection, username),
      })
    } catch (err) {
      noteIfDeleted(err, connection)
      throw err
    }
    const address = toLnAddress(registered)
    // Remembered as the customer's own register is, so an empty read later claims this name back.
    await rememberLnAddress(address.address, owner)
    return { registered: address }
  })
}

// Gives the address up. The server keeps the name reserved for this wallet rather than freeing it:
// another wallet claiming it right after gets 409 "name is reserved".
// So this is for a wallet that wants to stop being reachable, never a way to move a name.
//
// Marked as removed before it is given up, with the same mark a deletion request writes, so the next
// screen open does not mint a generated name in its place. Only "create the address again" takes
// the mark away (deletion.ts, returnFromDeletion).
export async function sparkDeleteLnAddress(): Promise<void> {
  const connection = requireConnection()
  const client = connection.sdk
  const walletId = connectedWalletId ?? (await getActiveWalletId()) ?? ''
  await inAddressTurn(async () => {
    const pubkey = connection.identity ?? (await identityOf(connection))
    // Read before anything changes. A wallet whose deletion state is not known (marks that do not
    // read, or a rebuild still waiting on the gateway's answer for it) keeps its address and its
    // memory: a 'removed' written over that state would end the read-back that settles it, and an
    // address given up with no mark would be minted again once the marks read. The read-back the
    // home screen runs answers it, and the removal can then go ahead.
    const found = await findDeletionMark({ walletId, pubkey })
    if (found?.unknown) {
      throw new Error('deletion state not known yet')
    }
    // Recorded before anything is forgotten or given up, so every refusal of the write comes first.
    // Looked up again in the write's own turn, since a status read, the wallet's removal or a return
    // from the deletion (only while the wallet is held, when Remove is not offered) can write between
    // the read above and it; a request cannot, as it runs in this same turn (deletion.ts,
    // liveDeletionDeps). A request's mark gains the removal rather than being replaced, so a request
    // the gateway never recorded leaves the wallet removed rather than free to mint a name.
    const removed: DeletionMark = { pubkey, state: 'removed', askedAt: Math.floor(Date.now() / 1000) }
    const wrote = await markAddressRemoved(walletId, removed)
    try {
      await client.deleteLightningAddress()
    } catch (err) {
      // The address is still there, so the wallet is left as it was, its name remembered, rather than
      // held without one. Only what the removal wrote is taken back; a mark written meanwhile stays.
      if (wrote) {
        await unmarkAddressRemoved(walletId, removed).catch(() => undefined)
      }
      throw err
    }
    // Forgotten once the address is gone. The mark above holds every automatic register, so the name
    // is not claimed back in its place, and a removal that never went through keeps it.
    await forgetLnAddress(walletId)
  })
}

// A name a refund took back stays in the SDK's address cache after the gateway froze it: the SDK reads
// the server for its address only at connect, or when the cache is empty, so Receive keeps showing a
// dead name until the next cold start or wallet switch. The purchase sweep calls this with the annulled
// credits the gateway lists for this wallet, and the cached name is asked about when one of them is on
// its domain. Only when the gateway says the name was taken back from this wallet and is not live is the
// SDK dropped and connected again, once per wallet and name for the life of the process, so the
// connect's own recovery empties the cache and the next ensure goes to the wallet's first name.
//
// Answers whether it reconnected. Rejects with SparkReconnectBusy when a send, a prepare or an address
// change in flight skipped the reconnect, which is then still owed and left for the next sweep, and
// otherwise only when the reconnect itself fails.
const refreshedAfterRefund = new Set<string>()
// What the gateway answered about each wallet and name this process asked about: whether it was taken
// back, and the annulled credits on its domain when it was asked. No answer is not kept, so the next
// sweep asks again.
const answeredAfterRefund = new Map<string, { takenBack: boolean; credits: readonly string[] }>()

// A credit the gateway lists as annulled, by its id and the domain it was bought on.
export type AnnulledCredit = { id: string; domain: string }

export async function sparkRefreshTakenBackAddress(
  walletId: string,
  annulled: readonly AnnulledCredit[],
): Promise<boolean> {
  const connection = live
  if (!connection || connectedWalletId !== walletId) {
    return false
  }
  const cached = await connection.sdk.getLightningAddress().catch(() => undefined)
  const host = cached?.lightningAddress.split('@')[1]?.toLowerCase()
  const credits = annulled.filter(credit => credit.domain.toLowerCase() === host).map(credit => credit.id)
  if (!cached || !host || credits.length === 0) {
    return false
  }
  const name = usernameOf(cached.lightningAddress)
  const key = `${walletId}\n${name}@${host}`
  if (refreshedAfterRefund.has(key)) {
    return false
  }
  if (!(await takenBackFrom(connection, walletId, cached.lightningAddress, key, credits))) {
    return false
  }
  // Decided in the address turn, so a register in flight on this connection finishes first and the
  // address is read again after it, since a register or a switch can land while the gateway answers.
  // Done after the turn, which is never held across a Keychain read, PBKDF2 and a native connect: an
  // address change asked for meanwhile skips the reconnect (busy), and one queued before the drop and
  // run after it finds its connection replaced and registers nothing.
  const decided = await inAddressTurn(async () => {
    if (live !== connection || refreshedAfterRefund.has(key)) {
      return false
    }
    const now = await connection.sdk.getLightningAddress().catch(() => undefined)
    return now?.lightningAddress.toLowerCase() === cached.lightningAddress.toLowerCase()
  })
  if (!decided) {
    return false
  }
  // Noted once the drop is decided, so a reconnect that fails is not tried again on the next sweep,
  // and one skipped for a send or an address change in flight (SparkReconnectBusy) is.
  return reconnectWallet(connection, walletId, () => refreshedAfterRefund.add(key))
}

// Whether the gateway says `address` was taken back from the wallet and is not live. An annulled credit
// stays listed, so every due sweep passes it again, and each question costs the gateway up to three
// holder calls: a name is asked about once per process, and the wallet's remembered address not at all
// once an answer said it was not taken back, which the address memory keeps across restarts
// (noteNotTakenBack). An answer that it was not, kept in the process or in the memory, covers only the
// annulled `credits` on its domain it was asked with: a later refund of the same name annuls another
// credit, which asks once more.
async function takenBackFrom(
  connection: Connection,
  walletId: string,
  address: string,
  key: string,
  credits: readonly string[],
): Promise<boolean> {
  const known = answeredAfterRefund.get(key)
  if (known !== undefined && (known.takenBack || credits.every(id => known.credits.includes(id)))) {
    return known.takenBack
  }
  const remembered = await lastLnAddress(walletId)
  if (
    remembered?.toLowerCase() === address.toLowerCase() &&
    (await notTakenBack(walletId, credits)) !== null
  ) {
    answeredAfterRefund.set(key, { takenBack: false, credits })
    return false
  }
  const name = usernameOf(address)
  const state = await (async () => {
    const pubkey = connection.identity ?? (await identityOf(connection))
    return readNameState(
      { pubkey, sign: message => sparkSignMessage(message, pubkey) },
      address.split('@')[1]?.toLowerCase() ?? '',
      name,
    )
  })().catch(() => null)
  if (state === null) {
    return false
  }
  const takenBack = state.takenBack !== null && state.live !== name
  answeredAfterRefund.set(key, { takenBack, credits })
  if (!takenBack) {
    await noteNotTakenBack(address, walletId, credits)
  }
  return takenBack
}

// Drops the live connection and connects the same wallet again, only while it is still the active
// wallet, `connection` is still the live one and nothing is in flight on it; `onDrop` runs once the drop
// is decided. It yields to every other connect request: a switch pending when it asks runs first and
// replaces `connection`, so this one is skipped, and a request for another wallet that comes after it
// cuts it, which skips it too. Such a skip owes nothing, since the wallet's next connect reads its
// address afresh. One for something in flight (busy) leaves the stale cache live, and rejects with
// SparkReconnectBusy instead.
async function reconnectWallet(
  connection: Connection,
  walletId: string,
  onDrop: () => void,
): Promise<boolean> {
  if ((await activeWalletId()) !== walletId) {
    return false
  }
  try {
    return await inConnectTurn(
      ACTIVE,
      walletId,
      async turn => {
        turn.walletId = await untilCut(turn, activeWalletId())
        if (turn.walletId !== walletId || live !== connection) {
          return false
        }
        if (busy()) {
          throw new SparkReconnectBusy()
        }
        onDrop()
        await untilCut(turn, dropLive())
        stopIfCut(turn)
        await connectInTurn(turn, () => loadSeedFor(turn.walletId))
        return true
      },
      true,
    )
  } catch (err) {
    if (err instanceof SparkConnectSuperseded) {
      return false
    }
    throw err
  }
}

// Moving a name between two wallets of the same person. Both halves are needed because the server
// wants a signature from each side, and it is the only path that works: releasing the name and
// claiming it from the other wallet fails, since a released name stays reserved for the wallet that
// released it.
export async function sparkAuthorizeLnAddressTransfer(
  transfereePubkey: string,
): Promise<TransferAuthorization> {
  return requireSdk().authorizeLightningAddressTransfer({ transfereePubkey })
}

// `fromWalletId` is the wallet the name moves from. Once the claim lands, in the same turn, the name
// is remembered for the wallet that now holds it and forgotten for the one that gave it, which holds
// no address then, and whose memory of the name would have it claim back, on every open, a name that
// pays the other wallet. A claim that fails changes neither memory.
export async function sparkClaimLnAddressTransfer(
  authorization: TransferAuthorization,
  fromWalletId?: string,
): Promise<SparkLnAddress> {
  const connection = requireConnection()
  const client = connection.sdk
  // The description is written anew for the new owner, which names the address rather than carrying
  // over whatever the previous wallet had set.
  const walletId = connectedWalletId
  return inAddressTurn(async () => {
    if (walletId && (await heldOn(connection, walletId))) {
      throw deletedError()
    }
    await addressFreeOfExit(connection.walletId)
    // Read right before the claim, as the register reads it: a connection a reconnect replaced while
    // this waited for its turn is the instance dropped, so the claim fails rather than run on it.
    if (live !== connection) {
      throw new Error('spark connection replaced before the claim')
    }
    let address: SparkLnAddress
    try {
      address = toLnAddress(
        await client.claimLightningAddressTransfer({
          authorization,
          description: addressDescription(connection, authorization.username),
        }),
      )
    } catch (err) {
      noteIfDeleted(err, connection)
      throw err
    }
    await rememberLnAddress(address.address, walletId ?? undefined)
    if (fromWalletId !== undefined && fromWalletId !== walletId) {
      await forgetLnAddress(fromWalletId)
    }
    return address
  })
}
