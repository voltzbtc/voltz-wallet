import { answerWithin } from './answerWithin'
import { broadcastPackage, broadcastTx, readFunding, type Broadcast, type ChainUtxo } from './chainRelay'
import { emergencyExitLive } from './emergencyExit'
import { exitFeeAddress, withExitFeeSecret } from './exitFeeKey'
import {
  isLivePlan,
  loadExitPlan,
  saveExitPlan,
  type ExitClosure,
  type ExitFeeKey,
  type ExitPlan,
  type ExitSelection,
} from './exitPlan'
import {
  arrivingSat,
  childFits,
  fundingCoins,
  fundingNeededSat,
  MAX_FUNDING_COINS,
  mayGoOn,
  paysAboveRelay,
  quoteIsOld,
  quoteVerdict,
  type QuoteVerdict,
} from './exitQuote'
import { loadPassphraseFor, loadSeedFor } from './seed'
import {
  sparkCheckRecoverFunds,
  sparkConnectedWalletId,
  sparkExitFeeRate,
  sparkLeafUnverified,
  sparkMissingFunding,
  sparkPrepareRecoverFunds,
  sparkQuoteReadChain,
  sparkRecoverFunds,
  sparkRecoveryFundingUtxos,
  sparkRecoveryPayouts,
  sparkRecoveryRefused,
  sparkRecoverySteps,
  sparkStopSpendsOnItsOwn,
  sparkSkippedReasons,
  type SparkExitFunding,
  type SparkRecoverQuote,
  type SparkRecovery,
  type SparkRecoveryStep,
} from './spark'

// Everything that moves an emergency exit forward: the quote, the build, and the pass that follows a
// plan. One wallet at a time, the connected one, whose words alone open the fee key.
//
// The plan is on disk before anything leaves the device, so a process killed at any point loses
// nothing that matters. Sending a transaction again is harmless (recover_funds.md), so a pass keeps no
// memory of what it sent.

const PREPARE_WAIT_MS = 30_000
const CHECK_WAIT_MS = 30_000
const FEE_KEY_INDEX = 0

// A P2WPKH input, 272 weight units (spark/src/services/unilateral_exit.rs, the input weight it fees).
const NEW_COIN_VBYTES = 68

export type { ExitSelection } from './exitPlan'

type FeeTier = 'medium' | 'fast'

type Quoted = { quote: SparkRecoverQuote; quotedAt: number }

export type ExitQuote = Quoted & { selection: ExitSelection }

export type PrepareOutcome =
  | { kind: 'quoted'; quoted: ExitQuote }
  // A plan is alive: its leaves prepared again would make a second recovery racing the first.
  | { kind: 'live'; plan: ExitPlan }
  | { kind: 'noRate' }
  | { kind: 'failed' }

export type StartOutcome =
  | { kind: 'started'; plan: ExitPlan }
  | { kind: 'live'; plan: ExitPlan }
  | { kind: 'requoted'; quoted: ExitQuote }
  // The quote cannot be spent on, whatever the screen that holds it says.
  | { kind: 'refused'; verdict: QuoteVerdict }
  | ({ kind: 'short' } & Shortfall)
  | { kind: 'unread' }
  | { kind: 'noRate' }
  // The build ended with nothing to send, every leaf of it refused by the operators.
  | { kind: 'empty' }
  | { kind: 'failed' }

// What the fee address lacks. A figure only when what is confirmed there was read and nothing is on its
// way, since the SDK counts a coin a pending child spent and the address no longer lists it. `oneCoin`
// when the child takes no more coins, so the figure holds only as one payment.
export type Shortfall = { missingSat: number | null; pending: boolean; oneCoin?: true }

// New figures for a plan that is alive, held in memory and never on disk until the person answers. A
// verdict that may not go on has no confirm.
export type ExitAsk = {
  quoted: Quoted
  // The rate these figures were taken at, so a confirm can tell they aged.
  tier: FeeTier
  // A person asked for more speed, or the chain left the plan with no other way forward.
  reason: 'raise' | 'forced'
  verdict: QuoteVerdict
  // The plan these figures replace. Another build meanwhile makes them figures for something else.
  planTxids: string[]
}

