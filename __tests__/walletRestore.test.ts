import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import NativeVoltzDurable from '../specs/NativeVoltzDurable'
import {
  addAndActivateWallet,
  addFirstWallet,
  countUnconfirmedWallets,
  eraseAllWallets,
  isWalletAlreadyAdded,
  isWalletSeedAbsent,
  settleActiveWallet,
  switchWalletWithoutReconnecting,
} from '../src/wallet/wallet'
import { loadRegistry, type Registry } from '../src/wallet/walletRegistry'
import { loadPassphraseFor, loadSeedFor, saveSeedFor } from '../src/wallet/seed'
import { markUnconfirmed } from '../src/wallet/backupMark'
import { fingerprintFromMnemonic, fingerprintFromMnemonicAsync } from '../src/wallet/fingerprint'
import { importCheckDue } from '../src/wallet/deletionMark'
import { disconnectSpark, sparkEraseLocalData } from '../src/wallet/spark'
import { setDomainFor, storedDomainFor } from '../src/wallet/lnurlDomainPref'
import { cachedDomainRoles } from '../src/wallet/domainTier'
import { getBreezLnurlDomain } from '../src/config'
import { FORGET_WAIT_MS, deviceForgetSettled, sendDeviceForgets } from '../src/wallet/deviceForget'
import { forgetProof } from '../src/wallet/webhook'
import { loadDeviceForgets, loadWebhookState, noteGatewayWebhookId, webhookStateFor } from '../src/wallet/webhookSecret'

// The state an iPhone restored from another device's backup opens in. Documents came back, and the
// wallet registry with it, while every seed was stored WHEN_UNLOCKED_THIS_DEVICE_ONLY and stayed on the
// old phone. The registry, the seed store and the fingerprint are the real modules, over the
// in-memory fs and a Keychain that keeps what it is given.
jest.mock('../src/wallet/spark', () => ({
  connectActiveSpark: jest.fn(async () => undefined),
  connectSpark: jest.fn(async () => undefined),
  disconnectSpark: jest.fn(async () => undefined),
  sparkEraseLocalData: jest.fn(async () => undefined),
  whileSparkErasing: jest.fn((work: () => Promise<unknown>) => work()),
}))
// The build's own domain unless a test names one.
jest.mock('../src/config', () => {
  const actual = jest.requireActual('../src/config')
  return { ...actual, getBreezLnurlDomain: jest.fn(actual.getBreezLnurlDomain) }
})
// Both derivations are wrapped so a call to either shows, or fails on demand, and still answer the
// real id.
jest.mock('../src/wallet/fingerprint', () => {
  const actual = jest.requireActual('../src/wallet/fingerprint')
  return {
    ...actual,
    fingerprintFromMnemonic: jest.fn(actual.fingerprintFromMnemonic),
    fingerprintFromMnemonicAsync: jest.fn(actual.fingerprintFromMnemonicAsync),
  }
})

const REGISTRY = `${RNFS.DocumentDirectoryPath}/wallets.json`
const DOMAIN_CACHE = `${RNFS.DocumentDirectoryPath}/domain-tier.json`
const DOMAIN_ASKED = `${RNFS.DocumentDirectoryPath}/domain-mine.json`
const SEED = 'com.voltz.wallet.seed'
const seedService = (id: string): string => (id === 'primary' ? SEED : `${SEED}.${id}`)

const keychain = new Map<string, string>()
// Services whose presence read throws, as a Keychain that cannot be read does.
const unreadable = new Set<string>()

const WORDS =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'

// Two wallets from the old phone, neither with its seed here.
const LOST: Registry = {
  wallets: [
    { id: 'w_lost1', fingerprint: 'aaaa1111' },
    { id: 'w_lost2', fingerprint: 'bbbb2222' },
  ],
  active: 'w_lost1',
}

async function writeRegistry(reg: Registry): Promise<void> {
  await RNFS.writeFile(REGISTRY, JSON.stringify(reg), 'utf8')
}

async function registryText(): Promise<string | null> {
  return (await RNFS.exists(REGISTRY)) ? RNFS.readFile(REGISTRY, 'utf8') : null
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  keychain.clear()
  unreadable.clear()
  jest.clearAllMocks()
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    keychain.set(options?.service ?? '', password)
    return false
  })
  jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
    const password = keychain.get(options?.service ?? '')
    return password === undefined ? false : ({ username: 'u', password } as never)
  })
  jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options => {
    const service = options?.service ?? ''
    if (unreadable.has(service)) {
      throw new Error('keychain unavailable')
    }
    return keychain.has(service)
  })
  jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => keychain.delete(options?.service ?? ''))
})

