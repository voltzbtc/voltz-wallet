import { readFileSync } from 'fs'
import { join } from 'path'
import { Platform } from 'react-native'
import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import {
  addAndActivateWallet,
  addFirstPasskeyWallet,
  addFirstWallet,
  addPasskeyWallet,
  eraseAllWallets,
  removeWallet,
  removeWalletById,
} from '../src/wallet/wallet'
import {
  PASSKEY_LIVE,
  __setPasskeyLiveForTests,
  activeWalletOwingWords,
  notePasskeyWallet,
  passkeyAttempt,
  passkeyEntryFor,
  passkeyRemovalNote,
  passkeyWordsOwed,
  type PasskeyWallet,
} from '../src/wallet/passkey'
import { connectActiveSpark, connectSpark } from '../src/wallet/spark'
import { loadPassphraseFor, loadSeedFor, savePassphraseFor } from '../src/wallet/seed'
import { getActiveWalletId, loadRegistry } from '../src/wallet/walletRegistry'
import { importCheckDue } from '../src/wallet/deletionMark'
import { clearUnconfirmed, isUnconfirmed } from '../src/wallet/backupMark'
import { fingerprintFromMnemonicAsync } from '../src/wallet/fingerprint'

const { __authenticator: auth } =
  require('@breeztech/breez-sdk-spark-react-native/passkey-prf-provider') as typeof import('../__mocks__/@breeztech/breez-sdk-spark-react-native/passkey-prf-provider')

jest.mock('../src/wallet/spark', () => ({
  ...jest.requireActual('../src/wallet/spark'),
  connectActiveSpark: jest.fn(async () => undefined),
  connectSpark: jest.fn(async () => undefined),
  disconnectSpark: jest.fn(async () => undefined),
  sparkEraseLocalData: jest.fn(async () => undefined),
}))

const FILE = `${RNFS.DocumentDirectoryPath}/passkey-wallets.json`
const TYPED = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'

const keychain = new Map<string, string>()
// Every step that touches the seed or a connection, in the order they happen.
const steps: string[] = []

const stored = async (): Promise<Record<string, Record<string, unknown>>> =>
  JSON.parse(await RNFS.readFile(FILE, 'utf8'))

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  keychain.clear()
  steps.length = 0
  jest.clearAllMocks()
  auth.reset()
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' })
  Object.defineProperty(Platform, 'Version', { configurable: true, get: () => '18.2' })
  __setPasskeyLiveForTests(true)
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    keychain.set(options?.service ?? '', password)
    steps.push(`keychain:${_user}`)
    return false
  })
  jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
    const password = keychain.get(options?.service ?? '')
    return password === undefined ? false : ({ username: 'u', password } as never)
  })
  jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options => keychain.has(options?.service ?? ''))
  jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => keychain.delete(options?.service ?? ''))
  jest.mocked(connectActiveSpark).mockImplementation(async () => {
    steps.push('connect')
  })
  jest.mocked(connectSpark).mockImplementation((async () => {
    steps.push('connect')
  }) as never)
})

afterEach(() => {
  __setPasskeyLiveForTests(false)
  jest.restoreAllMocks()
})

// The one file refuses to be written, as a full disk would refuse it, and the rest of the device works.
function refuseThePasskeyFile(): void {
  const original = RNFS.writeFile
  jest.spyOn(RNFS, 'writeFile').mockImplementation(async (path, content) => {
    if (String(path).includes('passkey-wallets')) {
      throw new Error('disk full')
    }
    await (original as (at: string, text: string) => Promise<void>)(String(path), content)
  })
}

const created = (): Promise<PasskeyWallet> => passkeyAttempt('register')()
const restored = (): Promise<PasskeyWallet> => passkeyAttempt('restore')()