export type RefusedStep = { txid: string; reason: string; txHex: string; cpfpTxHex: string | undefined }

export type PassOutcome =
  // The switch is off, no plan is alive, or the connection is not this wallet's.
  | { kind: 'idle' }
  | { kind: 'done'; plan: ExitPlan }
  // The check got no answer. The plan on disk is what it was.
  | { kind: 'offline'; plan: ExitPlan }
  | { kind: 'followed'; plan: ExitPlan; sent: number; refused: RefusedStep[] }
  // The chain moved past this plan, and a new one needs more money at this address.
  | ({ kind: 'short'; plan: ExitPlan; address: string } & Shortfall)
  // The chain moved past this plan, and what a new one costs needs the person's word. Nothing went out.
  | { kind: 'ask'; plan: ExitPlan; ask: ExitAsk }
  // A new build found nothing left of this plan, which ended here.
  | { kind: 'closed'; plan: ExitPlan }
  // The chain moved past this plan, and a new one could not be built on this pass.
  | { kind: 'stuck'; plan: ExitPlan }

// A pass that cannot go on without the person: new figures to confirm, or more money at the fee
// address. Neither is kept, so the next pass finds it again from the plan on disk.
export const waitsOnPerson = (outcome: PassOutcome): boolean => outcome.kind === 'ask' || outcome.kind === 'short'

export type FundingLook = { status: 'read'; confirmedSat: number; pendingSat: number } | { status: 'failed' }

const sumSat = (utxos: { valueSat: number }[]): number => utxos.reduce((sum, utxo) => sum + utxo.valueSat, 0)

const connectedAs = (walletId: string): boolean => sparkConnectedWalletId() === walletId

// A rate that never comes reads as no rate, so a dead chain service ends in Try again, not a skeleton.
const rateNow = (tier?: FeeTier): Promise<bigint | null> =>
  answerWithin(sparkExitFeeRate(tier), PREPARE_WAIT_MS)

class WalletMoved extends Error {}

async function feeWordsOf(walletId: string): Promise<{ words: string; passphrase: string | undefined }> {
  const words = await loadSeedFor(walletId)
  if (!words) {
    throw new Error('exit fee key: the wallet has no seed here')
  }
  return { words, passphrase: await loadPassphraseFor(walletId) }
}

async function feeKeyOf(walletId: string): Promise<ExitFeeKey> {
  const { words, passphrase } = await feeWordsOf(walletId)
  return exitFeeAddress(words, passphrase, FEE_KEY_INDEX)
}

const outpoint = (utxo: { txid: string; vout: number }): string => `${utxo.txid}:${utxo.vout}`

function withoutRepeats<T extends { txid: string; vout: number }>(utxos: T[]): T[] {
  return [...new Map(utxos.map(utxo => [outpoint(utxo), utxo])).values()]
}

// The address the person pays the fees to, which holds only for the words and passphrase of this wallet.
export async function exitFundingAddress(walletId: string): Promise<string | null> {
  return emergencyExitLive() ? (await feeKeyOf(walletId)).address : null
}

// What is at a fee address. Only for before a plan exists and after one ends: while a plan is alive
// every child's change lands here and the next child spends it, so nothing read here is spare.
export async function lookAtFunding(address: string): Promise<FundingLook> {
  const read = await readFunding(address)
  if (read.status === 'failed') {
    return { status: 'failed' }
  }
  return { status: 'read', confirmedSat: sumSat(read.confirmed), pendingSat: read.pendingSat }
}

async function quoteOf(
  request: Parameters<typeof sparkPrepareRecoverFunds>[0],
  now: () => number,
): Promise<Quoted | null> {
  const asked = sparkPrepareRecoverFunds(request).catch(() => null)
  const quote = await answerWithin(asked, PREPARE_WAIT_MS)
  return quote && { quote, quotedAt: now() }
}