// The primary id passes to the next first wallet once the device holds none, which a forgotten PIN
// reaches, so nothing kept under it may describe the wallet that left.
describe('the wallet that takes the primary id after an erase', () => {
  test('takes the SDK folder with it, and a folder that cannot go never stops the way out', async () => {
    await addFirstWallet(WORDS, undefined, 'drawn')
    keychain.set('com.voltz.wallet.pin', '123456')
    jest.mocked(sparkEraseLocalData).mockRejectedValueOnce(new Error('busy'))
    const warned = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await eraseAllWallets()

    expect(sparkEraseLocalData).toHaveBeenCalledTimes(1)
    expect(keychain.has('com.voltz.wallet.pin')).toBe(false)
    expect(warned).toHaveBeenCalledWith('SDK folder not erased: busy')
    warned.mockRestore()
  })

  // The lock drawn over a running wallet offers Forgot PIN, so the erase can start with the SDK
  // connected to the primary id the next first wallet takes, which a live connection would answer.
  test('drops the live connection before the first seed goes', async () => {
    await addFirstWallet(WORDS, undefined, 'drawn')
    keychain.set('com.voltz.wallet.pin', '123456')
    const seedsAtDisconnect: boolean[] = []
    jest.mocked(disconnectSpark).mockImplementationOnce(async () => {
      seedsAtDisconnect.push(keychain.has(seedService('primary')))
    })

    await eraseAllWallets()

    expect(seedsAtDisconnect).toEqual([true])
    expect(keychain.has(seedService('primary'))).toBe(false)
  })

  // Forgot PIN is the cleanup of every wallet here, so the forgets it queues outlive it, and go
  // with no words, no PIN and no connection left.
  test("queues every wallet's forget, waits on none, and the queue outlives the erase", async () => {
    jest.mocked(getBreezLnurlDomain).mockReturnValue('lnurl.usevoltz.app')
    const PK1 = '02'.padEnd(66, 'a')
    const PK2 = '03'.padEnd(66, 'b')
    try {
      expect(await addFirstWallet(WORDS, undefined, 'drawn')).toBe('primary')
      await saveSeedFor('w_two', OTHER)
      const one = await webhookStateFor('primary', PK1)
      await noteGatewayWebhookId('primary', one.secret, 'AbCdEfGhIjKlMnOpQrStUv', PK1)
      const two = await webhookStateFor('w_two', PK2)
      keychain.set('com.voltz.wallet.pin', '123456')
      jest.mocked(Keychain.getAllGenericPasswordServices).mockImplementation(async () => [...keychain.keys()])
      // A gateway that never answers holds nothing: the erase finishes with no timer advanced.
      global.fetch = jest.fn(() => new Promise(() => undefined)) as unknown as typeof fetch
      jest.useFakeTimers()
      try {
        await eraseAllWallets()
        // One run in flight and at most one waiting behind it, since a call made while a run waits
        // joins it; each wait starts when its run does, so the queue settles within two waits.
        await jest.advanceTimersByTimeAsync(2 * FORGET_WAIT_MS)
      } finally {
        jest.useRealTimers()
      }

      expect(keychain.has('com.voltz.wallet.pin')).toBe(false)
      expect(await loadWebhookState('primary')).toBeNull()
      expect(await loadWebhookState('w_two')).toBeNull()
      const owed = [
        { pubkey: PK1, proof: forgetProof('lnurl.usevoltz.app', PK1, one.secret) },
        { pubkey: PK2, proof: forgetProof('lnurl.usevoltz.app', PK2, two.secret) },
      ]
      expect(await loadDeviceForgets()).toEqual(expect.arrayContaining(owed))
      expect(await loadDeviceForgets()).toHaveLength(2)

      await deviceForgetSettled()
      const later = jest.fn(async (_url: string, _init: { body: string }) => ({ ok: true, status: 200 }))
      global.fetch = later as unknown as typeof fetch
      await sendDeviceForgets()
      expect(later.mock.calls.map(call => JSON.parse(call[1].body))).toEqual(expect.arrayContaining(owed))
      expect(await loadDeviceForgets()).toEqual([])
    } finally {
      jest.mocked(Keychain.getAllGenericPasswordServices).mockImplementation(async () => [])
      jest.mocked(getBreezLnurlDomain).mockImplementation(jest.requireActual('../src/config').getBreezLnurlDomain)
    }
  })

  test('inherits no own domain, and asks about its key afresh', async () => {
    expect(await addFirstWallet(WORDS, undefined, 'drawn')).toBe('primary')
    await setDomainFor('primary', 'loja.example')
    await RNFS.writeFile(DOMAIN_CACHE, JSON.stringify({ primary: { host: 'loja.example', state: { role: 'owner' } } }), 'utf8')
    await RNFS.writeFile(DOMAIN_ASKED, JSON.stringify({ primary: 1_800_000_000 }), 'utf8')

    await eraseAllWallets()

    expect(await addFirstWallet(OTHER, undefined, 'drawn')).toBe('primary')
    expect(await storedDomainFor('primary')).toBeUndefined()
    expect(await cachedDomainRoles()).toEqual({})
    expect(JSON.parse(await RNFS.readFile(DOMAIN_ASKED, 'utf8'))).toEqual({})
  })
})