describe('the words are stored before anything else happens', () => {
  test('the seed lands, then the connection', async () => {
    const id = await addFirstPasskeyWallet(await passkeyAttempt('connect')())
    await connectActiveSpark()

    expect(await loadSeedFor(id)).not.toBeNull()
    expect(steps.filter(step => step === 'connect' || step === 'keychain:seed')).toEqual(['keychain:seed', 'connect'])
  })

  test('an added wallet the same', async () => {
    await addFirstWallet(TYPED, undefined, 'typed')
    steps.length = 0
    await addPasskeyWallet(await created())
    await connectActiveSpark()
    expect(steps.filter(step => step === 'connect' || step === 'keychain:seed')).toEqual(['keychain:seed', 'connect'])
  })

  test('nothing connects inside the add', async () => {
    await addFirstPasskeyWallet(await created())
    expect(steps).not.toContain('connect')
  })

  test('a Keychain that refuses leaves no wallet behind', async () => {
    const wallet = await created()
    jest.mocked(Keychain.setGenericPassword).mockImplementation(async (user, password, options) => {
      if (user === 'seed') {
        throw new Error('keychain full')
      }
      keychain.set(options?.service ?? '', password)
      return false
    })
    await expect(addFirstPasskeyWallet(wallet)).rejects.toThrow('keychain full')
    expect((await loadRegistry()).wallets).toEqual([])
    expect(await getActiveWalletId()).toBeNull()
  })

  // A sign-in cannot tell this from a new phone, so the words are owed even for a passkey that syncs.
  test('killed before the write, the same tap refinds the same words and owes them', async () => {
    const first = await created()
    __setPasskeyLiveForTests(true)
    const again = await passkeyAttempt('connect')()
    expect(again.mnemonic).toBe(first.mnemonic)
    expect((await loadRegistry()).wallets).toEqual([])
    expect(auth.calls.createPasskey).toBe(1)

    const id = await addFirstPasskeyWallet(again)
    expect(await passkeyWordsOwed(id)).toBe(true)
    expect(await activeWalletOwingWords()).toBe(id)
  })
})

describe('a stored wallet claims its credential', () => {
  const strandOne = async () => {
    auth.prfAtCreate = false
    auth.failures.deriveSeeds.push({ code: 'ERR_USER_CANCELLED', message: 'User cancelled authentication' })
    await expect(created()).rejects.toThrow()
    auth.prfAtCreate = true
  }

  test('a first wallet', async () => {
    await addFirstPasskeyWallet(await created())
    await created()
    expect(auth.calls.createPasskey).toBe(2)
  })

  test('an added wallet', async () => {
    await addFirstWallet(TYPED, undefined, 'typed')
    await addPasskeyWallet(await created())
    await created()
    expect(auth.calls.createPasskey).toBe(2)
  })

  test('a store that fails claims nothing', async () => {
    const wallet = await created()
    jest.mocked(Keychain.setGenericPassword).mockRejectedValueOnce(new Error('keychain full'))
    await expect(addFirstPasskeyWallet(wallet)).rejects.toThrow('keychain full')
    await created()
    expect(auth.calls.createPasskey).toBe(1)
  })

  test('an add cut after the seed claims nothing, and landing on that wallet claims it', async () => {
    await addFirstWallet(TYPED, undefined, 'typed')
    const wallet = await created()
    await addAndActivateWallet(wallet.mnemonic, undefined, 'passkeyCreated', wallet.note)
    await addPasskeyWallet(await created())
    expect(auth.calls.createPasskey).toBe(1)
    expect((await loadRegistry()).wallets).toHaveLength(2)

    await created()
    expect(auth.calls.createPasskey).toBe(2)
  })

  test('a restore that found the stranded credential claims it', async () => {
    await strandOne()
    await addFirstPasskeyWallet(await restored())
    await created()
    expect(auth.calls.createPasskey).toBe(2)
  })

  test('a restore that found another passkey leaves it waiting', async () => {
    const first = await created()
    await addFirstPasskeyWallet(first)
    await strandOne()
    expect(auth.calls.createPasskey).toBe(2)

    const other = await restored()
    expect(other.mnemonic).toBe(first.mnemonic)
    await addPasskeyWallet(other)

    await created()
    expect(auth.calls.createPasskey).toBe(2)
    expect(auth.lastAllow).toHaveLength(1)
  })
})

