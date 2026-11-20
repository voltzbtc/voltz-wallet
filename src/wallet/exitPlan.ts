import RNFS from 'react-native-fs'
import {
  asideExists,
  isUnreadableFile,
  readDurable,
  removeDurable,
  serialQueue,
  setAside,
  writeDurable,
} from './durableFile'
import { emergencyExitLive } from './emergencyExit'
import type { SparkFundingStrategy, SparkRecovery, SparkRecoveryVerdict } from './spark'

/**
 * The one record of an emergency exit, one file per wallet.
 *
 * The SDK keeps none of it: `check_recover_funds` follows only the response it is handed, so losing
 * this file loses the way to follow the exit, though the money stays recoverable by preparing again.
 * A plan is written whole before its first transaction goes out and replaced by each check before the
 * next one does. A torn file goes aside and reads as no exit, since it can never answer again and would
 * hold the wallet for good, while the money stays recoverable by preparing again. A read the platform
 * refuses stops the screens, since the file may be whole.
 *
 * It holds what the SDK needs back and the public half of the fee key, never a secret. Written with
 * bigints as tagged strings, since JSON has none, and the SDK's variants as `tag` and `inner`, which is
 * all its converters read, so a plain object goes back through the binding as the class it came from.
 */

export type ExitFeeKey = { index: number; address: string; publicKey: string }

// Which leaves the person asked to take out: the recoverable funds (RecoverableOnly) or every leaf (All).
export type ExitSelection = 'recoverable' | 'all'

export type ExitRefusal = { txid: string; reason: string }

// Why a plan ended short of `done`: a new build found nothing left, for the reason named, or the person
// left it for later. Either way the money is where the chain has it, and preparing again reaches it.
export type ExitClosure = 'nothing' | 'fee' | 'data' | 'later'

export type ExitPlan = {
  walletId: string
  // Null for a recovery with nothing to fund.
  feeKey: ExitFeeKey | null
  recovery: SparkRecovery
  // What the funding was computed for, which a recovery does not carry and a new build has to repeat.
  // Absent for a recovery with nothing to fund and on a plan written before the SDK had the option,
  // whose funding was one UTXO per branch, which is also what the SDK takes unset to mean.
  fundingStrategy?: SparkFundingStrategy
  // The selection the exit started with, kept across every rebuild, which names the same leaves with
  // Specific. A record of what was chosen; no figure is computed from it. Absent on a plan written
  // before it was recorded.
  selection?: ExitSelection
  verdict: SparkRecoveryVerdict | 'closed'
  // Set with the `closed` verdict.
  closure?: ExitClosure
  checkedAt: number
  // What the hosts refused in the last send, so reopening shows it before the next pass ends.
  refused: ExitRefusal[]
}

// A wallet's removal refused before anything is touched, because it has an exit under way.
export class WalletHasLiveExit extends Error {
  constructor(readonly id: string) {
    super(`wallet ${id} has an emergency exit under way`)
    this.name = 'WalletHasLiveExit'
  }
}

export function isWalletHasLiveExit(err: unknown): boolean {
  return (err as Error | null)?.name === 'WalletHasLiveExit'
}

// A read the platform refused. The file may be whole and a plan may be alive in it, so this holds the
// wallet and stops the screens until a read answers.
export class ExitPlanUnread extends Error {
  constructor(readonly walletId: string) {
    super(`the exit plan of ${walletId} could not be read`)
    this.name = 'ExitPlanUnread'
  }
}

export function isExitPlanUnread(err: unknown): boolean {
  return (err as Error | null)?.name === 'ExitPlanUnread'
}

const VERSION = 1
const SELECTIONS: readonly string[] = ['recoverable', 'all'] satisfies ExitSelection[]
const BIG = '$bigint'
const STATUS_TAGS = ['Confirmed', 'Ready', 'WaitingForDependencies', 'WaitingForTimelock', 'Unverified']
const VERDICTS = ['valid', 'done', 'redo', 'closed']
const CLOSURES = ['nothing', 'fee', 'data', 'later']
// CpfpFundingStrategy, numeric in the binding: PerBranch and PerNode.
const STRATEGIES = [0, 1]