describe('the count before an erase', () => {
  beforeEach(() => {
    jest.mocked(Keychain.getAllGenericPasswordServices).mockImplementation(async () => [...keychain.keys()])
  })
  afterEach(() => {
    jest.mocked(Keychain.getAllGenericPasswordServices).mockImplementation(async () => [])
  })

  test('takes in a seed the list misses, as the erase does', async () => {
    await addFirstWallet(WORDS, undefined, 'drawn')
    await saveSeedFor('w_unlisted', OTHER)
    await markUnconfirmed('w_unlisted')

    expect(await countUnconfirmedWallets()).toBe(2)
  })

  test('leaves out a marked wallet whose seed is gone, which the erase cannot cost', async () => {
    await addFirstWallet(WORDS, undefined, 'drawn')
    await markUnconfirmed('w_gone')

    expect(await countUnconfirmedWallets()).toBe(1)
  })
})

describe('an erase with records under a primary id nothing lists', () => {
  test('leaves none of them for the next first wallet', async () => {
    await RNFS.writeFile(DOMAIN_CACHE, JSON.stringify({ primary: { host: 'loja.example', state: { role: 'owner' } } }), 'utf8')
    await setDomainFor('primary', 'loja.example')

    await eraseAllWallets()

    expect(await storedDomainFor('primary')).toBeUndefined()
    expect(await cachedDomainRoles()).toEqual({})
  })
})

describe('the first-run wallet', () => {
  // The registry's pointer names a wallet with no seed. An onboarding wallet put in the Keychain without
  // moving the pointer would leave the next open asking for the same wallet and showing Welcome.
  test('becomes the active wallet, registered with its fingerprint, whatever the registry held', async () => {
    await writeRegistry(LOST)

    const id = await addFirstWallet(WORDS, undefined, 'drawn')

    const reg = await loadRegistry()
    expect(reg.active).toBe(id)
    expect(reg.wallets).toContainEqual({ id, fingerprint: fingerprintFromMnemonic(WORDS) })
    expect(await loadSeedFor(id)).toBe(WORDS)
    // The wallets from the old phone stay listed, to be removed or added again by the person.
    expect(reg.wallets).toEqual(expect.arrayContaining(LOST.wallets))
    // The next open opens it, without moving anything.
    const before = await registryText()
    expect(await settleActiveWallet()).toBe(true)
    expect(await registryText()).toBe(before)
  })

  // A lost wallet's per-wallet records (address, domain, marks) are keyed by its id, so taking a listed
  // id would hand them to the new wallet.
  test('never takes an id the registry lists, the primary included', async () => {
    await writeRegistry({ wallets: [{ id: 'primary', fingerprint: 'aaaa1111' }], active: 'primary' })

    const id = await addFirstWallet(WORDS, undefined, 'drawn')

    expect(id).not.toBe('primary')
    expect(keychain.has(SEED)).toBe(false)
    expect(keychain.get(seedService(id))).toBe(WORDS)
    const reg = await loadRegistry()
    expect(reg.wallets).toContainEqual({ id: 'primary', fingerprint: 'aaaa1111' })
    expect(reg.active).toBe(id)
  })

  // A first install keeps the Keychain layout every installed wallet already has.
  test('takes the primary id on a registry with no wallet in it', async () => {
    const id = await addFirstWallet(WORDS, undefined, 'drawn')

    expect(id).toBe('primary')
    expect(keychain.get(SEED)).toBe(WORDS)
    expect(await loadRegistry()).toEqual({
      wallets: [{ id: 'primary', fingerprint: fingerprintFromMnemonic(WORDS) }],
      active: 'primary',
    })
  })

  test('keeps its passphrase under its own id and folds it into the fingerprint', async () => {
    await writeRegistry(LOST)

    const id = await addFirstWallet(WORDS, 'correct horse', 'drawn')

    expect(await loadPassphraseFor(id)).toBe('correct horse')
    expect((await loadRegistry()).wallets).toContainEqual({
      id,
      fingerprint: fingerprintFromMnemonic(WORDS, 'correct horse'),
    })
  })

  // The onboarding saves its wallet right after the last tap, and the synchronous PBKDF2 would hold
  // the screen still for its 2048 rounds.
  test('derives its fingerprint off the JS thread', async () => {
    const id = await addFirstWallet(WORDS, 'correct horse', 'drawn')

    expect(fingerprintFromMnemonic).not.toHaveBeenCalled()
    const fingerprint = fingerprintFromMnemonic(WORDS, 'correct horse')
    expect((await loadRegistry()).wallets).toEqual([{ id, fingerprint }])
  })

  test('an import has its deletion status read under its own id; a creation does not', async () => {
    await writeRegistry(LOST)

    const imported = await addFirstWallet(WORDS, undefined, 'typed')
    const created = await addFirstWallet(OTHER, undefined, 'drawn')

    expect(await importCheckDue(imported)).toBe(true)
    expect(await importCheckDue(created)).toBe(false)
  })
})