describe('one row for one key', () => {
  test('the same words twice switch to the wallet already here', async () => {
    const first = await created()
    await addFirstPasskeyWallet(first)
    await addFirstWallet(TYPED, undefined, 'typed')
    await addAndActivateWallet('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
    const before = await getActiveWalletId()
    const id = await addPasskeyWallet(await restored())

    const { wallets } = await loadRegistry()
    expect(wallets.filter(w => w.id === id)).toHaveLength(1)
    expect(wallets).toHaveLength(3)
    expect(id).not.toBe(before)
    expect(await getActiveWalletId()).toBe(id)
    expect(connectActiveSpark).toHaveBeenCalledTimes(1)
  })

  test('a passkey wallet that was typed in keeps its row and gains the note', async () => {
    const wallet = await created()
    await addFirstWallet(wallet.mnemonic, undefined, 'typed')
    const id = await addPasskeyWallet(await restored())
    expect((await loadRegistry()).wallets).toHaveLength(1)
    expect((await passkeyEntryFor(id))?.credentialId).toBe(wallet.note.credentialId)
    expect(await isUnconfirmed(id)).toBe(false)
  })

  test('a note that cannot be stored does not stop the switch', async () => {
    const wallet = await created()
    await addFirstPasskeyWallet(wallet)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    refuseThePasskeyFile()
    const id = await addPasskeyWallet(await restored())
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('passkey note not kept'))
    expect(await getActiveWalletId()).toBe(id)
  })

  test('any other failure of the add is not read as a twin', async () => {
    const wallet = await created()
    jest.mocked(Keychain.setGenericPassword).mockRejectedValue(new Error('keychain full'))
    await expect(addPasskeyWallet(wallet)).rejects.toThrow('keychain full')
    expect(connectActiveSpark).not.toHaveBeenCalled()
  })
})

describe('a passkey wallet has no passphrase', () => {
  test('stores an empty one, even over one an earlier wallet left on the id', async () => {
    await savePassphraseFor('primary', 'left behind')
    const wallet = await created()
    const id = await addFirstPasskeyWallet(wallet)
    expect(id).toBe('primary')
    expect(await loadPassphraseFor(id)).toBeUndefined()
    const { wallets } = await loadRegistry()
    expect(wallets[0].fingerprint).toBe(await fingerprintFromMnemonicAsync(wallet.mnemonic))
  })

  test('the id it carries is of the words alone', async () => {
    const wallet = await created()
    const id = await addPasskeyWallet(wallet)
    expect(await loadPassphraseFor(id)).toBeUndefined()
    expect((await passkeyEntryFor(id))?.fingerprint).toBe(await fingerprintFromMnemonicAsync(wallet.mnemonic))
  })
})

describe('the words are still owed', () => {
  test('a passkey created and not known to sync owes them, past a kill', async () => {
    auth.backupEligible = false
    const id = await addFirstPasskeyWallet(await created())
    expect(await passkeyWordsOwed(id)).toBe(true)
    expect(await activeWalletOwingWords()).toBe(id)
    await clearUnconfirmed(id)
    expect(await passkeyWordsOwed(id)).toBe(false)
    expect(await activeWalletOwingWords()).toBeNull()
  })

  test('an authenticator that says nothing owes them too', async () => {
    auth.backupEligible = null
    const id = await addFirstPasskeyWallet(await created())
    expect(await passkeyWordsOwed(id)).toBe(true)
  })

  test('a tap on Create that lands on a sign-in owes them, since it proves nothing', async () => {
    const wallet = await created()
    __setPasskeyLiveForTests(true)
    const id = await addFirstPasskeyWallet(await passkeyAttempt('connect')())
    expect(await passkeyEntryFor(id)).toMatchObject({ created: false, fromCreate: true, backupEligible: null })
    expect(await loadSeedFor(id)).toBe(wallet.mnemonic)
    expect(await importCheckDue(id)).toBe(true)
    expect(await passkeyWordsOwed(id)).toBe(true)
  })

  test('the restore button owes none for the same passkey, the control for the one above', async () => {
    await created()
    __setPasskeyLiveForTests(true)
    const id = await addFirstPasskeyWallet(await restored())
    expect(await passkeyEntryFor(id)).toMatchObject({ created: false, fromCreate: false, backupEligible: null })
    expect(await passkeyWordsOwed(id)).toBe(false)
  })

  test('a restore over a cut write from Create does not settle what that write owed', async () => {
    auth.backupEligible = null
    const wallet = await created()
    await notePasskeyWallet('primary', await fingerprintFromMnemonicAsync(wallet.mnemonic), wallet.note)
    __setPasskeyLiveForTests(true)
    const id = await addFirstPasskeyWallet(await restored())
    expect(id).toBe('primary')
    expect(await passkeyWordsOwed(id)).toBe(true)
  })

  test('a passkey that syncs does not, and its card still waits for the wallet to hold value', async () => {
    const id = await addFirstPasskeyWallet(await created())
    expect(await passkeyWordsOwed(id)).toBe(false)
    expect(await isUnconfirmed(id)).toBe(true)
  })

  test('a restore goes through the import door without counting as proof', async () => {
    const wallet = await created()
    auth.calls.createPasskey = 0
    const id = await addFirstPasskeyWallet(await restored())
    expect(auth.calls.createPasskey).toBe(0)
    expect(await loadSeedFor(id)).toBe(wallet.mnemonic)
    expect(await importCheckDue(id)).toBe(true)
    expect(await isUnconfirmed(id)).toBe(true)
    expect(await passkeyWordsOwed(id)).toBe(false)
  })

  test('the same restore through Add wallet', async () => {
    await addFirstWallet(TYPED, undefined, 'typed')
    await created()
    const id = await addPasskeyWallet(await restored())
    expect(await importCheckDue(id)).toBe(true)
    expect(await isUnconfirmed(id)).toBe(true)
  })

  test('typed words stay proved, the control for the two above', async () => {
    const id = await addFirstWallet(TYPED, undefined, 'typed')
    expect(await importCheckDue(id)).toBe(true)
    expect(await isUnconfirmed(id)).toBe(false)
  })

  test('a created wallet has no past to check', async () => {
    const id = await addFirstPasskeyWallet(await created())
    expect(await importCheckDue(id)).toBe(false)
  })

  test('a sign-in after a cut write keeps what the registration recorded', async () => {
    auth.backupEligible = false
    const wallet = await created()
    await notePasskeyWallet('primary', await fingerprintFromMnemonicAsync(wallet.mnemonic), wallet.note)
    __setPasskeyLiveForTests(true)
    const id = await addFirstPasskeyWallet(await restored())
    expect(id).toBe('primary')
    expect(await passkeyEntryFor(id)).toMatchObject({
      created: true,
      backupEligible: false,
      userName: wallet.note.userName,
    })
    expect(await passkeyWordsOwed(id)).toBe(true)
  })
})