// A plan the platform refuses to read throws, so it stops here and never opens a second exit. A torn
// one already went aside, and preparing is what reaches the money it stood for.
export async function prepareExit(
  walletId: string,
  destination: string,
  selection: ExitSelection,
  now: () => number = Date.now,
): Promise<PrepareOutcome> {
  if (!emergencyExitLive() || !connectedAs(walletId)) {
    return { kind: 'failed' }
  }
  const plan = await loadExitPlan(walletId)
  if (isLivePlan(plan)) {
    return { kind: 'live', plan }
  }
  const feeRateSatPerVbyte = await rateNow()
  if (feeRateSatPerVbyte === null) {
    return { kind: 'noRate' }
  }
  const quoted = await quoteOf({ feeRateSatPerVbyte, destination, selection }, now)
  return quoted ? { kind: 'quoted', quoted: { ...quoted, selection } } : { kind: 'failed' }
}

type Build =
  | { kind: 'built'; recovery: SparkRecovery; feeKey: ExitFeeKey | null }
  // `requiredSat` is the whole of what one point of the SDK wants, never the difference.
  | { kind: 'short'; requiredSat: number }
  // A child came back over the size the network relays, and the build was discarded.
  | { kind: 'crowded' }
  | { kind: 'failed' }

// The key lives only inside this call: derived from this wallet's words and passphrase, handed to the
// SDK and wiped. A wallet switched to while the words were read loses the race here, never signs.
async function build(walletId: string, quote: SparkRecoverQuote, utxos: ChainUtxo[]): Promise<Build> {
  try {
    if (quote.funding === undefined) {
      if (!connectedAs(walletId)) {
        return { kind: 'failed' }
      }
      return { kind: 'built', recovery: await sparkRecoverFunds(quote), feeKey: null }
    }
    const coins = fundingCoins(utxos, quote.feeRateSatPerVbyte)
    if (coins.length === 0) {
      return { kind: 'short', requiredSat: fundingNeededSat(quote) }
    }
    const { words, passphrase } = await feeWordsOf(walletId)
    const feeKey = await exitFeeAddress(words, passphrase, FEE_KEY_INDEX)
    const recovery = await withExitFeeSecret(words, passphrase, FEE_KEY_INDEX, secretKey => {
      if (!connectedAs(walletId)) {
        throw new WalletMoved()
      }
      const funding: SparkExitFunding = { utxos: coins, publicKey: feeKey.publicKey, secretKey }
      return sparkRecoverFunds(quote, funding)
    })
    // The SDK follows spent funding to what it became, which can hand a child more coins than it was
    // given, so the size is read on what came back. A build only signs, so discarding it costs nothing.
    const fits = sparkRecoverySteps(recovery).every(step => step.cpfpTxHex === undefined || childFits(step.cpfpTxHex))
    return fits ? { kind: 'built', recovery, feeKey } : { kind: 'crowded' }
  } catch (cause) {
    const requiredSat = sparkMissingFunding(cause)
    return requiredSat === null ? { kind: 'failed' } : { kind: 'short', requiredSat }
  }
}

// What to send, read at the address after the build fell short. The inputs handed to the build cannot
// answer this: they count coins spent long ago at face value. The new coin raises the first child or
// the fan-out by one input, so the bare difference falls short again.
async function shortfall(address: string, requiredSat: number, quote: SparkRecoverQuote): Promise<Shortfall> {
  const read = await readFunding(address)
  if (read.status === 'failed') {
    return { missingSat: null, pending: false }
  }
  if (read.pendingSat > 0) {
    return { missingSat: null, pending: true }
  }
  const coins = fundingCoins(read.confirmed, quote.feeRateSatPerVbyte)
  if (coins.length >= MAX_FUNDING_COINS) {
    // A new coin takes the place of the smallest, so it has to cover alone what that one paid.
    const missingSat = requiredSat - (sumSat(coins) - coins[coins.length - 1].valueSat)
    return missingSat > 0 ? { missingSat, pending: false, oneCoin: true } : { missingSat: null, pending: false }
  }
  const missingSat = requiredSat - sumSat(coins) + NEW_COIN_VBYTES * Number(quote.feeRateSatPerVbyte)
  return { missingSat: missingSat > 0 ? missingSat : null, pending: false }
}