// A restored iPhone lists the old phone's wallets with no seeds, and the person types the same words
// back. Everything this device keeps per wallet (domain, remembered address, purchase proofs, deletion
// marks) is keyed by the listed id, so the words take that id back rather than a second row.
describe('the same words as a listed wallet with no seed here', () => {
  test('take that wallet\'s id back in the first run, with no second row', async () => {
    const reg: Registry = {
      wallets: [
        { id: 'w_lost1', fingerprint: 'aaaa1111' },
        { id: 'w_lost2', fingerprint: fingerprintFromMnemonic(WORDS) },
      ],
      active: 'w_lost1',
    }
    await writeRegistry(reg)

    const id = await addFirstWallet(WORDS, undefined, 'typed')

    expect(id).toBe('w_lost2')
    expect(keychain.get(seedService('w_lost2'))).toBe(WORDS)
    expect(await loadRegistry()).toEqual({ wallets: reg.wallets, active: 'w_lost2' })
    expect(await importCheckDue('w_lost2')).toBe(true)
  })

  test('take that wallet\'s id back when added later, beside a wallet that opens', async () => {
    const reg: Registry = {
      wallets: [
        { id: 'w_ok', fingerprint: 'cccc3333' },
        { id: 'w_lost2', fingerprint: fingerprintFromMnemonic(WORDS, 'correct horse') },
      ],
      active: 'w_ok',
    }
    await writeRegistry(reg)
    keychain.set(seedService('w_ok'), OTHER)

    const id = await addAndActivateWallet(WORDS, 'correct horse', 'typed')

    expect(id).toBe('w_lost2')
    expect(await loadSeedFor('w_lost2')).toBe(WORDS)
    expect(await loadPassphraseFor('w_lost2')).toBe('correct horse')
    expect(await loadRegistry()).toEqual({ wallets: reg.wallets, active: 'w_lost2' })
  })

  // The passphrase is part of the fingerprint, so the same words with another passphrase are another
  // wallet and inherit nothing.
  test('with another passphrase are another wallet, under an id of their own', async () => {
    await writeRegistry({ wallets: [{ id: 'w_lost1', fingerprint: fingerprintFromMnemonic(WORDS) }], active: 'w_lost1' })

    const first = await addFirstWallet(WORDS, 'correct horse', 'drawn')
    const later = await addAndActivateWallet(WORDS, 'battery staple')

    expect(first).not.toBe('w_lost1')
    expect(later).not.toBe('w_lost1')
    expect(keychain.has(seedService('w_lost1'))).toBe(false)
    expect((await loadRegistry()).wallets).toHaveLength(3)
  })

  // A listed wallet that opens is not lost, and adding its words again keeps what it did before.
  test('a listed wallet whose seed is here is not taken over, and its passphrase stays', async () => {
    await writeRegistry({ wallets: [{ id: 'w_ok', fingerprint: fingerprintFromMnemonic(WORDS) }], active: 'w_ok' })
    keychain.set(seedService('w_ok'), WORDS)
    keychain.set(`com.voltz.wallet.passphrase.w_ok`, 'kept')

    const id = await addAndActivateWallet(WORDS)

    expect(id).not.toBe('w_ok')
    expect(keychain.get(`com.voltz.wallet.passphrase.w_ok`)).toBe('kept')
    expect((await loadRegistry()).wallets.map(w => w.id)).toEqual(['w_ok', id])
  })

  // A read that throws is not an absent seed, so nothing is taken and nothing written.
  test.each([
    ['first run', () => addFirstWallet(WORDS, undefined, 'drawn')],
    ['added later', () => addAndActivateWallet(WORDS)],
  ])('a throwing read of the listed twin refuses the add (%s), writing nothing', async (_how, add) => {
    await writeRegistry({ wallets: [{ id: 'w_lost1', fingerprint: fingerprintFromMnemonic(WORDS) }], active: 'w_lost1' })
    unreadable.add(seedService('w_lost1'))
    const before = await registryText()

    await expect(add()).rejects.toThrow('keychain unavailable')

    expect(keychain.size).toBe(0)
    expect(await registryText()).toBe(before)
  })

  // On a listed id a seed with no passphrase opens at boot as a different, empty wallet, so the
  // passphrase goes first and a write that fails between them leaves no seed.
  test('a passphrase write that fails on the taken id leaves no seed under it', async () => {
    await writeRegistry({
      wallets: [
        { id: 'w_ok', fingerprint: 'cccc3333' },
        { id: 'w_lost2', fingerprint: fingerprintFromMnemonic(WORDS, 'correct horse') },
      ],
      active: 'w_ok',
    })
    keychain.set(seedService('w_ok'), OTHER)
    jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
      if (options?.service === 'com.voltz.wallet.passphrase.w_lost2') {
        throw new Error('keychain full')
      }
      keychain.set(options?.service ?? '', password)
      return false
    })

    await expect(addAndActivateWallet(WORDS, 'correct horse')).rejects.toThrow('keychain full')

    expect(keychain.has(seedService('w_lost2'))).toBe(false)
    expect(await settleActiveWallet()).toBe(true)
    expect((await loadRegistry()).active).toBe('w_ok')
  })
})

