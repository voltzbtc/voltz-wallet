import * as Keychain from 'react-native-keychain'
import {
  validatePinFormat,
  savePin,
  verifyPin,
  hasPin,
  deletePin,
  enterPin,
  pinWaitLeft,
  waitAfter,
  FREE_ATTEMPTS,
  forgetPinWaitForTests,
} from '../src/wallet/pin'

describe('validatePinFormat', () => {
  it('accepts 6 digits', () => {
    expect(validatePinFormat('123456')).toBe(true)
  })

  it('rejects fewer than 6 digits', () => {
    expect(validatePinFormat('12345')).toBe(false)
  })

  it('rejects more than 6 digits', () => {
    expect(validatePinFormat('1234567')).toBe(false)
  })

  it('rejects letters', () => {
    expect(validatePinFormat('12345a')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(validatePinFormat('')).toBe(false)
  })

  it('rejects space in the middle', () => {
    expect(validatePinFormat('12 456')).toBe(false)
  })
})

describe('savePin', () => {
  beforeEach(() => jest.clearAllMocks())

  it('refuses invalid format without saving', async () => {
    await expect(savePin('12ab')).rejects.toThrow('invalid pin')
    expect(Keychain.setGenericPassword).not.toHaveBeenCalled()
  })

  it('saves a valid PIN', async () => {
    await savePin('123456')
    expect(Keychain.setGenericPassword).toHaveBeenCalled()
  })
})

describe('verifyPin', () => {
  beforeEach(() => jest.clearAllMocks())

  it('accepts the correct PIN', async () => {
    jest.mocked(Keychain.getGenericPassword).mockResolvedValue({ password: '123456' } as never)
    expect(await verifyPin('123456')).toBe(true)
  })

  it('rejects the wrong PIN', async () => {
    jest.mocked(Keychain.getGenericPassword).mockResolvedValue({ password: '123456' } as never)
    expect(await verifyPin('000000')).toBe(false)
  })

  it('rejects when there is no PIN stored', async () => {
    jest.mocked(Keychain.getGenericPassword).mockResolvedValue(false as never)
    expect(await verifyPin('123456')).toBe(false)
  })
})

describe('hasPin', () => {
  beforeEach(() => jest.clearAllMocks())

  it('true when there is a PIN stored', async () => {
    jest.mocked(Keychain.getGenericPassword).mockResolvedValue({ password: '123456' } as never)
    expect(await hasPin()).toBe(true)
  })

  it('false when there is none', async () => {
    jest.mocked(Keychain.getGenericPassword).mockResolvedValue(false as never)
    expect(await hasPin()).toBe(false)
  })
})

describe('the wait after wrong PINs', () => {
  it('lets a person mistype a few times, then doubles from 30 s up to an hour', () => {
    expect([0, 1, 2, 3, 4].map(waitAfter)).toEqual([0, 0, 0, 0, 0])
    expect(FREE_ATTEMPTS).toBe(5)
    expect(waitAfter(5)).toBe(30_000)
    expect(waitAfter(6)).toBe(60_000)
    expect(waitAfter(9)).toBe(8 * 60_000)
    expect(waitAfter(12)).toBe(60 * 60_000)
    expect(waitAfter(40)).toBe(60 * 60_000)
  })
})

describe('typing a PIN on the keypad', () => {
  const PIN = 'com.voltz.wallet.pin'
  const FAILURES = 'com.voltz.wallet.pin.failures'
  const keychain = new Map<string, string>()
  let steady = 1_000

  beforeEach(() => {
    jest.clearAllMocks()
    keychain.clear()
    keychain.set(PIN, '123456')
    steady = 1_000
    forgetPinWaitForTests()
    jest.spyOn(performance, 'now').mockImplementation(() => steady)
    jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
      const password = keychain.get(options?.service ?? '')
      return password === undefined ? false : ({ username: 'u', password } as never)
    })
    jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
      keychain.set(options?.service ?? '', password)
      return false
    })
    jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options =>
      keychain.delete(options?.service ?? ''),
    )
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const wrongTimes = async (times: number): Promise<void> => {
    for (let i = 0; i < times; i++) {
      steady += 60 * 60_000
      await enterPin('000000')
    }
  }

  // Each Keystore read and write takes its own time on a device, and a person types faster than that.
  it('checks PINs typed together one at a time, so the fifth wrong one stops the next', async () => {
    const slow = jest.mocked(Keychain.getGenericPassword).getMockImplementation()!
    jest.mocked(Keychain.getGenericPassword).mockImplementation(
      options => new Promise(resolve => setTimeout(() => resolve(slow(options)), 1)),
    )
    await wrongTimes(4)
    const compared = () =>
      jest.mocked(Keychain.getGenericPassword).mock.calls.filter(([options]) => options?.service === PIN).length
    const before = compared()
    const answers = await Promise.all(['000000', '000001', '000002', '123456'].map(pin => enterPin(pin)))
    expect(answers).toEqual([
      { ok: false, waitMs: 30_000 },
      { ok: false, waitMs: 30_000 },
      { ok: false, waitMs: 30_000 },
      { ok: false, waitMs: 30_000 },
    ])
    expect(compared() - before).toBe(1)
    expect(keychain.get(FAILURES)).toBe('5')
  })

  it('opens with the right PIN and clears the count', async () => {
    await wrongTimes(3)
    expect(keychain.get(FAILURES)).toBe('3')
    expect(await enterPin('123456')).toEqual({ ok: true })
    expect(keychain.has(FAILURES)).toBe(false)
  })

  // Without a limit six digits fall to automation in days at a few tries a second.
  it('waits after the fifth wrong PIN and takes no PIN, not even the right one, until the wait ends', async () => {
    await wrongTimes(4)
    expect(await enterPin('000000')).toEqual({ ok: false, waitMs: 30_000 })
    const reads = jest.mocked(Keychain.getGenericPassword).mock.calls.length
    expect(await enterPin('123456')).toEqual({ ok: false, waitMs: 30_000 })
    // Refused before anything was compared or counted.
    expect(jest.mocked(Keychain.getGenericPassword).mock.calls.length).toBe(reads)
    expect(keychain.get(FAILURES)).toBe('5')

    steady += 29_999
    expect(await pinWaitLeft()).toBe(1)
    steady += 1
    expect(await enterPin('123456')).toEqual({ ok: true })
  })

  it('doubles the wait with each wrong PIN after that', async () => {
    await wrongTimes(5)
    steady += 30_000
    expect(await enterPin('000000')).toEqual({ ok: false, waitMs: 60_000 })
  })

  it('is not shortened by setting the clock forward, since the wait runs on the steady clock', async () => {
    await wrongTimes(5)
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60_000)
    expect(await pinWaitLeft()).toBe(30_000)
    expect(await enterPin('123456')).toEqual({ ok: false, waitMs: 30_000 })
  })

  it('is not shortened by closing the app: a new process waits the whole wait again', async () => {
    await wrongTimes(5)
    steady += 20_000
    forgetPinWaitForTests()
    expect(await pinWaitLeft()).toBe(30_000)
  })

  it('counts the attempt before it compares, so ending the app mid-check still counted it', async () => {
    jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
      if (options?.service === PIN) {
        throw new Error('process ended')
      }
      const password = keychain.get(options?.service ?? '')
      return password === undefined ? false : ({ username: 'u', password } as never)
    })
    await expect(enterPin('000000')).rejects.toThrow('process ended')
    expect(keychain.get(FAILURES)).toBe('1')
  })

  it('waits as the first wait does for a count it cannot read', async () => {
    keychain.set(FAILURES, 'garbled')
    expect(await pinWaitLeft()).toBe(30_000)
  })

  it('starts the next PIN with no wrong attempts behind it once the PIN is erased', async () => {
    await wrongTimes(5)
    await deletePin()
    expect(keychain.has(FAILURES)).toBe(false)
    expect(await pinWaitLeft()).toBe(0)
  })
})
