import type { Spec } from '../NativeVoltzPrivacy'

// The native side under Jest, wired by jest.setup.js and put back before each test. It keeps what the
// iOS and Android code keep: the stamp the leave callback takes on the boot clock, whether the cover is
// up, and the depth of the activities the app started itself. A test calls `leave()` where the platform
// would run its callback, before the JS 'background' event, and moves the boot clock by hand; it knows
// nothing of Date.now() or performance.now(), as the device's does not. Tests reach it through
// jest.requireMock, since importing this file directly yields a second instance that the code under
// test never sees.

const START = 5_000_000

export const device = {
  // The boot clock, which counts sleep and which nothing can set.
  clockMs: START,
  // A clock that reads zero, as one the platform could not read.
  clockFails: false,
  leftAt: null as number | null,
  ownLeftAt: null as number | null,
  ownDepth: 0,
  covered: false,
  hides: 0,
  // Whether the app is in front when the JS side asks (Android: onPostResume has run).
  inFront: true,
  // Something UIKit presented over the app that is not a React Native Modal, such as the share sheet.
  presented: false,
  dismissals: 0,
  // Android's Dialog windows under the cover, which a test sets where a device has them: those on
  // screen, and those removed and still playing the exit animation the platform runs after the app has
  // let go of them. A hide never lowers the cover over one leaving; a hide after the lock
  // (hideCoverAfterModals) also waits for those on screen, which the lock has closed in JS and the
  // commit has yet to remove. The native side lifts anyway after a short wait for one that stays, which
  // the JS side cannot see.
  windowsUp: 0,
  windowsLeaving: 0,
  // The hide waiting on them.
  heldLift: null as 'plain' | 'afterModals' | null,
  advance(ms: number): void {
    device.clockMs += ms
  },
  read(): number {
    return device.clockFails ? 0 : device.clockMs
  },
  // The commit removes the windows on screen, and their exits begin.
  removeWindows(): void {
    device.windowsLeaving += device.windowsUp
    device.windowsUp = 0
    device.settleLift()
  },
  // The last exit under way ends.
  endExits(): void {
    device.windowsLeaving = 0
    device.settleLift()
  },
  settleLift(): void {
    const held = device.heldLift
    if (held === null || device.windowsLeaving > 0 || (held === 'afterModals' && device.windowsUp > 0)) {
      return
    }
    device.heldLift = null
    device.covered = false
  },
  // applicationDidEnterBackground, or onPause before super: the first leave of each kind since the last
  // take keeps its stamp, and a leave to the app's own activity raises nothing.
  leave(): void {
    // A leave drops a hide still held, as the native side drops one queued before it.
    device.heldLift = null
    if (device.ownDepth > 0) {
      if (device.ownLeftAt === null) {
        device.ownLeftAt = device.read()
      }
      return
    }
    if (device.leftAt === null) {
      device.leftAt = device.read()
    }
    device.covered = true
  },
  reset(): void {
    device.clockMs = START
    device.clockFails = false
    device.leftAt = null
    device.ownLeftAt = null
    device.ownDepth = 0
    device.covered = false
    device.hides = 0
    device.inFront = true
    device.presented = false
    device.dismissals = 0
    device.windowsUp = 0
    device.windowsLeaving = 0
    device.heldLift = null
  },
}

const NativeVoltzPrivacy: Spec = {
  takeAway: () => {
    const now = device.read()
    const since = (stamp: number | null): number =>
      stamp === null ? -1 : stamp <= 0 || now <= 0 || now < stamp ? -2 : now - stamp
    const trips = { left: since(device.leftAt), own: since(device.ownLeftAt) }
    device.leftAt = null
    device.ownLeftAt = null
    return trips
  },
  // A hide that finds the app away does nothing, as both native sides drop it (PrivacyCover.hide on
  // Android, VoltzPrivacyCover.hide on iOS): it belongs to a return that is over.
  hideCover: () => {
    device.hides += 1
    if (!device.inFront) {
      return
    }
    device.heldLift = 'plain'
    device.settleLift()
  },
  hideCoverAfterModals: () => {
    device.hides += 1
    if (!device.inFront) {
      return
    }
    device.heldLift = 'afterModals'
    device.settleLift()
  },
  whenInFront: async () => device.inFront,
  beginOwnActivity: () => {
    device.ownDepth += 1
  },
  endOwnActivity: () => {
    device.ownDepth = Math.max(0, device.ownDepth - 1)
  },
  dismissPresented: async () => {
    device.dismissals += 1
    device.presented = false
  },
  getConstants: () => ({}),
} as Spec

export default NativeVoltzPrivacy