// Two ids for one key keep two sets of records (deletion marks among them), so a reader that
// asks one id misses the other's. Adding the words and passphrase of a wallet already here is refused
// before anything is written.
describe('the same words and passphrase as a wallet whose seed is here', () => {
  const PASS = 'com.voltz.wallet.passphrase'
  const DOCS = RNFS.DocumentDirectoryPath

  async function filesText(): Promise<(string | null)[]> {
    const read = async (path: string) => ((await RNFS.exists(path)) ? RNFS.readFile(path, 'utf8') : null)
    return Promise.all([REGISTRY, `${DOCS}/deletion.json`, `${DOCS}/deletion-check.json`].map(read))
  }

  test.each([
    ['with no passphrase', undefined],
    ['with a passphrase', 'correct horse'],
  ])('are refused %s, naming the wallet and writing nothing', async (_how, passphrase) => {
    await writeRegistry({
      wallets: [
        { id: 'w_other', fingerprint: fingerprintFromMnemonic(OTHER) },
        { id: 'w_ok', fingerprint: fingerprintFromMnemonic(WORDS, passphrase) },
      ],
      active: 'w_other',
    })
    keychain.set(seedService('w_other'), OTHER)
    keychain.set(seedService('w_ok'), WORDS)
    if (passphrase) {
      keychain.set(`${PASS}.w_ok`, passphrase)
    }
    const files = await filesText()
    const secrets = new Map(keychain)

    const refusal = await addAndActivateWallet(WORDS, passphrase, 'typed').catch((err: unknown) => err)

    expect(isWalletAlreadyAdded(refusal)).toBe(true)
    expect(refusal).toMatchObject({ walletId: 'w_ok', fingerprint: fingerprintFromMnemonic(WORDS, passphrase) })
    expect(await filesText()).toEqual(files)
    expect(keychain).toEqual(secrets)
    expect(await importCheckDue('w_ok')).toBe(false)
  })

  // An empty passphrase is stored as none, so the two are one wallet.
  test('are refused when the add passes an empty passphrase for a wallet stored with none', async () => {
    await writeRegistry({ wallets: [{ id: 'w_ok', fingerprint: fingerprintFromMnemonic(WORDS) }], active: 'w_ok' })
    keychain.set(seedService('w_ok'), WORDS)

    await expect(addAndActivateWallet(WORDS, '')).rejects.toMatchObject({ name: 'WalletAlreadyAdded' })
    expect((await loadRegistry()).wallets.map(w => w.id)).toEqual(['w_ok'])
  })

  test('with another passphrase are another wallet, and are added', async () => {
    await writeRegistry({ wallets: [{ id: 'w_ok', fingerprint: fingerprintFromMnemonic(WORDS) }], active: 'w_ok' })
    keychain.set(seedService('w_ok'), WORDS)

    const id = await addAndActivateWallet(WORDS, 'battery staple')

    expect(id).not.toBe('w_ok')
    expect((await loadRegistry()).wallets.map(w => w.id)).toEqual(['w_ok', id])
    expect(await loadPassphraseFor(id)).toBe('battery staple')
  })

  // The fingerprint is four bytes and can collide, so a listed wallet that shares it with other words
  // is not the same wallet.
  test('are added beside a wallet that only shares the fingerprint', async () => {
    await writeRegistry({ wallets: [{ id: 'w_ok', fingerprint: fingerprintFromMnemonic(WORDS) }], active: 'w_ok' })
    keychain.set(seedService('w_ok'), OTHER)

    const id = await addAndActivateWallet(WORDS)

    expect(id).not.toBe('w_ok')
    expect((await loadRegistry()).wallets.map(w => w.id)).toEqual(['w_ok', id])
  })

  test.each([
    ['seed', (id: string) => seedService(id)],
    ['passphrase', (id: string) => `${PASS}.${id}`],
  ])('a %s read that throws fails the add, writing nothing', async (_what, service) => {
    await writeRegistry({ wallets: [{ id: 'w_ok', fingerprint: fingerprintFromMnemonic(WORDS) }], active: 'w_ok' })
    keychain.set(seedService('w_ok'), WORDS)
    const failing = service('w_ok')
    const read = jest.mocked(Keychain.getGenericPassword).getMockImplementation()!
    jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
      if (options?.service === failing) {
        throw new Error('keychain unavailable')
      }
      return read(options)
    })
    const files = await filesText()

    await expect(addAndActivateWallet(WORDS, undefined, 'typed')).rejects.toThrow('keychain unavailable')

    expect(await filesText()).toEqual(files)
    expect([...keychain.keys()]).toEqual([seedService('w_ok')])
  })
})

