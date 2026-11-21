import { readFileSync } from 'fs'
import { join } from 'path'
import { Platform } from 'react-native'
import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import { validateMnemonic } from 'bip39'
import {
  PASSKEY_LABEL,
  PASSKEY_LIVE,
  PASSKEY_RP_ID,
  PASSKEY_RP_NAME,
  __setPasskeyLiveForTests,
  checkPasskey,
  markPasskeyUnavailable,
  passkeyAttempt,
  passkeyAvailable,
  passkeyFailureKind,
  passkeyLive,
  passkeyWalletStored,
  type PasskeyEntry,
} from '../src/wallet/passkey'
import { fingerprintFromMnemonicAsync } from '../src/wallet/fingerprint'

// The manual mock's own exports, which the real binding's types do not have.
const {
  PasskeyClient,
  __authenticator: auth,
  __clients,
  __hangs,
  __labelsPublished,
  __nativeModuleTouched,
  __panics,
} = require('@breeztech/breez-sdk-spark-react-native/passkey-prf-provider') as typeof import('../__mocks__/@breeztech/breez-sdk-spark-react-native/passkey-prf-provider')

const failure = (run: () => Promise<unknown>) =>
  run().then(
    () => {
      throw new Error('the ceremony resolved')
    },
    (err: unknown) => passkeyFailureKind(err),
  )

function setPlatform(os: string, version: string | number): void {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os })
  Object.defineProperty(Platform, 'Version', { configurable: true, get: () => version })
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  auth.reset()
  setPlatform('ios', '18.2')
  __setPasskeyLiveForTests(true)
})

afterEach(() => {
  __setPasskeyLiveForTests(false)
  jest.useRealTimers()
})

describe('the switch', () => {
  test('ships on', () => {
    expect(PASSKEY_LIVE).toBe(true)
  })

  test('the seam does nothing outside a test build', () => {
    __setPasskeyLiveForTests(false)
    expect(passkeyLive()).toBe(false)
    const dev = (globalThis as { __DEV__?: boolean }).__DEV__
    try {
      ;(globalThis as { __DEV__?: boolean }).__DEV__ = false
      __setPasskeyLiveForTests(false)
      expect(passkeyLive()).toBe(PASSKEY_LIVE)
      __setPasskeyLiveForTests(!PASSKEY_LIVE)
      expect(passkeyLive()).toBe(PASSKEY_LIVE)
    } finally {
      ;(globalThis as { __DEV__?: boolean }).__DEV__ = dev
    }
    __setPasskeyLiveForTests(false)
    expect(passkeyLive()).toBe(false)
    __setPasskeyLiveForTests(null)
    expect(passkeyLive()).toBe(PASSKEY_LIVE)
    // NODE_ENV is written into the bundle at build time, so it can only be read here.
    expect(readFileSync(join(__dirname, '../src/wallet/passkey.ts'), 'utf8')).toContain(
      "forcedLive = __DEV__ && process.env.NODE_ENV === 'test' ? on : null",
    )
  })

  test('off, a ceremony and the availability check never reach the native module', async () => {
    __setPasskeyLiveForTests(false)
    const before = __nativeModuleTouched()
    await expect(passkeyAvailable()).resolves.toBe(false)
    await expect(failure(passkeyAttempt('connect'))).resolves.toBe('unavailable')
    expect(__nativeModuleTouched()).toBe(before)
    expect(__clients).toHaveLength(0)
  })
})