const totalsOf = (recovery: SparkRecovery): Partial<SparkRecoverQuote> => ({
  recoverableValueSats: recovery.recoverableValueSats,
  totalFeeSats: recovery.totalFeeSats,
  cooperativeFeeSats: recovery.cooperativeFeeSats,
  cpfpFeeSats: recovery.cpfpFeeSats,
  fanoutFeeSats: recovery.fanoutFeeSats,
  refundFeeSats: recovery.refundFeeSats,
  sweepFeeSats: recovery.sweepFeeSats,
})

// The quote's rule on what came back, since real coins weigh more than the quote assumed. A build only
// signs, so discarding it costs nothing.
function verdictOfBuild(recovery: SparkRecovery): QuoteVerdict {
  const verdict = quoteVerdict(recovery)
  return mayGoOn(verdict) && !sparkRecoveryPayouts(recovery).every(paysAboveRelay) ? 'tooSmall' : verdict
}

// The first build. What it sends comes only from a later pass, once the plan is on disk.
export async function startExit(
  walletId: string,
  destination: string,
  quoted: ExitQuote,
  now: () => number = Date.now,
): Promise<StartOutcome> {
  if (!emergencyExitLive() || !connectedAs(walletId)) {
    return { kind: 'failed' }
  }
  const plan = await loadExitPlan(walletId)
  if (isLivePlan(plan)) {
    return { kind: 'live', plan }
  }
  const verdict = quoteVerdict(quoted.quote)
  if (!mayGoOn(verdict)) {
    return { kind: 'refused', verdict }
  }
  const rate = await rateNow()
  if (rate === null) {
    return { kind: 'noRate' }
  }
  if (quoteIsOld(quoted.quotedAt, now(), quoted.quote.feeRateSatPerVbyte, rate)) {
    const again = await quoteOf(
      { feeRateSatPerVbyte: rate, destination, selection: quoted.selection },
      now,
    )
    return again ? { kind: 'requoted', quoted: { ...again, selection: quoted.selection } } : { kind: 'failed' }
  }
  let utxos: ChainUtxo[] = []
  if (quoted.quote.funding !== undefined) {
    const read = await readFunding((await feeKeyOf(walletId)).address)
    if (read.status === 'failed') {
      return { kind: 'unread' }
    }
    utxos = read.confirmed
  }
  const built = await build(walletId, quoted.quote, utxos)
  if (built.kind === 'short') {
    const address = (await feeKeyOf(walletId)).address
    return { kind: 'short', ...(await shortfall(address, built.requiredSat, quoted.quote)) }
  }
  if (built.kind !== 'built') {
    return { kind: 'failed' }
  }
  if (built.recovery.transactions.length === 0) {
    return { kind: 'empty' }
  }
  const builtVerdict = verdictOfBuild(built.recovery)
  if (!mayGoOn(builtVerdict)) {
    return { kind: 'refused', verdict: builtVerdict }
  }
  const started: ExitPlan = {
    walletId,
    feeKey: built.feeKey,
    recovery: built.recovery,
    fundingStrategy: quoted.quote.funding?.strategy,
    selection: quoted.selection,
    verdict: 'valid',
    checkedAt: now(),
    refused: [],
  }
  await saveExitPlan(started)
  // The connection that built still swaps leaves on its own, and can swap one this plan names before
  // the first pass replaces it. The stop runs a native connect that may never answer, so Start, which
  // holds the screen, does not wait for it; its answer gates nothing, since the pass asks again before
  // it sends.
  sparkStopSpendsOnItsOwn(walletId).catch(() => false)
  return { kind: 'started', plan: started }
}

// Sends whatever the SDK calls ready. A step the chain could not be read for goes out only when it is
// a cooperative recovery, which the network refuses harmlessly if it is too late. For any other step
// the funding it spends may be gone, and only building again settles that.
export const stepsToSend = (steps: SparkRecoveryStep[]): SparkRecoveryStep[] =>
  steps.filter(step => step.stage === 'ready' || (step.stage === 'unverified' && step.cooperative))