describe('the boot', () => {
  test('moves the pointer off a wallet with no seed to the first listed wallet that has one', async () => {
    await writeRegistry({
      wallets: [...LOST.wallets, { id: 'w_ok', fingerprint: 'cccc3333' }, { id: 'w_ok2', fingerprint: 'dddd4444' }],
      active: 'w_lost1',
    })
    keychain.set(seedService('w_ok'), WORDS)
    keychain.set(seedService('w_ok2'), OTHER)

    expect(await settleActiveWallet()).toBe(true)

    const reg = await loadRegistry()
    expect(reg.active).toBe('w_ok')
    expect(reg.wallets).toHaveLength(4)
  })

  test('a legacy registry with no pointer and no primary seed opens a listed wallet that has one', async () => {
    await RNFS.writeFile(REGISTRY, JSON.stringify({ wallets: [{ id: 'w_ok', fingerprint: 'cccc3333' }] }), 'utf8')
    keychain.set(seedService('w_ok'), WORDS)

    expect(await settleActiveWallet()).toBe(true)
    expect((await loadRegistry()).active).toBe('w_ok')
  })

  test('answers false, writing nothing, when no listed wallet has its seed here', async () => {
    await writeRegistry(LOST)
    const before = await registryText()

    expect(await settleActiveWallet()).toBe(false)
    expect(await registryText()).toBe(before)
  })

  // A seed under the primary id that the registry does not list is a wallet this device holds.
  test('opens a primary seed the registry does not list, registered with its fingerprint', async () => {
    await writeRegistry(LOST)
    keychain.set(SEED, WORDS)
    keychain.set('com.voltz.wallet.passphrase', 'correct horse')

    expect(await settleActiveWallet()).toBe(true)

    expect(await loadRegistry()).toEqual({
      wallets: [...LOST.wallets, { id: 'primary', fingerprint: fingerprintFromMnemonic(WORDS, 'correct horse') }],
      active: 'primary',
    })
    const before = await registryText()
    expect(await settleActiveWallet()).toBe(true)
    expect(await registryText()).toBe(before)
  })

  test('a throwing read of an unlisted primary seed fails the boot and writes nothing', async () => {
    await writeRegistry(LOST)
    keychain.set(SEED, WORDS)
    unreadable.add(SEED)
    const before = await registryText()

    await expect(settleActiveWallet()).rejects.toThrow('keychain unavailable')
    expect(await registryText()).toBe(before)
  })

  // A read that fails is not an absent seed.
  test("a throwing read of the active wallet's seed fails the boot and moves nothing", async () => {
    await writeRegistry({ ...LOST, wallets: [...LOST.wallets, { id: 'w_ok', fingerprint: 'cccc3333' }] })
    keychain.set(seedService('w_ok'), WORDS)
    unreadable.add(seedService('w_lost1'))
    const before = await registryText()

    await expect(settleActiveWallet()).rejects.toThrow('keychain unavailable')
    expect(await registryText()).toBe(before)
  })

  test('a throwing read of another wallet, before one that has its seed, fails the boot and moves nothing', async () => {
    await writeRegistry({ ...LOST, wallets: [...LOST.wallets, { id: 'w_ok', fingerprint: 'cccc3333' }] })
    keychain.set(seedService('w_ok'), WORDS)
    unreadable.add(seedService('w_lost2'))
    const before = await registryText()

    await expect(settleActiveWallet()).rejects.toThrow('keychain unavailable')
    expect(await registryText()).toBe(before)
  })

  test('one healthy wallet: one presence read, and nothing written', async () => {
    await writeRegistry({ wallets: [{ id: 'w1', fingerprint: 'eeee5555' }], active: 'w1' })
    keychain.set(seedService('w1'), WORDS)
    const before = await registryText()

    expect(await settleActiveWallet()).toBe(true)

    expect(Keychain.hasGenericPassword).toHaveBeenCalledTimes(1)
    expect(Keychain.hasGenericPassword).toHaveBeenCalledWith({ service: seedService('w1') })
    expect(Keychain.getGenericPassword).not.toHaveBeenCalled()
    expect(await registryText()).toBe(before)
  })

  test('a single wallet from before the registry opens as it always has, with nothing written', async () => {
    keychain.set(SEED, WORDS)

    expect(await settleActiveWallet()).toBe(true)
    expect(await registryText()).toBeNull()
  })
})

// Over the real registry, the refusal leaves the file as it was.
test('a switch to a listed wallet with no seed here is refused and leaves the registry as it was', async () => {
  await writeRegistry({ ...LOST, wallets: [...LOST.wallets, { id: 'w_ok', fingerprint: 'cccc3333' }], active: 'w_ok' })
  keychain.set(seedService('w_ok'), WORDS)
  const before = await registryText()

  const refused = await switchWalletWithoutReconnecting('w_lost2').catch((err: unknown) => err)

  expect(isWalletSeedAbsent(refused)).toBe(true)
  expect(await registryText()).toBe(before)
})