describe('reaching the provider', () => {
  const source = readFileSync(join(__dirname, '../src/wallet/passkey.ts'), 'utf8')
  const code = source.replace(/^\s*\/\/.*$/gm, '')
  const PROVIDER = '@breeztech/breez-sdk-spark-react-native/passkey-prf-provider'

  // A require resolves by the package's commonjs condition and loads a second copy of the bindings.
  test('goes by a dynamic import, so Metro resolves it by the same condition as the rest of the SDK', () => {
    expect(code).toContain(`import('${PROVIDER}')`)
    expect(code).not.toMatch(/\brequire\s*\(/)
  })

  test('never by a static import, which would load it with the app on any device', () => {
    expect(code).not.toMatch(new RegExp(`\\bfrom\\s+'${PROVIDER}'`))
  })
})

describe('the constants that decide every wallet', () => {
  test('hold their values', () => {
    expect(PASSKEY_RP_ID).toBe('usevoltz.app')
    expect(PASSKEY_RP_NAME).toBe('Voltz')
    expect(PASSKEY_LABEL).toBe('Default')
  })

  test.each(['connect', 'register', 'restore'] as const)('reach the client and the system in %s', async mode => {
    if (mode === 'restore') {
      await passkeyAttempt('register')()
      auth.rpIdsAsked = []
      __clients.length = 0
    }
    await passkeyAttempt(mode)()

    expect(__clients).toHaveLength(1)
    const { config } = __clients[0]
    expect(config?.defaultLabel).toBe('Default')
    expect(config?.providerOptions?.rpId).toBe('usevoltz.app')
    expect(config?.providerOptions?.rpName).toBe('Voltz')
    expect(new Set(auth.rpIdsAsked)).toEqual(new Set(['usevoltz.app']))
  })

  test('the test of a passkey uses them too', async () => {
    const made = await passkeyAttempt('register')()
    auth.rpIdsAsked = []
    __clients.length = 0
    await checkPasskey(entryOf(made, await fingerprintFromMnemonicAsync(made.mnemonic)))
    expect(__clients[0].config?.providerOptions?.rpId).toBe('usevoltz.app')
    expect(__clients[0].config?.defaultLabel).toBe('Default')
    expect(auth.rpIdsAsked).toEqual(['usevoltz.app'])
  })
})

function entryOf(made: Awaited<ReturnType<ReturnType<typeof passkeyAttempt>>>, fingerprint: string): PasskeyEntry {
  return { ...made.note, rpId: PASSKEY_RP_ID, label: PASSKEY_LABEL, fingerprint, at: 0 }
}

describe('the crossing to Rust', () => {
  // As a control, the SDK's provider handed to the client as the SDK's own default does it. Each of
  // these is a reason the provider goes through the app's bridge.
  test('the bare provider panics on a dismissed sheet', async () => {
    auth.failures.createPasskey.push({ code: 'ERR_USER_CANCELLED', message: 'User cancelled registration' })
    const bare = new PasskeyClient('key', { providerOptions: { rpId: PASSKEY_RP_ID } }) as unknown as {
      register: (request: object) => Promise<unknown>
    }
    await expect(bare.register({})).rejects.toMatchObject({ name: 'RustPanic' })
    expect(__panics).toHaveLength(1)
  })

  test('the bare provider never answers when the authenticator reports absent fields', async () => {
    const bare = new PasskeyClient('key', { providerOptions: { rpId: PASSKEY_RP_ID } }) as unknown as {
      register: (request: object) => Promise<unknown>
    }
    const settled = jest.fn()
    bare.register({}).then(settled, settled)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(settled).not.toHaveBeenCalled()
    expect(__hangs).toEqual(['createPasskey'])
  })

  test('the bare provider cannot read a pinned credential', async () => {
    await passkeyAttempt('register')()
    const bare = new PasskeyClient('key', { providerOptions: { rpId: PASSKEY_RP_ID } }) as unknown as {
      signIn: (request: object) => Promise<unknown>
    }
    await expect(bare.signIn({ allowCredentials: [new ArrayBuffer(4)] })).rejects.toMatchObject({ name: 'RustPanic' })
  })

  test('through the bridge a dismissed sheet arrives as the declared error', async () => {
    auth.failures.createPasskey.push({ code: 'ERR_USER_CANCELLED', message: 'User cancelled registration' })
    await expect(failure(passkeyAttempt('register'))).resolves.toBe('refused')
    expect(__panics).toEqual([])
  })

  test('through the bridge absent fields stay absent', async () => {
    auth.backupEligible = null
    const made = await passkeyAttempt('register')()
    expect(made.note).toMatchObject({ created: true, backupEligible: null, aaguid: null })
    expect(__hangs).toEqual([])
  })

  test('a fallback to a second ceremony is pinned to the new credential', async () => {
    auth.prfAtCreate = false
    const made = await passkeyAttempt('register')()
    expect(auth.calls).toMatchObject({ createPasskey: 1, deriveSeeds: 1 })
    expect(auth.lastAllow).toEqual([made.note.credentialId])
  })

  test.each([
    ['ERR_USER_CANCELLED', 'refused'],
    ['ERR_USER_TIMED_OUT', 'refused'],
    ['ERR_NO_CREDENTIAL', 'noCredential'],
    ['ERR_PRF_NOT_SUPPORTED', 'unavailable'],
    ['ERR_CONFIGURATION', 'unavailable'],
    ['ERR_AUTHENTICATION_FAILED', 'failed'],
    ['ERR_PRF_EVALUATION_FAILED', 'failed'],
    ['ERR_PASSKEY', 'failed'],
  ])('%s reads as %s, off the code and never off a message', async (code, kind) => {
    auth.failures.deriveSeeds.push({ code, message: 'whatever the platform wrote' })
    await expect(failure(passkeyAttempt('restore'))).resolves.toBe(kind)
    expect(__panics).toEqual([])
  })
})

describe('the words a passkey gives', () => {
  test('are twelve valid words, the same on every sign-in', async () => {
    const made = await passkeyAttempt('register')()
    expect(made.mnemonic.split(' ')).toHaveLength(12)
    expect(validateMnemonic(made.mnemonic)).toBe(true)
    const again = await passkeyAttempt('restore')()
    expect(again.mnemonic).toBe(made.mnemonic)
  })

  test('two credentials give two wallets', async () => {
    const one = await passkeyAttempt('register')()
    passkeyWalletStored(one.note)
    const two = await passkeyAttempt('register')()
    expect(two.mnemonic).not.toBe(one.mnemonic)
  })

  test('a seed with a passphrase is refused rather than opened without it', async () => {
    const provider = require('@breeztech/breez-sdk-spark-react-native/passkey-prf-provider')
    const build = jest.spyOn(provider.PasskeyClientBuilder.prototype, 'build').mockReturnValueOnce({
      register: async () => ({
        wallet: { seed: { tag: 'Mnemonic', inner: { mnemonic: 'word '.repeat(12).trim(), passphrase: 'x' } }, label: 'Default' },
        credential: undefined,
      }),
    } as never)
    await expect(failure(passkeyAttempt('register'))).resolves.toBe('failed')
    build.mockRestore()
  })
})

describe('one credential for one attempt', () => {
  const derivationFails = () => {
    auth.prfAtCreate = false
    auth.failures.deriveSeeds.push({ code: 'ERR_USER_CANCELLED', message: 'User cancelled authentication' })
  }

  test('a credential created and not derived is signed into, pinned, and never registered again', async () => {
    derivationFails()
    const attempt = passkeyAttempt('register')
    await expect(failure(attempt)).resolves.toBe('refused')
    expect(auth.calls.createPasskey).toBe(1)

    const made = await attempt()

    expect(auth.calls.createPasskey).toBe(1)
    expect(auth.credentials).toHaveLength(1)
    expect(auth.lastAllow).toEqual([made.note.credentialId])
    expect(made.note).toMatchObject({ created: true, backupEligible: true })
  })

  test('the same through the first run button', async () => {
    auth.prfAtCreate = false
    auth.failures.deriveSeeds.push(
      { code: 'ERR_NO_CREDENTIAL', message: 'no credential available' },
      { code: 'ERR_USER_CANCELLED', message: 'User cancelled authentication' },
    )
    const attempt = passkeyAttempt('connect')
    await expect(failure(attempt)).resolves.toBe('refused')
    expect(auth.calls.createPasskey).toBe(1)
    const made = await attempt()
    expect(auth.calls.createPasskey).toBe(1)
    expect(auth.lastAllow).toEqual([made.note.credentialId])
  })

  test('a new attempt finds it, which is what a button that was mounted again runs', async () => {
    derivationFails()
    await failure(passkeyAttempt('register'))
    const made = await passkeyAttempt('register')()
    expect(auth.calls.createPasskey).toBe(1)
    expect(auth.lastAllow).toEqual([made.note.credentialId])
    expect(made.note).toMatchObject({ created: true, backupEligible: true })
  })

  test('a failure after the create that is not the provider\'s leaves the same pin', async () => {
    auth.afterCreate.push(new Error('label note not published'))
    await expect(failure(passkeyAttempt('register'))).resolves.toBe('failed')
    expect(auth.credentials).toHaveLength(1)
    await passkeyAttempt('register')()
    expect(auth.calls.createPasskey).toBe(1)
    expect(auth.lastAllow).toHaveLength(1)
  })

  test('words no wallet took leave the pin too', async () => {
    const first = await passkeyAttempt('register')()
    const again = await passkeyAttempt('register')()
    expect(again.mnemonic).toBe(first.mnemonic)
    expect(auth.calls.createPasskey).toBe(1)
  })

  test('the first run button and Add wallet share it', async () => {
    auth.afterCreate.push(new Error('label note not published'))
    await failure(passkeyAttempt('connect'))
    expect(auth.calls.createPasskey).toBe(1)
    await passkeyAttempt('register')()
    expect(auth.calls.createPasskey).toBe(1)
  })

  test('stored, it is claimed and the next new wallet registers its own', async () => {
    passkeyWalletStored((await passkeyAttempt('register')()).note)
    await passkeyAttempt('register')()
    expect(auth.calls.createPasskey).toBe(2)
  })

  test('a wallet from another passkey claims nothing', async () => {
    derivationFails()
    await failure(passkeyAttempt('register'))
    passkeyWalletStored({
      credentialId: 'b3RoZXI=',
      created: false,
      fromCreate: false,
      backupEligible: null,
      aaguid: null,
      userName: null,
    })
    await passkeyAttempt('register')()
    expect(auth.calls.createPasskey).toBe(1)
  })

  test('a restore is not pinned to it, and shows every passkey', async () => {
    derivationFails()
    await failure(passkeyAttempt('register'))
    await passkeyAttempt('restore')()
    expect(auth.lastAllow).toEqual([])
    await passkeyAttempt('register')()
    expect(auth.calls.createPasskey).toBe(1)
    expect(auth.lastAllow).toHaveLength(1)
  })

  test('the pinned sign-in failing keeps the pin', async () => {
    derivationFails()
    const attempt = passkeyAttempt('register')
    await failure(attempt)
    auth.failures.deriveSeeds.push({ code: 'ERR_USER_CANCELLED', message: 'User cancelled authentication' })
    await expect(failure(attempt)).resolves.toBe('refused')
    await attempt()
    expect(auth.calls.createPasskey).toBe(1)
  })

  test('two registrations carry different user names', async () => {
    passkeyWalletStored((await passkeyAttempt('register')()).note)
    await passkeyAttempt('register')()
    const [one, two] = auth.credentials
    expect(one.userName).not.toBe(two.userName)
    expect(__clients[0].config?.providerOptions?.userName).toBe(one.userName)
  })

  test('a user name carries nothing of the person', async () => {
    await passkeyAttempt('register')()
    expect(auth.credentials[0].userName).toMatch(/^voltz-[a-z0-9]+-[a-z0-9]+$/)
  })

  test('the user name draws its tail from the secure source, never Math.random', async () => {
    const secure = jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(array => {
      ;(array as Uint8Array).set([1, 2, 3, 4, 5])
      return array
    })
    try {
      await passkeyAttempt('register')()
    } finally {
      secure.mockRestore()
    }
    expect(auth.credentials[0].userName).toMatch(/^voltz-[a-z0-9]+-0102030405$/)
  })

  test('a user name drawn through Math.random registers nothing', async () => {
    const weak = jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(array => {
      const view = array as Uint8Array
      for (let i = 0; i < view.length; i += 1) {
        view[i] = Math.floor(Math.random() * 256)
      }
      return array
    })
    try {
      await expect(passkeyAttempt('register')()).rejects.toThrow('non-crypto RNG')
    } finally {
      weak.mockRestore()
    }
    expect(auth.calls.createPasskey).toBe(0)
  })

  test('restoring never registers, whatever comes back', async () => {
    await expect(failure(passkeyAttempt('restore'))).resolves.toBe('noCredential')
    expect(auth.calls.createPasskey).toBe(0)
    expect(__labelsPublished).toEqual([])
  })

  test('the first run button registers only when the sign-in found nothing', async () => {
    const first = await passkeyAttempt('connect')()
    expect(first.note.created).toBe(true)
    __setPasskeyLiveForTests(true)
    const second = await passkeyAttempt('connect')()
    expect(second.note).toMatchObject({ created: false, fromCreate: true, backupEligible: null })
    expect(second.mnemonic).toBe(first.mnemonic)
    expect(auth.calls.createPasskey).toBe(1)
    expect(auth.lastPrefer).toBe(true)
  })

  test('a restore offers the system its way to another device', async () => {
    await passkeyAttempt('register')()
    const found = await passkeyAttempt('restore')()
    expect(auth.lastPrefer).toBe(false)
    expect(found.note.fromCreate).toBe(false)
  })
})

describe('a refused tap stays refused', () => {
  test.each(['ERR_USER_CANCELLED', 'ERR_USER_TIMED_OUT'])('%s is one call until the next run', async code => {
    auth.failures.deriveSeeds.push({ code, message: 'closed' })
    const attempt = passkeyAttempt('restore')
    await expect(failure(attempt)).resolves.toBe('refused')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(auth.calls.deriveSeeds).toBe(1)
  })
})

describe('checkAvailability', () => {
  test('Skipped counts as available, which is what iOS answers', async () => {
    await expect(passkeyAvailable()).resolves.toBe(true)
    expect(__hangs).toEqual([])
  })

  test('iOS never asks its native domain check, whose wrong arity ends the app', async () => {
    await expect(passkeyAvailable()).resolves.toBe(true)
    expect(auth.calls.checkDomainAssociation).toBe(0)
    expect(auth.aborted).toBe(false)
  })

  test('Android asks it, since its module takes the one argument the package passes', async () => {
    setPlatform('android', 34)
    await expect(passkeyAvailable()).resolves.toBe(true)
    expect(auth.calls.checkDomainAssociation).toBe(1)
    expect(auth.aborted).toBe(false)
  })

  test('no PRF is no button', async () => {
    auth.supported = false
    await expect(passkeyAvailable()).resolves.toBe(false)
  })

  test.each([
    ['ios', '17.7'],
    ['ios', '15.1'],
    ['android', 27],
    ['android', 24],
    ['web', '1'],
  ])('%s %s below the minimum never loads the provider', async (os, version) => {
    setPlatform(os, version)
    const before = __nativeModuleTouched()
    await expect(passkeyAvailable()).resolves.toBe(false)
    expect(__clients).toHaveLength(0)
    expect(__nativeModuleTouched()).toBe(before)
  })

  test.each([
    ['ios', '18.0'],
    ['android', 28],
  ])('%s %s at the minimum asks', async (os, version) => {
    setPlatform(os, version)
    await expect(passkeyAvailable()).resolves.toBe(true)
  })

  test('no answer in three seconds is no for this opening, and it is not asked again', async () => {
    jest.useFakeTimers()
    auth.silent = true
    const answer = passkeyAvailable()
    await jest.advanceTimersByTimeAsync(2999)
    const early = jest.fn()
    answer.then(early)
    await jest.advanceTimersByTimeAsync(0)
    expect(early).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    await expect(answer).resolves.toBe(false)
    await passkeyAvailable()
    expect(__clients).toHaveLength(1)
  })

  test('a client that cannot be built is a no', async () => {
    const provider = require('@breeztech/breez-sdk-spark-react-native/passkey-prf-provider')
    const build = jest.spyOn(provider.PasskeyClientBuilder.prototype, 'build').mockImplementationOnce(() => {
      throw new Error('bad config')
    })
    await expect(passkeyAvailable()).resolves.toBe(false)
    build.mockRestore()
  })

  test('a ceremony that says the device cannot do this outranks an earlier yes', async () => {
    await expect(passkeyAvailable()).resolves.toBe(true)
    markPasskeyUnavailable()
    await expect(passkeyAvailable()).resolves.toBe(false)
  })
})

describe('Test passkey', () => {
  test('the same wallet is the only yes', async () => {
    const made = await passkeyAttempt('register')()
    const entry = entryOf(made, await fingerprintFromMnemonicAsync(made.mnemonic))
    await expect(checkPasskey(entry)).resolves.toBe('same')
    expect(auth.lastAllow).toEqual([made.note.credentialId])
  })

  test('another wallet says so', async () => {
    const made = await passkeyAttempt('register')()
    await expect(checkPasskey(entryOf(made, 'aaaaaaaa'))).resolves.toBe('other')
  })

  test('off, it says nothing and never loads the provider', async () => {
    const made = await passkeyAttempt('register')()
    __setPasskeyLiveForTests(false)
    const before = __nativeModuleTouched()
    await expect(checkPasskey(entryOf(made, 'aaaaaaaa'))).resolves.toBe('unknown')
    expect(__nativeModuleTouched()).toBe(before)
  })

  test('below the minimum, a note restored from a backup never loads the provider', async () => {
    const made = await passkeyAttempt('register')()
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => '17.5' })
    const clients = __clients.length
    await expect(checkPasskey(entryOf(made, 'aaaaaaaa'))).resolves.toBe('unknown')
    expect(__clients).toHaveLength(clients)
  })

  test.each(['ERR_USER_CANCELLED', 'ERR_USER_TIMED_OUT', 'ERR_NO_CREDENTIAL', 'ERR_PASSKEY'])(
    '%s says nothing either way',
    async code => {
      const made = await passkeyAttempt('register')()
      auth.failures.deriveSeeds.push({ code, message: 'closed' })
      await expect(checkPasskey(entryOf(made, 'aaaaaaaa'))).resolves.toBe('unknown')
    },
  )
})