// A step the check cannot settle and a pass will not send: only a new build moves it, or the chain
// confirming it from outside.
export const waitsOnChainRead = (step: SparkRecoveryStep): boolean => step.stage === 'unverified' && !step.cooperative

const send = (step: SparkRecoveryStep): Promise<Broadcast> =>
  step.cpfpTxHex === undefined
    ? broadcastTx(step.txHex, step.txid)
    : broadcastPackage(step.txHex, step.cpfpTxHex, step.txid)

type Followed = Extract<PassOutcome, { kind: 'followed' }>
type Unsent = Extract<PassOutcome, { kind: 'offline' }>

// The one place a pass transmits. A connection that still spends leaves on its own can spend one this
// exit is taking (guide/optimize.html: optimization runs after each payment; guide/stable_balance.html:
// an active stable balance converts excess sats on receive), so it is replaced first, and when it
// cannot be, nothing goes out and the next pass tries again.
async function sendReady(plan: ExitPlan, now: () => number): Promise<Followed | Unsent> {
  if (!(await sparkStopSpendsOnItsOwn(plan.walletId))) {
    return { kind: 'offline', plan }
  }
  const refused: RefusedStep[] = []
  let sent = 0
  for (const step of stepsToSend(sparkRecoverySteps(plan.recovery))) {
    const answer = await send(step)
    if (answer.status === 'sent') {
      sent += 1
    } else {
      refused.push({
        txid: step.txid,
        // No host answered, which only a later pass can tell from a refusal.
        reason: answer.status === 'refused' ? answer.reason : '',
        txHex: step.txHex,
        cpfpTxHex: step.cpfpTxHex,
      })
    }
  }
  const sentPlan: ExitPlan = {
    ...plan,
    checkedAt: now(),
    refused: refused.map(({ txid, reason }) => ({ txid, reason })),
  }
  // Only the note of this send is at stake here, and the next pass writes its own.
  await saveExitPlan(sentPlan).catch(() => undefined)
  return { kind: 'followed', plan: sentPlan, sent, refused }
}

const planTxids = (plan: ExitPlan): string[] => plan.recovery.transactions.map(tx => tx.txid)

const askOf = (
  plan: ExitPlan,
  quoted: Quoted,
  tier: FeeTier,
  reason: ExitAsk['reason'],
  verdict: QuoteVerdict = quoteVerdict(quoted.quote),
): ExitAsk => ({ quoted, tier, reason, verdict, planTxids: planTxids(plan) })

// A rate under the plan's would lose the replacement on the network.
function rateOver(plan: ExitPlan, rate: bigint): bigint {
  return rate > plan.recovery.feeRateSatPerVbyte ? rate : plan.recovery.feeRateSatPerVbyte
}

// Only what comes out of the value counts, so a new coin at the fee address cannot make this look better.
const worseThan = (plan: ExitPlan, quote: SparkRecoverQuote): boolean =>
  quote.feeRateSatPerVbyte > plan.recovery.feeRateSatPerVbyte ||
  arrivingSat(quote) < arrivingSat(plan.recovery) ||
  quote.skipped.length > 0

async function closePlan(plan: ExitPlan, closure: ExitClosure, now: () => number): Promise<ExitPlan> {
  const closed: ExitPlan = { ...plan, verdict: 'closed', closure, checkedAt: now(), refused: [] }
  await saveExitPlan(closed)
  return closed
}

function closureOf(quote: SparkRecoverQuote): ExitClosure {
  const { feeTooHigh, noData } = sparkSkippedReasons(quote)
  return feeTooHigh ? 'fee' : noData ? 'data' : 'nothing'
}

type Requote = { kind: 'quoted'; quoted: Quoted } | { kind: 'closed'; plan: ExitPlan } | { kind: 'stuck' }

