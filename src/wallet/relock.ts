import NativeVoltzPrivacy from '../../specs/NativeVoltzPrivacy'

// How long the app may stay in the background before the PIN is asked again on its return.
export const RELOCK_AFTER_MS = 120_000

// The same for a trip that began while one of the app's own activities was open (Android pauses the
// app for a picker, the camera, a permission dialog, the biometric, passkey or store prompt). Nothing
// is heard when Home is pressed inside one, so the trip is timed from the activity's start: a long pick
// asks nothing, while a return hours later locks. PrivacyCover.kt keeps the same figure to cover such a
// return.
export const RELOCK_AFTER_OWN_MS = 600_000

// What the native side recorded about the latest trip away. `unreadable` is a binary without the
// module or a read that threw; `failed` is a stamp whose clock read zero or ran backwards. An `away`
// carries the trip from the app's own screens (`ms`), the trip from inside its own activities
// (`ownMs`), or both.
export type Away =
  | { kind: 'none' }
  | { kind: 'failed' }
  | { kind: 'unreadable' }
  | { kind: 'away'; ms?: number; ownMs?: number }

// The codes takeAway answers with for each trip, as the spec documents them.
const NO_LEAVE = -1

type Trip = number | 'none' | 'failed' | 'unreadable'

function tripOf(code: unknown): Trip {
  if (typeof code !== 'number' || !Number.isFinite(code)) {
    return 'unreadable'
  }
  if (code === NO_LEAVE) {
    return 'none'
  }
  return code >= 0 ? code : 'failed'
}

export function readAway(): Away {
  let trips: unknown
  try {
    if (!NativeVoltzPrivacy) {
      return { kind: 'unreadable' }
    }
    trips = NativeVoltzPrivacy.takeAway()
  } catch {
    return { kind: 'unreadable' }
  }
  if (typeof trips !== 'object' || trips === null) {
    return { kind: 'unreadable' }
  }
  const left = tripOf((trips as { left?: unknown }).left)
  const own = tripOf((trips as { own?: unknown }).own)
  if (left === 'unreadable' || own === 'unreadable') {
    return { kind: 'unreadable' }
  }
  if (left === 'failed' || own === 'failed') {
    return { kind: 'failed' }
  }
  if (left === 'none' && own === 'none') {
    return { kind: 'none' }
  }
  return {
    kind: 'away',
    ...(typeof left === 'number' ? { ms: left } : {}),
    ...(typeof own === 'number' ? { ownMs: own } : {}),
  }
}

// Whether the return asks the PIN again. Time away is the native stamp's alone, on a clock that counts
// sleep and that Settings cannot set, so a wall clock set back changes nothing. `left` is whether the JS
// side heard 'background' since the last decision: with it, a trip the native side did not stamp, or a
// clock that cannot be read, locks, while without it ('inactive' alone, the Face ID prompt, the app
// switcher) nothing left. Either trip at its own limit locks.
export function mustLock(away: Away, left: boolean): boolean {
  switch (away.kind) {
    case 'away':
      return (
        (away.ms !== undefined && away.ms >= RELOCK_AFTER_MS) ||
        (away.ownMs !== undefined && away.ownMs >= RELOCK_AFTER_OWN_MS)
      )
    case 'failed':
      return true
    case 'none':
    case 'unreadable':
      return left
  }
}

// Lowers the native cover. The native side keeps it up for its quarter of a second and ignores a hide
// that finds the app away again.
export function liftCover(): void {
  try {
    NativeVoltzPrivacy?.hideCover()
  } catch {
    // Nothing to lower without the module.
  }
}

// Lowers the native cover after the lock has closed every Modal. Android plays a closed Dialog's exit
// animation after the app has let go of it, with the theme fixed when the Dialog was made, so a sheet
// closed in the commit that drew the PIN would slide out over the PIN once the cover came down; the
// native side keeps the cover up until each Modal window under it has gone and its exit has ended.
// iOS lowers it at once.
export function liftCoverAfterModals(): void {
  try {
    if (NativeVoltzPrivacy) {
      NativeVoltzPrivacy.hideCoverAfterModals()
    }
  } catch {
    // A binary without the method still lowers the cover.
    liftCover()
  }
}

// Resolves once the app is in front for good (Android: after onPostResume, when a biometric prompt
// may be shown), or false when it left again first. Without the module there is nothing to wait for.
export async function whenInFront(): Promise<boolean> {
  try {
    return NativeVoltzPrivacy ? await NativeVoltzPrivacy.whenInFront() : true
  } catch {
    return true
  }
}

// iOS presents the share sheet, ActionSheetIOS and the photo picker over the app's whole view, so the
// lock dismisses them before it is drawn. A failure leaves them, and the lock is drawn anyway.
export async function dismissPresented(): Promise<void> {
  try {
    await NativeVoltzPrivacy?.dismissPresented()
  } catch {
    // The lock does not wait on a dismissal that failed.
  }
}

// Runs an activity the app starts itself (a picker, the camera, a permission dialog, the biometric,
// passkey or store prompt), during which Android pauses the app as if the person had left it. The
// native side times a leave while one runs against RELOCK_AFTER_OWN_MS, so a prompt over the lock does
// not relock under the unlock it is completing and a few minutes in a picker ask nothing, while a bracket
// that never closes still leaves every trip timed. iOS shows these inside the app, and its native side
// ignores the bracket.
export async function asOwnActivity<T>(start: () => Promise<T>): Promise<T> {
  try {
    NativeVoltzPrivacy?.beginOwnActivity()
  } catch {
    // Without the bracket the activity counts as a leave, which can only ask the PIN once more.
  }
  try {
    return await start()
  } finally {
    try {
      NativeVoltzPrivacy?.endOwnActivity()
    } catch {
      // As above.
    }
  }
}