describe('nothing derived leaves the device', () => {
  const SRC = readFileSync(join(__dirname, '../src/wallet/passkey.ts'), 'utf8')
  const CODE = SRC.replace(/\/\/.*$/gm, '')

  test('the module imports no HTTP client and calls no network', () => {
    const imports = [...CODE.matchAll(/from '([^']+)'/g)].map(match => match[1])
    expect(imports.length).toBeGreaterThan(5)
    for (const name of imports) {
      expect(name).not.toMatch(/axios|fetch|http|gateway|\/(api|push|deletion|nameState)$/)
    }
    expect(CODE).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket/)
  })

  test('no ceremony logs or fetches the words, and an error carries none of them', async () => {
    const send = jest.fn(async () => ({ ok: true }))
    const realFetch = global.fetch
    global.fetch = send as never
    const logs = (['log', 'warn', 'error', 'info', 'debug'] as const).map(level =>
      jest.spyOn(console, level).mockImplementation(() => undefined),
    )
    try {
      const made = await passkeyAttempt('connect')()
      await passkeyAttempt('restore')()
      await checkPasskey(entryOf(made, await fingerprintFromMnemonicAsync(made.mnemonic)))
      auth.failures.deriveSeeds.push({ code: 'ERR_USER_CANCELLED', message: 'closed' })
      const err = await passkeyAttempt('restore')().catch((e: Error) => e)
      expect(send).not.toHaveBeenCalled()
      for (const spy of logs) {
        expect(spy).not.toHaveBeenCalled()
      }
      expect(String((err as Error).message)).toBe('passkey ceremony ended as refused')
      expect(JSON.stringify(made.note)).not.toContain(made.mnemonic.split(' ')[0] + ' ')
      expect(jest.mocked(Keychain.setGenericPassword)).not.toHaveBeenCalled()
    } finally {
      global.fetch = realFetch
      logs.forEach(spy => spy.mockRestore())
    }
  })
})