// Starting over names the same leaves, since `All` and `RecoverableOnly` drop a leaf a new rate makes
// uneconomical. `Specific` takes them whether or not they are worth it, so the rule that protects the
// first quote has to be applied to this one again. It also leaves out a leaf already swept, by this
// device or another with the same words, so a quote with none left ends the plan: nothing here can move
// and preparing again reaches whatever remains. Unless a read failed, which says nothing of the leaves.
async function requote(plan: ExitPlan, rate: bigint, now: () => number): Promise<Requote> {
  const quoted = await quoteOf(
    {
      feeRateSatPerVbyte: rate,
      destination: plan.recovery.destination,
      selection: { leafIds: plan.recovery.leaves.map(leaf => leaf.leafId) },
      fundingStrategy: plan.fundingStrategy,
    },
    now,
  )
  if (!quoted || !connectedAs(plan.walletId)) {
    return { kind: 'stuck' }
  }
  if (quoted.quote.leaves.length > 0) {
    return { kind: 'quoted', quoted }
  }
  return sparkLeafUnverified(quoted.quote)
    ? { kind: 'stuck' }
    : { kind: 'closed', plan: await closePlan(plan, closureOf(quoted.quote), now) }
}

type Rebuild =
  | { kind: 'rebuilt'; plan: ExitPlan }
  | ({ kind: 'short'; address: string } & Shortfall)
  // The build came back past what the quote showed, and it was discarded.
  | { kind: 'refused'; ask: ExitAsk }
  | { kind: 'closed'; plan: ExitPlan }
  | { kind: 'stuck' }

// The SDK follows spent funding to what it became, so the funding kept with the plan goes back in and a
// failed read of the address goes on with that. Anything that arrived there since is added to it.
async function buildOver(plan: ExitPlan, ask: ExitAsk, now: () => number): Promise<Rebuild> {
  const { quote } = ask.quoted
  const kept = sparkRecoveryFundingUtxos(plan.recovery)
  const address = plan.feeKey?.address ?? (await feeKeyOf(plan.walletId)).address
  const read = await readFunding(address)
  const fresh = read.status === 'read' ? read.confirmed : []
  const built = await build(plan.walletId, quote, withoutRepeats([...kept, ...fresh]))
  if (built.kind === 'short') {
    return { kind: 'short', address, ...(await shortfall(address, built.requiredSat, quote)) }
  }
  if (built.kind !== 'built') {
    return { kind: 'stuck' }
  }
  if (built.recovery.transactions.length === 0) {
    // Leaves that failed with nothing built is the operators gone, which a later pass can get past.
    return built.recovery.failed.length > 0
      ? { kind: 'stuck' }
      : { kind: 'closed', plan: await closePlan(plan, 'nothing', now) }
  }
  // Built on a failed read of the chain, it could leave the plan no better off than this one.
  if (sparkRecoverySteps(built.recovery).some(waitsOnChainRead)) {
    return { kind: 'stuck' }
  }
  const verdict = verdictOfBuild(built.recovery)
  if (!mayGoOn(verdict)) {
    const shown = { ...ask.quoted, quote: { ...quote, ...totalsOf(built.recovery) } }
    return { kind: 'refused', ask: askOf(plan, shown, ask.tier, ask.reason, verdict) }
  }
  const next: ExitPlan = {
    ...plan,
    feeKey: built.feeKey ?? plan.feeKey,
    recovery: built.recovery,
    fundingStrategy: quote.funding?.strategy ?? plan.fundingStrategy,
    verdict: 'valid',
    checkedAt: now(),
    refused: [],
  }
  await saveExitPlan(next)
  return { kind: 'rebuilt', plan: next }
}

type NewBuild =
  | { kind: 'rebuilt'; plan: ExitPlan }
  | { kind: 'closed'; plan: ExitPlan }
  | { kind: 'ask'; ask: ExitAsk }
  | ({ kind: 'short'; address: string } & Shortfall)
  | { kind: 'stuck' }

