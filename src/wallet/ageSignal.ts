import NativeVoltzAge, { type AgeAnswer } from '../../specs/NativeVoltzAge'
import { answerWithin } from './answerWithin'
import { asOwnActivity } from './relock'

// The stores' age signal, asked once per launch: California's Digital Age Assurance Act (Civ. Code
// 1798.500 et seq.) has every app ask for it when it is downloaded and launched, from 2027.
//
// Only a person the store marks as regulated is asked (`regulated`), so nobody else sees a prompt or
// pays a request. What the store answers reduces at once to a verdict, the one thing kept, and only in
// this module's memory: the range is never written, sent or logged, and a new launch asks again. The
// Play policy limits the signal to complying with the law.
//
// A minor's verdict stops two things and nothing else: a new wallet (created, imported or from a
// passkey) and a store purchase. A wallet already on the device keeps Send, Receive, its words and the
// emergency exit, since locking a person out of their own funds is a harm the law does not ask for.
// Any answer short of a range under 18 (unregulated, declined, failed, no module, below iOS 26.2, no
// Play Store) stops nothing.

export const ADULT_AGE = 18

// How long a gated step waits for an ask still in flight before it goes on as if nothing were known.
// Play's sharing prompt can hold the ask open, and the step would wait behind it.
export const AGE_WAIT_MS = 5_000

export type AgeVerdict = 'minor' | 'adult' | 'unknown'

const bound = (value: number): number | null => (Number.isInteger(value) && value >= 0 ? value : null)

// A range whose top is under 18 is a minor's, and one whose floor is 18 or more an adult's. A range
// the store left open at both ends, or did not give, says nothing.
export function verdictOf(answer: AgeAnswer): AgeVerdict {
  if (answer.status !== 'shared') {
    return 'unknown'
  }
  const upper = bound(answer.upper)
  if (upper !== null && upper < ADULT_AGE) {
    return 'minor'
  }
  const lower = bound(answer.lower)
  return lower !== null && lower >= ADULT_AGE ? 'adult' : 'unknown'
}

let asked: Promise<AgeVerdict> | null = null
let settled: AgeVerdict | null = null
const listeners = new Set<() => void>()

async function ask(): Promise<AgeVerdict> {
  const native = NativeVoltzAge
  if (!native) {
    return 'unknown'
  }
  try {
    if (!(await native.regulated())) {
      return 'unknown'
    }
    return verdictOf(await asOwnActivity(() => native.request()))
  } catch {
    // A store that cannot answer stops nothing, and what failed says nothing worth keeping.
    return 'unknown'
  }
}

// Asks the store once per launch, and answers the same verdict to every later call.
export function askAgeSignal(): Promise<AgeVerdict> {
  if (!asked) {
    asked = ask().then(verdict => {
      settled = verdict
      listeners.forEach(cb => cb())
      return verdict
    })
  }
  return asked
}

// The verdict once the ask has answered, null before.
export function ageVerdictNow(): AgeVerdict | null {
  return settled
}

export function onAgeVerdict(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

// Whether the store says this person is under 18, waiting up to `waitMs` for an ask in flight. An ask
// that has not answered by then counts as nothing known.
export async function minorBySignal(waitMs: number = AGE_WAIT_MS): Promise<boolean> {
  if (settled !== null) {
    return settled === 'minor'
  }
  return (await answerWithin(askAgeSignal(), waitMs)) === 'minor'
}

// What a gated write throws for a minor. Its message names no age, so a log of it says nothing.
export class AgeRefusal extends Error {
  constructor() {
    super('refused')
    this.name = 'AgeRefusal'
  }
}

export function isAgeRefusal(err: unknown): err is AgeRefusal {
  return err instanceof AgeRefusal
}

export async function refuseMinor(): Promise<void> {
  if (await minorBySignal()) {
    throw new AgeRefusal()
  }
}

export function __resetAgeSignalForTests(): void {
  asked = null
  settled = null
  listeners.clear()
}