describe('removing a wallet forgets its passkey', () => {
  test('the entry goes with the wallet and the others stay', async () => {
    const first = await addFirstPasskeyWallet(await created())
    const second = await addPasskeyWallet(await created())
    await removeWallet(second, '')
    const left = await stored()
    expect(Object.keys(left)).toEqual([first])
  })

  test('an active wallet too', async () => {
    const first = await addFirstPasskeyWallet(await created())
    const second = await addPasskeyWallet(await created())
    await removeWalletById(second, '')
    expect(await getActiveWalletId()).toBe(first)
    expect(Object.keys(await stored())).toEqual([first])
  })

  test('erasing everything leaves none', async () => {
    await addFirstPasskeyWallet(await created())
    await addPasskeyWallet(await created())
    await eraseAllWallets()
    expect(await stored()).toEqual({})
  })

  test('a file that cannot be written does not stop the removal', async () => {
    const id = await addFirstPasskeyWallet(await created())
    const other = await addPasskeyWallet(await created())
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    refuseThePasskeyFile()
    await removeWallet(other, '')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('passkey note not cleared'))
    expect((await loadRegistry()).wallets.map(w => w.id)).toEqual([id])
  })

  test('the screens get the line that says where the passkey is deleted, only for a passkey wallet', async () => {
    const passkey = await addFirstPasskeyWallet(await created())
    const words = await addAndActivateWallet(TYPED, undefined, 'typed')
    await expect(passkeyRemovalNote(passkey)).resolves.toBe('passkey.deleteIos')
    await expect(passkeyRemovalNote(words)).resolves.toBeNull()
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' })
    await expect(passkeyRemovalNote(passkey)).resolves.toBe('passkey.deleteAndroid')
    __setPasskeyLiveForTests(false)
    await expect(passkeyRemovalNote(passkey)).resolves.toBeNull()
  })
})