async function buildAgain(plan: ExitPlan, now: () => number, chainRead: 'needed' | 'any'): Promise<NewBuild> {
  const rate = await rateNow()
  if (rate === null) {
    return { kind: 'stuck' }
  }
  const answer = await requote(plan, rateOver(plan, rate), now)
  if (answer.kind !== 'quoted') {
    return answer
  }
  const { quoted } = answer
  if (chainRead === 'needed' && !sparkQuoteReadChain(quoted.quote)) {
    return { kind: 'stuck' }
  }
  const ask = askOf(plan, quoted, 'medium', 'forced')
  if (!mayGoOn(ask.verdict) || worseThan(plan, quoted.quote)) {
    return { kind: 'ask', ask }
  }
  const rebuilt = await buildOver(plan, ask, now)
  return rebuilt.kind === 'refused' ? { kind: 'ask', ask: rebuilt.ask } : rebuilt
}

async function startOver(plan: ExitPlan, now: () => number): Promise<PassOutcome> {
  const next = await buildAgain(plan, now, 'any')
  if (next.kind === 'rebuilt') {
    return sendReady(next.plan, now)
  }
  return next.kind === 'closed' ? next : { ...next, plan }
}

// A step built on a failed read goes nowhere by itself, so a pass with a good read of the chain builds
// again. The rest of the plan keeps moving meanwhile. Its Ready steps stay valid, though sending them
// first would leave a child the new build at the same rate could not replace, so they go after.
async function settleUnverified(plan: ExitPlan, now: () => number): Promise<PassOutcome> {
  const next = await buildAgain(plan, now, 'needed')
  if (next.kind === 'rebuilt') {
    return sendReady(next.plan, now)
  }
  if (next.kind === 'closed') {
    return next
  }
  const followed = await sendReady(plan, now)
  return next.kind === 'stuck' ? followed : { ...next, plan: followed.plan }
}

async function onePass(walletId: string, now: () => number): Promise<PassOutcome> {
  const plan = await loadExitPlan(walletId)
  if (!isLivePlan(plan) || !connectedAs(walletId)) {
    return { kind: 'idle' }
  }
  let refusedByCheck = false
  const asked = sparkCheckRecoverFunds(plan.recovery).catch((cause: unknown) => {
    refusedByCheck = sparkRecoveryRefused(cause)
    return null
  })
  const check = await answerWithin(asked, CHECK_WAIT_MS)
  if (check === null) {
    return refusedByCheck ? startOver(plan, now) : { kind: 'offline', plan }
  }
  const checked: ExitPlan = {
    ...plan,
    recovery: check.recovery,
    verdict: check.verdict,
    checkedAt: now(),
  }
  await saveExitPlan(checked)
  if (check.verdict === 'done') {
    return { kind: 'done', plan: checked }
  }
  if (check.verdict === 'redo') {
    return startOver(checked, now)
  }
  return sparkRecoverySteps(checked.recovery).some(waitsOnChainRead)
    ? settleUnverified(checked, now)
    : sendReady(checked, now)
}

const running = new Map<string, Promise<PassOutcome>>()

// One pass per wallet at a time. The timer of the screen and the focus of Home can land together, and
// two passes that both start over would build two recoveries of the same leaves.
export function runExitPass(walletId: string, now: () => number = Date.now): Promise<PassOutcome> {
  if (!emergencyExitLive()) {
    return Promise.resolve({ kind: 'idle' })
  }
  const ongoing = running.get(walletId)
  if (ongoing) {
    return ongoing
  }
  return holdTurn(walletId, onePass(walletId, now))
}

function holdTurn(walletId: string, work: Promise<PassOutcome>): Promise<PassOutcome> {
  const turn = work.finally(() => running.delete(walletId))
  running.set(walletId, turn)
  return turn
}

// Behind whatever holds the wallet, since a build beside a pass would race it for the same leaves.
async function inTurn<T>(walletId: string, work: () => Promise<T>): Promise<T> {
  while (running.has(walletId)) {
    await running.get(walletId)?.catch(() => undefined)
  }
  const doing = work()
  const idle = (): PassOutcome => ({ kind: 'idle' })
  await holdTurn(walletId, doing.then(idle, idle))
  return doing
}

export type PayMoreOutcome =
  | { kind: 'ask'; ask: ExitAsk }
  | { kind: 'closed'; plan: ExitPlan }
  // Already at the fast rate.
  | { kind: 'top' }
  | { kind: 'failed' }