// A wallets.json cut mid write, or of a shape this build cannot read, with the seeds still in the
// Keychain. The list is rebuilt from them at boot, and the file is set aside rather than deleted.
describe('the boot over a list that cannot be read', () => {
  const TORN = '{"wallets":[{"id":"primary","fingerprint":"aa'
  const ASIDE = `${REGISTRY}.unreadable`
  const PASSPHRASE = 'com.voltz.wallet.passphrase'
  const THIRD = 'unveil nice picture region tragic fault cream strike tourist control recipe tourist'
  // Services the listing names beyond the keychain's own entries, as Android's alias list can.
  const extraServices: string[] = []

  async function disk(): Promise<(string | null)[]> {
    return Promise.all(
      [REGISTRY, `${REGISTRY}.tmp`, ASIDE, `${REGISTRY}.tmp.unreadable`].map(async path =>
        (await RNFS.exists(path)) ? RNFS.readFile(path, 'utf8') : null,
      ),
    )
  }

  beforeEach(async () => {
    extraServices.length = 0
    jest
      .mocked(Keychain.getAllGenericPasswordServices)
      .mockImplementation(async () => [...keychain.keys(), ...extraServices])
    await RNFS.writeFile(REGISTRY, TORN, 'utf8')
  })

  afterEach(() => {
    jest.mocked(Keychain.getAllGenericPasswordServices).mockImplementation(async () => [])
  })

  test('lists every wallet whose seed is here, under its fingerprint, and keeps the torn bytes aside', async () => {
    keychain.set(seedService('w_b'), OTHER)
    keychain.set(`${PASSPHRASE}.w_b`, 'correct horse')
    keychain.set(seedService('primary'), WORDS)
    keychain.set(seedService('w_a'), THIRD)
    keychain.set('com.voltz.wallet.pin', '123456')

    expect(await settleActiveWallet()).toBe(true)

    const actual = jest.requireActual('../src/wallet/fingerprint')
    expect(await loadRegistry()).toEqual({
      wallets: [
        { id: 'primary', fingerprint: await actual.fingerprintFromMnemonicAsync(WORDS) },
        { id: 'w_a', fingerprint: await actual.fingerprintFromMnemonicAsync(THIRD) },
        { id: 'w_b', fingerprint: await actual.fingerprintFromMnemonicAsync(OTHER, 'correct horse') },
      ],
      active: 'primary',
    })
    expect(await RNFS.readFile(ASIDE, 'utf8')).toBe(TORN)
    expect(Keychain.getAllGenericPasswordServices).toHaveBeenCalledWith({ skipUIAuth: true })
    // Off the JS thread, as every other derivation at boot.
    expect(fingerprintFromMnemonic).not.toHaveBeenCalled()
  })

  test('with no primary seed, orders the wallets by id and makes the first active', async () => {
    keychain.set(seedService('w_mzz'), OTHER)
    keychain.set(seedService('w_maa'), WORDS)

    expect(await settleActiveWallet()).toBe(true)

    const reg = await loadRegistry()
    expect(reg.wallets.map(w => w.id)).toEqual(['w_maa', 'w_mzz'])
    expect(reg.active).toBe('w_maa')
  })

  test('a listed key whose presence read answers absent is not listed', async () => {
    keychain.set(seedService('primary'), WORDS)
    extraServices.push(seedService('w_gone'), seedService('primary'))

    expect(await settleActiveWallet()).toBe(true)

    expect((await loadRegistry()).wallets.map(w => w.id)).toEqual(['primary'])
    expect(Keychain.hasGenericPassword).toHaveBeenCalledWith({ service: seedService('w_gone') })
  })

  test('a passphrase with no seed, and every service that is not a seed, are not listed', async () => {
    keychain.set(seedService('w_a'), WORDS)
    keychain.set(`${PASSPHRASE}.w_c`, 'correct horse')
    keychain.set(PASSPHRASE, 'battery')
    // Holds words, so only the rule that a seed service names an id keeps an empty id out.
    keychain.set(`${SEED}.`, OTHER)
    extraServices.push('com.voltz.wallet.biometric', `${SEED}x.w_d`)

    expect(await settleActiveWallet()).toBe(true)

    expect((await loadRegistry()).wallets.map(w => w.id)).toEqual(['w_a'])
  })

  test('with no seed at all, sets the file aside and answers false, and the onboarding writes a fresh list', async () => {
    expect(await settleActiveWallet()).toBe(false)

    expect(await registryText()).toBeNull()
    expect(await RNFS.readFile(ASIDE, 'utf8')).toBe(TORN)

    const id = await addFirstWallet(WORDS, undefined, 'drawn')
    expect(id).toBe('primary')
    expect(await loadRegistry()).toEqual({
      wallets: [{ id: 'primary', fingerprint: fingerprintFromMnemonic(WORDS) }],
      active: 'primary',
    })
  })

  // A kill, or a write that fails outright (a full disk), between setting the file aside and writing
  // the rebuilt list leaves no list at all beside the one set aside.
  test('a repair whose list write fails leaves the file aside, and the next boot lists every wallet', async () => {
    keychain.set(seedService('primary'), WORDS)
    keychain.set(seedService('w_a'), OTHER)
    const write = jest.spyOn(RNFS, 'writeFile').mockRejectedValueOnce(new Error('no space left on device'))

    await expect(settleActiveWallet()).rejects.toThrow('no space left on device')
    write.mockRestore()
    expect(await registryText()).toBeNull()
    expect(await RNFS.exists(`${REGISTRY}.tmp`)).toBe(false)
    expect(await RNFS.readFile(ASIDE, 'utf8')).toBe(TORN)

    expect(await settleActiveWallet()).toBe(true)

    expect((await loadRegistry()).wallets.map(w => w.id)).toEqual(['primary', 'w_a'])
    expect(await RNFS.readFile(ASIDE, 'utf8')).toBe(TORN)
  })

  test('a boot with no list and nothing set aside never lists the Keychain', async () => {
    await RNFS.unlink(REGISTRY)
    keychain.set(seedService('primary'), WORDS)
    keychain.set(seedService('w_a'), OTHER)

    expect(await settleActiveWallet()).toBe(true)

    expect(Keychain.getAllGenericPasswordServices).not.toHaveBeenCalled()
    expect(await registryText()).toBeNull()
  })

  test('after a repair that found no seed, each boot asks again until a list is written', async () => {
    expect(await settleActiveWallet()).toBe(false)
    expect(await settleActiveWallet()).toBe(false)
    expect(Keychain.getAllGenericPasswordServices).toHaveBeenCalledTimes(2)

    await addFirstWallet(WORDS, undefined, 'drawn')
    jest.mocked(Keychain.getAllGenericPasswordServices).mockClear()

    expect(await settleActiveWallet()).toBe(true)
    expect(Keychain.getAllGenericPasswordServices).not.toHaveBeenCalled()
  })

  test('two boots in flight write the list once', async () => {
    keychain.set(seedService('primary'), WORDS)
    keychain.set(seedService('w_a'), OTHER)
    const asides = jest.spyOn(RNFS, 'moveFile')
    // Jest maps the spec to its in-memory double, which is never null.
    const renames = jest.spyOn(NativeVoltzDurable as NonNullable<typeof NativeVoltzDurable>, 'rename')

    expect(await Promise.all([settleActiveWallet(), settleActiveWallet()])).toEqual([true, true])

    // One move sets the torn file aside and one rename puts the finished copy in.
    expect(asides).toHaveBeenCalledTimes(1)
    expect(renames).toHaveBeenCalledTimes(1)
    expect((await loadRegistry()).wallets.map(w => w.id)).toEqual(['primary', 'w_a'])
    expect(await RNFS.readFile(ASIDE, 'utf8')).toBe(TORN)
    asides.mockRestore()
    renames.mockRestore()
  })

  test.each([
    ['the listing', () => jest.mocked(Keychain.getAllGenericPasswordServices).mockRejectedValueOnce(new Error('keychain unavailable'))],
    ['a presence read', () => unreadable.add(seedService('w_a'))],
    ['a seed read', () => jest.mocked(Keychain.getGenericPassword).mockRejectedValueOnce(new Error('keychain unavailable'))],
    ['a fingerprint', () => jest.mocked(fingerprintFromMnemonicAsync).mockRejectedValueOnce(new Error('derivation failed'))],
  ])('a repair rejects and writes nothing when %s throws', async (_what, fail) => {
    keychain.set(seedService('primary'), WORDS)
    keychain.set(seedService('w_a'), OTHER)
    fail()
    const before = await disk()

    await expect(settleActiveWallet()).rejects.toThrow()

    expect(await disk()).toEqual(before)
  })

  test('a seed that answers present and reads empty rejects and writes nothing', async () => {
    keychain.set(seedService('primary'), WORDS)
    jest.mocked(Keychain.getGenericPassword).mockResolvedValueOnce(false)
    const before = await disk()

    await expect(settleActiveWallet()).rejects.toThrow('answered present and read empty')

    expect(await disk()).toEqual(before)
  })

  test('a list read that fails for another reason propagates without a repair', async () => {
    keychain.set(seedService('primary'), WORDS)
    const before = await disk()
    const exists = jest.spyOn(RNFS, 'exists').mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(settleActiveWallet()).rejects.toThrow('disk unavailable')

    exists.mockRestore()
    expect(Keychain.getAllGenericPasswordServices).not.toHaveBeenCalled()
    expect(await disk()).toEqual(before)
  })

  test('a list that reads is never rebuilt', async () => {
    await writeRegistry({ wallets: [{ id: 'w_a', fingerprint: 'aaaa1111' }], active: 'w_a' })
    keychain.set(seedService('w_a'), WORDS)
    keychain.set(seedService('primary'), OTHER)

    expect(await settleActiveWallet()).toBe(true)

    expect(Keychain.getAllGenericPasswordServices).not.toHaveBeenCalled()
    expect(await loadRegistry()).toEqual({ wallets: [{ id: 'w_a', fingerprint: 'aaaa1111' }], active: 'w_a' })
  })
})
