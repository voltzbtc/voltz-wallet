import fs from 'fs'
import path from 'path'
import {
  AGE_WAIT_MS,
  __resetAgeSignalForTests,
  ageVerdictNow,
  askAgeSignal,
  isAgeRefusal,
  minorBySignal,
  onAgeVerdict,
  refuseMinor,
  verdictOf,
} from '../src/wallet/ageSignal'

type AgeStore = typeof import('../specs/__mocks__/NativeVoltzAge').ageStore
const store: AgeStore = jest.requireMock('../specs/NativeVoltzAge').ageStore
const privacy: { device: { ownDepth: number } } = jest.requireMock('../specs/NativeVoltzPrivacy')

const ROOT = path.join(__dirname, '..')
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8')

beforeEach(() => {
  __resetAgeSignalForTests()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('verdictOf', () => {
  test.each([
    [0, 12],
    [13, 15],
    [16, 17],
    // Apple's answer to a single gate of 18 leaves the floor open.
    [-1, 17],
  ])('a shared range [%i, %i] is a minor', (lower, upper) => {
    expect(verdictOf({ status: 'shared', lower, upper })).toBe('minor')
  })

  test.each([
    [18, -1],
    [18, 20],
    [21, -1],
  ])('a shared range [%i, %i] is an adult', (lower, upper) => {
    expect(verdictOf({ status: 'shared', lower, upper })).toBe('adult')
  })

  // A range open at both ends is what Play answers for a verified adult who shares nothing, and a top
  // of 18 says the person may be 17.
  test.each([
    [-1, -1],
    [16, 18],
    [17, -1],
    [Number.NaN, 12.5],
  ])('a shared range [%d, %d] says nothing', (lower, upper) => {
    expect(verdictOf({ status: 'shared', lower, upper })).toBe('unknown')
  })

  test.each(['notShared', 'verificationRequired', 'unspecified', ''])('a %s answer says nothing, whatever its bounds', status => {
    expect(verdictOf({ status, lower: 13, upper: 15 })).toBe('unknown')
  })
})

describe('asking', () => {
  // Only a person the store marks as regulated is asked, so nobody else sees a prompt.
  test('a person the store does not mark as regulated is asked nothing further', async () => {
    store.regulated(false)
    store.answers({ status: 'shared', lower: 13, upper: 15 })
    expect(await askAgeSignal()).toBe('unknown')
    expect(store.calls).toEqual({ regulated: 1, request: 0 })
    expect(await minorBySignal()).toBe(false)
  })

  test('a regulated person is asked once per launch, however many ask', async () => {
    store.shares(13, 15)
    const answers = await Promise.all([askAgeSignal(), askAgeSignal(), minorBySignal()])
    await askAgeSignal()
    expect(answers).toEqual(['minor', 'minor', true])
    expect(store.calls).toEqual({ regulated: 1, request: 1 })
  })

  // Play's prompt pauses the activity, which the lock times as the app's own.
  test('the request is bracketed as an activity of the app itself', async () => {
    store.regulated(true)
    let depth = -1
    store.answers({ status: 'shared', lower: 18, upper: -1 })
    const native = jest.requireMock('../specs/NativeVoltzAge').default
    const request = native.request
    native.request = () => {
      depth = privacy.device.ownDepth
      return request()
    }
    try {
      expect(await askAgeSignal()).toBe('adult')
    } finally {
      native.request = request
    }
    expect(depth).toBe(1)
    expect(privacy.device.ownDepth).toBe(0)
  })

  test('listeners hear the verdict once it lands, and the verdict is kept for the launch', async () => {
    store.shares(13, 15)
    const heard = jest.fn()
    const off = onAgeVerdict(heard)
    expect(ageVerdictNow()).toBeNull()
    await askAgeSignal()
    off()
    expect(heard).toHaveBeenCalledTimes(1)
    expect(ageVerdictNow()).toBe('minor')
  })

  // A failed, absent or unsupported answer never blocks.
  test('a regulated check that fails asks nothing further and blocks nothing', async () => {
    store.regulatedFails('play-3')
    expect(await askAgeSignal()).toBe('unknown')
    expect(store.calls.request).toBe(0)
    await expect(refuseMinor()).resolves.toBeUndefined()
  })

  test('a request that fails blocks nothing', async () => {
    store.regulated(true)
    store.requestFails('play-1')
    expect(await askAgeSignal()).toBe('unknown')
    await expect(refuseMinor()).resolves.toBeUndefined()
  })

  test('a declined share blocks nothing', async () => {
    store.regulated(true)
    store.answers({ status: 'notShared', lower: -1, upper: -1 })
    expect(await minorBySignal()).toBe(false)
  })

  test('Play asking for verification first blocks nothing', async () => {
    store.regulated(true)
    store.answers({ status: 'verificationRequired', lower: -1, upper: -1 })
    expect(await minorBySignal()).toBe(false)
  })

  // A binary without the module (a platform with none, an install built before it).
  test('no native module asks nothing and blocks nothing', async () => {
    const double = jest.requireMock('../specs/NativeVoltzAge')
    const present = double.default
    store.shares(13, 15)
    double.default = null
    try {
      expect(await askAgeSignal()).toBe('unknown')
      expect(await minorBySignal()).toBe(false)
    } finally {
      double.default = present
    }
    expect(store.calls).toEqual({ regulated: 0, request: 0 })
  })

  test('an ask still in flight after the wait counts as nothing known, and its answer counts after', async () => {
    jest.useFakeTimers()
    store.shares(13, 15)
    store.holds()
    const waited = minorBySignal()
    await jest.advanceTimersByTimeAsync(AGE_WAIT_MS)
    expect(await waited).toBe(false)
    store.release()
    await jest.advanceTimersByTimeAsync(0)
    expect(await minorBySignal()).toBe(true)
  })

  test('a gated write is refused for a minor, with a message that names no age', async () => {
    store.shares(16, 17)
    const refusal = await refuseMinor().catch((err: unknown) => err)
    expect(isAgeRefusal(refusal)).toBe(true)
    expect((refusal as Error).message).toBe('refused')
  })

  test('a gated write goes on for an adult', async () => {
    store.shares(18, -1)
    await expect(refuseMinor()).resolves.toBeUndefined()
  })
})

// The signal never leaves the device, is never logged and is never kept past the launch.
describe('where the signal goes', () => {
  const READERS = ['src/wallet/ageSignal.ts', 'src/hooks/useMinorSignal.ts']
  const NATIVE = [
    'android/app/src/main/java/app/usevoltz/age/NativeVoltzAgeModule.kt',
    'ios/VoltzWallet/Age/VoltzAgeCore.swift',
    'ios/VoltzWallet/Age/RCTNativeVoltzAge.mm',
  ]

  function sources(dir: string): string[] {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
      const rel = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        return sources(rel)
      }
      return /\.tsx?$/.test(entry.name) ? [rel] : []
    })
  }

  test('its readers write, send and log nothing', () => {
    for (const file of READERS) {
      const code = read(file)
      expect({ file, hit: code.match(/console\.|fetch\(|XMLHttpRequest|react-native-fs|durableFile|Keychain|AsyncStorage|Settings\.set|writeFile/g) }).toEqual({ file, hit: null })
    }
  })

  test('the native modules log and keep nothing', () => {
    for (const file of NATIVE) {
      const code = read(file)
      expect({ file, hit: code.match(/\bLog\.|println|NSLog|\bprint\(|os_log|Logger\(|UserDefaults|SharedPreferences|NSUserDefaults|writeTo|FileManager/g) }).toEqual({ file, hit: null })
    }
  })

  // The range reaches JS only through ageSignal.ts, which keeps the verdict alone, and only the gates
  // read the verdict. A new reader is a change to review.
  test('only the reader takes the native answer, and only the gates take the verdict', () => {
    const all = [...sources('src'), 'App.tsx']
    const native = all.filter(file => /specs\/NativeVoltzAge['"]/.test(read(file)))
    expect(native).toEqual(['src/wallet/ageSignal.ts'])
    const verdict = all.filter(file => /['"](?:\.\.?\/)+(?:src\/)?(?:wallet\/ageSignal|hooks\/useMinorSignal|ageSignal|useMinorSignal)['"]/.test(read(file))).sort()
    expect(verdict).toEqual(
      [
        'App.tsx',
        'src/hooks/useMinorSignal.ts',
        'src/screens/AddWalletScreen.tsx',
        'src/wallet/storePurchase.ts',
        'src/wallet/wallet.ts',
      ].sort(),
    )
  })

  // Nothing on the way to a wallet that exists reads the signal, so Send, Receive, the words and
  // the emergency exit work whatever it says.
  test('the screens of a wallet that exists never read it', () => {
    for (const file of [
      'src/screens/SendScreen.tsx',
      'src/screens/SendSpark.tsx',
      'src/screens/ReceiveSpark.tsx',
      'src/screens/RecoveryPhraseScreen.tsx',
      'src/screens/EmergencyExitScreen.tsx',
      'src/screens/HomeScreen.tsx',
      'src/navigation/RootNavigator.tsx',
    ]) {
      expect({ file, reads: /ageSignal|useMinorSignal|AdultsOnly/.test(read(file)) }).toEqual({ file, reads: false })
    }
  })
})
