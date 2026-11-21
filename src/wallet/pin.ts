import * as Keychain from 'react-native-keychain'

// App access PIN, a second barrier on top of device unlock, so an already-unlocked
// phone does not grant wallet access. Stored unhashed in the Keychain (already
// encrypted) under a dedicated service, since anyone able to read the Keychain would
// also hold the seed, which is the real fund protection.
const SERVICE = 'com.voltz.wallet.pin'
const PIN_LENGTH = 6

export function validatePinFormat(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)
}

export async function savePin(pin: string): Promise<void> {
  if (!validatePinFormat(pin)) {
    throw new Error('invalid pin')
  }
  await Keychain.setGenericPassword('pin', pin, {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
}

export async function hasPin(): Promise<boolean> {
  return (await Keychain.getGenericPassword({ service: SERVICE })) !== false
}

// The only way to take the PIN away, and only after no seed is left: a seed with no PIN opens at the
// PIN step, which would hand the wallet to whoever holds the phone (`eraseAllWallets`). The next PIN
// starts with no wrong attempts behind it.
export async function deletePin(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE })
  // Not behind the check queue: an erase must not wait on a check whose read may never answer.
  await resetFailures()
}

// A comparison alone, for a PIN the app holds (the copy biometric unlock releases). A PIN typed on the
// keypad goes through `enterPin`, which counts it.
export async function verifyPin(pin: string): Promise<boolean> {
  const stored = await Keychain.getGenericPassword({ service: SERVICE })
  return stored !== false && stored.password === pin
}

// Wrong PINs typed in a row, kept beside the PIN so that closing the app forgets none of them. Six
// digits fall to automation in days at a few tries a second, so after FREE_ATTEMPTS each wrong PIN
// waits twice as long as the one before, up to an hour: about 24 tries a day once the wait tops out.
// Nothing is erased, since the words may be the only copy and a child with the phone would cost them.
// Phoenix waits the same way (CheckPinViewModel.kt, 10 s up to 30 min).
const FAILURES = 'com.voltz.wallet.pin.failures'
export const FREE_ATTEMPTS = 5
const FIRST_WAIT_MS = 30_000
const LONGEST_WAIT_MS = 60 * 60_000

// How long the keypad waits after this many wrong PINs in a row.
export function waitAfter(failures: number): number {
  if (failures < FREE_ATTEMPTS) {
    return 0
  }
  return Math.min(FIRST_WAIT_MS * 2 ** (failures - FREE_ATTEMPTS), LONGEST_WAIT_MS)
}

// The count as this process knows it, read once and then kept with every write, so a Keychain that
// fails to read or write the count never takes the wait away while the process lives. null until the
// first read.
let held: number | null = null

const reason = (err: unknown): string => (err as Error)?.message ?? String(err)

async function readFailures(): Promise<number> {
  if (held !== null) {
    return held
  }
  try {
    const stored = await Keychain.getGenericPassword({ service: FAILURES })
    const failures = stored === false ? 0 : Number(stored.password)
    // An unreadable count waits as the first wait does rather than as none.
    held = Number.isInteger(failures) && failures >= 0 ? failures : FREE_ATTEMPTS
  } catch (err) {
    console.warn(`pin failures not read: ${reason(err)}`)
    held = FREE_ATTEMPTS
  }
  return held
}

async function writeFailures(failures: number): Promise<void> {
  held = failures
  try {
    await Keychain.setGenericPassword('failures', String(failures), {
      service: FAILURES,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    })
  } catch (err) {
    console.warn(`pin failures not written: ${reason(err)}`)
  }
}

async function resetFailures(): Promise<void> {
  held = 0
  waitEnds = null
  await Keychain.resetGenericPassword({ service: FAILURES })
}

// For an unlock that did not go through the keypad. Waits for any check under way, which would
// otherwise write its count over this clear.
export function clearPinFailures(): Promise<void> {
  return inTurn(resetFailures)
}

// The wait runs on the steady clock of this process, which Settings cannot move, never on the wall
// clock, which a person with the phone can set forward past it. A new process starts the whole wait for
// the count again, so closing the app never shortens one.
const steadyNow = (): number => performance.now()
// Whether this process has read the count, and when the wait it runs ends, if one runs.
let countRead = false
let waitEnds: number | null = null

function startWait(ms: number): void {
  waitEnds = ms > 0 ? steadyNow() + ms : null
}

// What is left of the wait before the keypad takes a PIN, in milliseconds.
export async function pinWaitLeft(): Promise<number> {
  if (!countRead) {
    startWait(waitAfter(await readFailures()))
    countRead = true
  }
  return waitEnds === null ? 0 : Math.max(0, waitEnds - steadyNow())
}

// `waiting` marks a PIN refused unread because a wait runs, which says nothing about the PIN.
export type PinEntry = { ok: true } | { ok: false; waitMs: number; waiting?: true }

// The keypad's check. Refuses without comparing while a wait runs. Counts the attempt before it
// compares, so a process ended between the two has still counted it, and clears the count on a match.
// Checks run one at a time, each reading the wait and the count after the one before has written
// them: two run together would both read the same count and both be compared, and every PIN typed
// while one check runs would get past the wait it is about to start.
let checks: Promise<unknown> = Promise.resolve()

function inTurn<T>(step: () => Promise<T>): Promise<T> {
  const turn = checks.then(step)
  checks = turn.catch(() => undefined)
  return turn
}

export function enterPin(pin: string): Promise<PinEntry> {
  return inTurn(() => checkPin(pin))
}

async function checkPin(pin: string): Promise<PinEntry> {
  const left = await pinWaitLeft()
  if (left > 0) {
    return { ok: false, waitMs: left, waiting: true }
  }
  const failures = (await readFailures()) + 1
  await writeFailures(failures)
  if (await verifyPin(pin)) {
    // The process holds the cleared count whether or not the Keychain takes it.
    await resetFailures().catch((err: unknown) => console.warn(`pin failures not cleared: ${reason(err)}`))
    return { ok: true }
  }
  const wait = waitAfter(failures)
  startWait(wait)
  return { ok: false, waitMs: wait }
}