describe('the file', () => {
  test('never holds the words or a secret, and lands beside the registry', async () => {
    const wallet = await created()
    const id = await addFirstPasskeyWallet(wallet)
    const raw = await RNFS.readFile(FILE, 'utf8')
    for (const word of new Set(wallet.mnemonic.split(' '))) {
      expect(JSON.parse(raw)[id]).not.toEqual(expect.objectContaining({ mnemonic: expect.anything() }))
      expect(raw.split(/[^a-z]+/)).not.toContain(word)
    }
    expect(Object.keys(JSON.parse(raw)[id]).sort()).toEqual(
      [
        'aaguid',
        'at',
        'backupEligible',
        'created',
        'credentialId',
        'fingerprint',
        'fromCreate',
        'label',
        'rpId',
        'userName',
      ].sort(),
    )
    expect(JSON.parse(raw)[id]).toMatchObject({ rpId: 'usevoltz.app', label: 'Default' })
  })

  test('nothing reaches wallets.json', async () => {
    await addFirstPasskeyWallet(await created())
    const raw = await RNFS.readFile(`${RNFS.DocumentDirectoryPath}/wallets.json`, 'utf8')
    expect(raw).not.toContain('credentialId')
  })

  test('a note that cannot be stored stops the add before the seed', async () => {
    const wallet = await created()
    refuseThePasskeyFile()
    await expect(addFirstPasskeyWallet(wallet)).rejects.toThrow('disk full')
    expect(await loadSeedFor('primary')).toBeNull()
  })

  test('an entry a kill left behind does not answer for the next words on that id', async () => {
    auth.backupEligible = false
    const wallet = await created()
    jest.mocked(Keychain.setGenericPassword).mockImplementationOnce(async () => {
      throw new Error('killed')
    })
    await addFirstPasskeyWallet(wallet).catch(() => undefined)
    const id = await addFirstWallet(TYPED, undefined, 'typed')
    expect(id).toBe('primary')
    expect(await passkeyEntryFor(id)).toBeNull()
    expect(await passkeyWordsOwed(id)).toBe(false)
  })

  test('a torn file is written over and answers for nothing', async () => {
    const id = await addFirstPasskeyWallet(await created())
    await RNFS.writeFile(FILE, '{"primary":', 'utf8')
    await expect(passkeyEntryFor(id)).rejects.toMatchObject({ name: 'UnreadableFile' })
    await expect(passkeyWordsOwed(id)).resolves.toBe(false)
    await expect(passkeyRemovalNote(id)).resolves.toBeNull()
    await addPasskeyWallet(await created())
    expect(Object.keys(await stored())).toHaveLength(1)
  })

  test('off, reading what a wallet owes touches no file', async () => {
    const id = await addFirstPasskeyWallet(await created())
    __setPasskeyLiveForTests(false)
    const read = jest.spyOn(RNFS, 'readFile')
    await expect(passkeyWordsOwed(id)).resolves.toBe(false)
    await expect(activeWalletOwingWords()).resolves.toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
})

describe('the switch and the entitlement agree', () => {
  const ENTITLEMENTS = join(__dirname, '../ios/VoltzWallet/VoltzWallet.entitlements')
  const SOURCE = join(__dirname, '../src/wallet/passkey.ts')

  const live = (source: string): boolean => {
    const found = source.match(/^export const PASSKEY_LIVE = (true|false)$/m)
    if (!found) {
      throw new Error('PASSKEY_LIVE is not a plain constant')
    }
    return found[1] === 'true'
  }
  // Only the array under the associated domains key grants the domain, which a string anywhere else
  // in the file does not.
  const entitled = (plist: string): boolean =>
    /<key>com\.apple\.developer\.associated-domains<\/key>\s*<array>(?:(?!<\/array>)[\s\S])*<string>webcredentials:usevoltz\.app<\/string>/.test(
      plist,
    )

  test('neither is on in this tree, or both are', () => {
    const source = readFileSync(SOURCE, 'utf8')
    const plist = readFileSync(ENTITLEMENTS, 'utf8')
    expect(plist).toContain('aps-environment')
    expect(live(source)).toBe(PASSKEY_LIVE)
    expect(live(source)).toBe(entitled(plist))
  })

  test('the check can fail in either direction', () => {
    expect(live('export const PASSKEY_LIVE = true\n')).not.toBe(entitled('<dict></dict>'))
    expect(live('export const PASSKEY_LIVE = false\n')).not.toBe(
      entitled(
        '<key>com.apple.developer.associated-domains</key><array><string>webcredentials:usevoltz.app</string></array>',
      ),
    )
    expect(
      entitled(
        '<key>com.apple.developer.associated-domains</key><array></array>' +
          '<key>other</key><array><string>webcredentials:usevoltz.app</string></array>',
      ),
    ).toBe(false)
    expect(() => live('export const PASSKEY_LIVE = !false\n')).toThrow('plain constant')
  })
})