async function raiseQuote(walletId: string, now: () => number): Promise<PayMoreOutcome> {
  const plan = await loadExitPlan(walletId)
  if (!isLivePlan(plan) || !connectedAs(walletId)) {
    return { kind: 'failed' }
  }
  const rate = await rateNow('fast')
  if (rate === null) {
    return { kind: 'failed' }
  }
  if (rate <= plan.recovery.feeRateSatPerVbyte) {
    return { kind: 'top' }
  }
  const answer = await requote(plan, rate, now)
  if (answer.kind === 'quoted') {
    return { kind: 'ask', ask: askOf(plan, answer.quoted, 'fast', 'raise') }
  }
  return answer.kind === 'closed' ? answer : { kind: 'failed' }
}

// A recovery stops confirming when fees rise past what it pays. This only takes the figures of the rest
// at the fast rate: nothing is built or spent until the person sees them and confirms.
export async function payMore(walletId: string, now: () => number = Date.now): Promise<PayMoreOutcome> {
  if (!emergencyExitLive()) {
    return { kind: 'failed' }
  }
  return inTurn(walletId, () => raiseQuote(walletId, now))
}

export type ConfirmOutcome =
  | { kind: 'paid'; plan: ExitPlan }
  // The figures on screen are no longer the ones this would spend on.
  | { kind: 'ask'; ask: ExitAsk }
  | { kind: 'closed'; plan: ExitPlan }
  | ({ kind: 'short'; plan: ExitPlan; address: string } & Shortfall)
  | { kind: 'failed' }

async function confirmed(walletId: string, ask: ExitAsk, now: () => number): Promise<ConfirmOutcome> {
  const plan = await loadExitPlan(walletId)
  if (!isLivePlan(plan) || !connectedAs(walletId)) {
    return { kind: 'failed' }
  }
  const tierRate = await rateNow(ask.tier)
  if (tierRate === null) {
    return { kind: 'failed' }
  }
  const rate = rateOver(plan, tierRate)
  const { quote, quotedAt } = ask.quoted
  const samePlan = planTxids(plan).join() === ask.planTxids.join()
  if (quoteIsOld(quotedAt, now(), quote.feeRateSatPerVbyte, rate) || !samePlan) {
    const answer = await requote(plan, rate, now)
    if (answer.kind === 'quoted') {
      return { kind: 'ask', ask: askOf(plan, answer.quoted, ask.tier, ask.reason) }
    }
    return answer.kind === 'closed' ? answer : { kind: 'failed' }
  }
  if (!mayGoOn(ask.verdict)) {
    return { kind: 'failed' }
  }
  const rebuilt = await buildOver(plan, ask, now)
  switch (rebuilt.kind) {
    case 'rebuilt':
      // The plan after the send, or a refusal of this send would not reach the screen.
      return { kind: 'paid', plan: (await sendReady(rebuilt.plan, now)).plan }
    case 'refused':
      return { kind: 'ask', ask: rebuilt.ask }
    case 'short':
      return { ...rebuilt, plan }
    case 'closed':
      return rebuilt
    default:
      return { kind: 'failed' }
  }
}

// The one way a person's word turns figures into a build, for Pay more and for a pass that had to ask.
export async function confirmAsk(
  walletId: string,
  ask: ExitAsk,
  now: () => number = Date.now,
): Promise<ConfirmOutcome> {
  if (!emergencyExitLive()) {
    return { kind: 'failed' }
  }
  return inTurn(walletId, () => confirmed(walletId, ask, now))
}

// A plan the chain left with no way forward worth paying for ends by the person's word. Preparing again
// reaches the money from wherever it is, so stopping here loses nothing.
export async function leaveExit(walletId: string, now: () => number = Date.now): Promise<ExitPlan | null> {
  if (!emergencyExitLive()) {
    return null
  }
  return inTurn(walletId, async () => {
    const plan = await loadExitPlan(walletId)
    return isLivePlan(plan) ? closePlan(plan, 'later', now) : null
  })
}
