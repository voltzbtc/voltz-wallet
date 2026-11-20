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
  await clearPinFailures()
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

async function readFailures(): Promise<number> {
  const stored = await Keychain.getGenericPassword({ service: FAILURES })
  if (stored === false) {
    return 0
  }
  const failures = Number(stored.password)
  // An unreadable count waits as the first wait does rather than as none.
  return Number.isInteger(failures) && failures >= 0 ? failures : FREE_ATTEMPTS
}

async function writeFailures(failures: number): Promise<void> {
  await Keychain.setGenericPassword('failures', String(failures), {
    service: FAILURES,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
}

export async function clearPinFailures(): Promise<void> {
  await Keychain.resetGenericPassword({ service: FAILURES })
  waitEnds = null
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

export type PinEntry = { ok: true } | { ok: false; waitMs: number }

// The keypad's check. Refuses without comparing while a wait runs. Counts the attempt before it
// compares, so a process ended between the two has still counted it, and clears the count on a match.
// Checks run one at a time, each reading the wait and the count after the one before has written
// them: two run together would both read the same count and both be compared, and every PIN typed
// while one check runs would get past the wait it is about to start.
let checks: Promise<unknown> = Promise.resolve()

export function enterPin(pin: string): Promise<PinEntry> {
  const turn = checks.then(() => checkPin(pin))
  checks = turn.catch(() => undefined)
  return turn
}

async function checkPin(pin: string): Promise<PinEntry> {
  const left = await pinWaitLeft()
  if (left > 0) {
    return { ok: false, waitMs: left }
  }
  const failures = (await readFailures()) + 1
  await writeFailures(failures)
  if (await verifyPin(pin)) {
    await clearPinFailures()
    return { ok: true }
  }
  const wait = waitAfter(failures)
  startWait(wait)
  return { ok: false, waitMs: wait }
}

// Forgets this process's read of the count, as a new process starts, which only tests need.
export function forgetPinWaitForTests(): void {
  countRead = false
  waitEnds = null
}