type Loose = Record<string, unknown>

const isObject = (value: unknown): value is Loose =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isBig = (value: unknown): boolean =>
  isObject(value) && typeof value[BIG] === 'string' && /^\d+$/.test(value[BIG])

const isStoredStep = (value: unknown): boolean =>
  isObject(value) &&
  typeof value.txid === 'string' &&
  typeof value.txHex === 'string' &&
  isObject(value.status) &&
  STATUS_TAGS.includes(value.status.tag as string)

const isStoredRecovery = (value: unknown): boolean =>
  isObject(value) &&
  Array.isArray(value.transactions) &&
  value.transactions.every(isStoredStep) &&
  Array.isArray(value.leaves) &&
  value.leaves.every(leaf => isObject(leaf) && typeof leaf.leafId === 'string') &&
  Array.isArray(value.failed) &&
  Array.isArray(value.fundingInputs) &&
  typeof value.destination === 'string' &&
  isBig(value.feeRateSatPerVbyte)

const isStoredFeeKey = (value: unknown): boolean =>
  value === null ||
  (isObject(value) &&
    Number.isInteger(value.index) &&
    typeof value.address === 'string' &&
    typeof value.publicKey === 'string')

function isStoredPlan(value: unknown): boolean {
  return (
    isObject(value) &&
    value.version === VERSION &&
    typeof value.walletId === 'string' &&
    VERDICTS.includes(value.verdict as string) &&
    (value.closure === undefined || CLOSURES.includes(value.closure as string)) &&
    (value.fundingStrategy === undefined || STRATEGIES.includes(value.fundingStrategy as number)) &&
    (value.selection === undefined || SELECTIONS.includes(value.selection as string)) &&
    typeof value.checkedAt === 'number' &&
    Array.isArray(value.refused) &&
    isStoredFeeKey(value.feeKey) &&
    isStoredRecovery(value.recovery)
  )
}

function encode(plan: ExitPlan): string {
  return JSON.stringify({ version: VERSION, ...plan }, (_key, value: unknown) =>
    typeof value === 'bigint' ? { [BIG]: value.toString() } : value,
  )
}

function decoded(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decoded)
  }
  if (!isObject(value)) {
    return value
  }
  if (isBig(value)) {
    return BigInt(value[BIG] as string)
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decoded(item)]))
}

const pathOf = (walletId: string): string =>
  `${RNFS.DocumentDirectoryPath}/exit-plan-${encodeURIComponent(walletId)}.json`

const serial = serialQueue()

export const isLivePlan = (plan: ExitPlan | null): plan is ExitPlan =>
  plan !== null && plan.verdict !== 'done' && plan.verdict !== 'closed'

async function readPlanFile(walletId: string): Promise<unknown> {
  const path = pathOf(walletId)
  try {
    return await readDurable(path, isStoredPlan)
  } catch (cause) {
    if (!isUnreadableFile(cause)) {
      throw new ExitPlanUnread(walletId)
    }
  }
  try {
    await setAside(path)
    return null
  } catch {
    throw new ExitPlanUnread(walletId)
  }
}

// A plan that ended stays until its screen is closed, so the person sees the end of it.
export function loadExitPlan(walletId: string): Promise<ExitPlan | null> {
  if (!emergencyExitLive()) {
    return Promise.resolve(null)
  }
  return serial(async () => {
    const stored = await readPlanFile(walletId)
    if (stored === null) {
      return null
    }
    const { version, ...plan } = decoded(stored) as ExitPlan & { version: number }
    return version === VERSION ? plan : null
  })
}

// Whether a plan of this wallet was ever put aside, which its first screen says.
export function exitPlanWasSetAside(walletId: string): Promise<boolean> {
  return serial(() => asideExists(pathOf(walletId)))
}

export function saveExitPlan(plan: ExitPlan): Promise<void> {
  if (!emergencyExitLive()) {
    return Promise.reject(new Error('emergency exit is off'))
  }
  return serial(() => writeDurable(pathOf(plan.walletId), encode(plan), isStoredPlan))
}

export function forgetExitPlan(walletId: string): Promise<void> {
  return serial(() => removeDurable(pathOf(walletId)))
}
