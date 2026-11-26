import RNFS from 'react-native-fs'
import NativeVoltzReview from '../../specs/NativeVoltzReview'
import { readDurable, serialQueue, writeDurable } from './durableFile'
import { readPendingSends } from './pendingSends'
import { asOwnActivity } from './relock'
import { PRIMARY_ID } from './seed'
import { getActiveWalletId } from './walletRegistry'

// The stores' review card, asked at most once per wallet, after a completed receive the app announced
// for it, at a quiet moment on Home. Google and Apple both ask for a moment after the person got
// something done, never from a button or in answer to a tap, and both cap how often the card shows and
// say nothing about whether it did (Play In-App Review, StoreKit requestReview). So the app asks once
// and never again for that wallet, whatever happened.
//
// One announced receive is one chance: the overlay's close decides it, and a moment that is not quiet
// waits for the next announced receive rather than for a timer. Nothing here talks to the network; the
// store's own prompt is the only thing that leaves the device.

// The wallets already asked, kept so the ask is never repeated. Ids only.
const FILE = `${RNFS.DocumentDirectoryPath}/store-review.json`

type Stored = { asked: string[] }

const valid = (value: unknown): boolean => {
  const v = value as Partial<Stored> | null
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray(v.asked) &&
    v.asked.every(id => typeof id === 'string')
  )
}

const serial = serialQueue()

// The asked list, empty when nothing was ever written. A torn file, or a read the platform refused,
// throws, and every caller takes that as asked. A cut first write reads as no file ('nothing'): its
// writer asks only once the write resolved, so a cut one asked nobody.
async function readAsked(): Promise<string[]> {
  const stored = (await readDurable(FILE, valid, 'nothing')) as Stored | null
  return stored?.asked ?? []
}

// Records the ask before it is made. Answers false, writing nothing, when the wallet was asked already
// or the list could not be read.
function markAsked(walletId: string): Promise<boolean> {
  return serial(async () => {
    const asked = await readAsked()
    if (asked.includes(walletId)) {
      return false
    }
    await writeDurable(FILE, JSON.stringify({ asked: [...asked, walletId] }), valid, 'refuse', 'nothing')
    return true
  }).catch(() => false)
}

// Whether the wallet was asked, or may have been: a list that cannot be read counts as asked.
export function wasAsked(walletId: string): Promise<boolean> {
  return serial(readAsked).then(
    asked => asked.includes(walletId),
    () => true,
  )
}

// Drops a removed wallet from the list, so the same words added again count as a wallet of their own.
// A list that cannot be read is left as it is and keeps counting every wallet as asked.
export function forgetStoreReview(walletId: string): Promise<void> {
  return serial(async () => {
    const asked = await readAsked()
    if (!asked.includes(walletId)) {
      return
    }
    const rest = asked.filter(id => id !== walletId)
    await writeDurable(FILE, JSON.stringify({ asked: rest }), valid, 'refuse', 'nothing')
  })
}

// What the screen around the ask is doing, read by the caller at the moment it is asked for.
export type ReviewMoment = {
  /** Home's tab is the route in front, with the drawer closed. */
  homeInFront: boolean
  /** The PIN asked again is up. */
  locked: boolean
  /** AppState is 'active'. */
  appActive: boolean
  /** Modals open now, every sheet included. */
  modalsOpen: number
  /** A send, a prepare or a conversion is running. */
  spendInFlight: boolean
}

export function quietMoment(moment: ReviewMoment): boolean {
  return (
    moment.homeInFront &&
    !moment.locked &&
    moment.appActive &&
    moment.modalsOpen === 0 &&
    !moment.spendInFlight
  )
}

// The wallet whose completed receive the overlay announced and whose close has not been decided yet.
let armed: string | null = null

// Called when the overlay announces a completed receive, with the wallet whose connection it came on.
export function noteAnnouncedReceive(walletId: string | null): void {
  armed = walletId
}

// A send this wallet left pending, or a record of them that cannot be read, holds the ask, since its
// end can still come and be told on Home.
async function sendLeftPending(walletId: string): Promise<boolean> {
  try {
    const pending = await readPendingSends(walletId)
    return pending.kind !== 'ok' || pending.ids.length > 0
  } catch {
    return true
  }
}

async function activeWallet(): Promise<string | null> {
  try {
    return (await getActiveWalletId()) ?? PRIMARY_ID
  } catch {
    return null
  }
}

export type ReviewOutcome = 'asked' | 'notArmed' | 'notQuiet' | 'otherWallet' | 'alreadyAsked' | 'unrecorded'

// Decides the overlay's close: the armed receive is used up whatever the answer. `moment` is read
// before each wait ends and once more right after the record is written, so a send or a sheet that
// starts meanwhile still stops the ask. A failure of the native side, or no native side, asks nothing
// and says nothing. Exactly one ask per wallet: the record goes to disk before the store is asked, and
// a process killed between the two leaves the wallet never asked.
export async function considerReview(moment: () => ReviewMoment): Promise<ReviewOutcome> {
  const walletId = armed
  armed = null
  if (walletId === null) {
    return 'notArmed'
  }
  if (!quietMoment(moment())) {
    return 'notQuiet'
  }
  if ((await activeWallet()) !== walletId) {
    return 'otherWallet'
  }
  if (await wasAsked(walletId)) {
    return 'alreadyAsked'
  }
  if ((await sendLeftPending(walletId)) || !quietMoment(moment())) {
    return 'notQuiet'
  }
  if (!(await markAsked(walletId))) {
    return 'unrecorded'
  }
  if (!quietMoment(moment())) {
    return 'notQuiet'
  }
  await requestReview()
  return 'asked'
}

// The store's card. Play starts an activity of its own over the app, so the trip it makes is timed as
// one of the app's (relock.ts). Silent on any failure, since there is nothing to tell the person.
async function requestReview(): Promise<void> {
  const native = NativeVoltzReview
  if (!native) {
    return
  }
  try {
    await asOwnActivity(() => native.request())
  } catch {
    // The store could not ask; the wallet stays recorded as asked.
  }
}

export function __resetStoreReviewForTests(): void {
  armed = null
}
