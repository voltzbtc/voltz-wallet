import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import { addAndActivateWallet, addFirstWallet, removeWallet, settleActiveWallet } from '../src/wallet/wallet'
import { isUnconfirmed, markUnconfirmed } from '../src/wallet/backupMark'
import { fingerprintFromMnemonic } from '../src/wallet/fingerprint'
import { loadRegistry } from '../src/wallet/walletRegistry'

jest.mock('../src/wallet/spark', () => ({
  connectActiveSpark: jest.fn(),
  connectSpark: jest.fn(),
  disconnectSpark: jest.fn(async () => undefined),
  disconnectSparkWhenIdle: jest.fn(async () => undefined),
  SparkReconnectBusy: class extends Error {},
}))

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'
const SEED = 'com.voltz.wallet.seed'
const MARKS = `${RNFS.DocumentDirectoryPath}/backup-marks.json`

const keychain = new Map<string, string>()

// A wallet the registry lists with its seed on no device here, as after an iPhone restore.
const listLost = (id: string, fingerprint: string): Promise<void> =>
  RNFS.writeFile(
    `${RNFS.DocumentDirectoryPath}/wallets.json`,
    JSON.stringify({ active: id, wallets: [{ id, fingerprint }] }),
    'utf8',
  )

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  keychain.clear()
  jest.mocked(Keychain.setGenericPassword).mockReset()
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    keychain.set(options?.service ?? '', password)
    return false
  })
  jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
    const password = keychain.get(options?.service ?? '')
    return password === undefined ? false : ({ username: 'u', password } as never)
  })
  jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options => keychain.has(options?.service ?? ''))
  jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => keychain.delete(options?.service ?? ''))
})

const seedWrite = (service: string | undefined) => service?.startsWith(SEED) === true

describe.each([
  ['addFirstWallet', (words: string) => addFirstWallet(words, undefined, 'drawn')],
  ['addAndActivateWallet', (words: string) => addAndActivateWallet(words)],
])('%s', (_name, add) => {
  test('words shown and not proved carry the mark', async () => {
    expect(await isUnconfirmed(await add(WORDS))).toBe(true)
  })

  test('the mark is on disk before the seed write starts', async () => {
    let markSeen: boolean | null = null
    jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
      if (seedWrite(options?.service)) {
        markSeen = await RNFS.exists(MARKS)
      }
      keychain.set(options?.service ?? '', password)
      return false
    })
    await add(WORDS)
    expect(markSeen).toBe(true)
  })

  // A write that fails is what a kill between the two looks like from the file's side.
  test('a seed that could not be written leaves the mark and no wallet', async () => {
    jest.mocked(Keychain.setGenericPassword).mockRejectedValue(new Error('interaction not allowed'))
    await expect(add(WORDS)).rejects.toThrow('interaction not allowed')
    expect(JSON.parse(await RNFS.readFile(MARKS, 'utf8'))).toHaveLength(1)
    expect([...keychain.keys()].filter(service => seedWrite(service))).toEqual([])
  })

  test('a mark that could not be written stops the add before the seed', async () => {
    const write = jest.spyOn(RNFS, 'writeFile').mockRejectedValueOnce(new Error('disk full'))
    await expect(add(WORDS)).rejects.toThrow('disk full')
    write.mockRestore()
    expect(jest.mocked(Keychain.setGenericPassword)).not.toHaveBeenCalled()
    expect([...keychain.keys()].filter(service => seedWrite(service))).toEqual([])
  })
})

describe('a first write repeated', () => {
  const REGISTRY = `${RNFS.DocumentDirectoryPath}/wallets.json`

  // The one read that comes after the registry line is the presence check of the move to active.
  function failOnceListed(): void {
    let armed = true
    jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options => {
      if (armed && (await RNFS.exists(REGISTRY))) {
        armed = false
        throw new Error('keychain busy')
      }
      return keychain.has(options?.service ?? '')
    })
  }

  test.each([
    ['drawn', 'drawn'],
    ['typed', 'typed'],
  ] as const)('after failing past the registry line, %s words keep their one row', async (_name, origin) => {
    failOnceListed()
    await expect(addFirstWallet(WORDS, undefined, origin)).rejects.toThrow('keychain busy')
    expect((await loadRegistry()).wallets.map(wallet => wallet.id)).toEqual(['primary'])

    expect(await addFirstWallet(WORDS, undefined, origin)).toBe('primary')
    expect((await loadRegistry()).wallets.map(wallet => wallet.id)).toEqual(['primary'])
  })

  test('other words after a failure still take an id of their own', async () => {
    failOnceListed()
    await expect(addFirstWallet(WORDS, undefined, 'drawn')).rejects.toThrow('keychain busy')

    expect(await addFirstWallet(OTHER, undefined, 'drawn')).not.toBe('primary')
    expect((await loadRegistry()).wallets).toHaveLength(2)
  })
})

describe('words that were typed', () => {
  test('never carry the mark, in the first run or added later', async () => {
    const first = await addFirstWallet(WORDS, undefined, 'typed')
    const second = await addAndActivateWallet(OTHER, undefined, 'typed')
    expect(await isUnconfirmed(first)).toBe(false)
    expect(await isUnconfirmed(second)).toBe(false)
    expect(await RNFS.exists(MARKS)).toBe(false)
  })

  test('take back a listed wallet whose seed is absent, and clear its mark, since they prove the words', async () => {
    const fingerprint = fingerprintFromMnemonic(WORDS)
    await listLost('w_lost', fingerprint)
    await markUnconfirmed('w_lost')

    expect(await addFirstWallet(WORDS, undefined, 'typed')).toBe('w_lost')
    expect(await isUnconfirmed('w_lost')).toBe(false)
  })

  test('clear the mark a kill left on the primary id', async () => {
    await markUnconfirmed('primary')
    expect(await addFirstWallet(WORDS, undefined, 'typed')).toBe('primary')
    expect(await isUnconfirmed('primary')).toBe(false)
  })

  test('a clear that fails leaves the mark and the wallet is added all the same', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    await markUnconfirmed('primary')
    const write = jest.spyOn(RNFS, 'writeFile').mockRejectedValueOnce(new Error('disk full'))
    expect(await addFirstWallet(WORDS, undefined, 'typed')).toBe('primary')
    expect(await isUnconfirmed('primary')).toBe(true)
    write.mockRestore()
    warn.mockRestore()
  })
})

test('a phrase confirmed before the add starts with no mark, and clears one the id held', async () => {
  const fingerprint = fingerprintFromMnemonic(WORDS)
  await listLost('w_lost', fingerprint)
  await markUnconfirmed('w_lost')

  expect(await addAndActivateWallet(WORDS, undefined, 'confirmed')).toBe('w_lost')
  expect(await isUnconfirmed('w_lost')).toBe(false)
  expect(await isUnconfirmed(await addAndActivateWallet(OTHER, undefined, 'confirmed'))).toBe(false)
})

describe('removing a wallet', () => {
  test('takes its mark with it and leaves the others', async () => {
    const first = await addFirstWallet(WORDS, undefined, 'drawn')
    const second = await addAndActivateWallet(OTHER)
    await removeWallet(first, fingerprintFromMnemonic(WORDS))
    expect(await isUnconfirmed(first)).toBe(false)
    expect(await isUnconfirmed(second)).toBe(true)
  })

  test('that fails before the seed goes keeps the mark, since the wallet is still here', async () => {
    const id = await addFirstWallet(WORDS, undefined, 'drawn')
    jest.mocked(Keychain.resetGenericPassword).mockRejectedValueOnce(new Error('interaction not allowed'))
    await expect(removeWallet(id, fingerprintFromMnemonic(WORDS))).rejects.toThrow('interaction not allowed')
    expect(await isUnconfirmed(id)).toBe(true)
    expect(keychain.has(SEED)).toBe(true)
  })
})

test('a mark with no wallet behind it opens nothing at boot', async () => {
  await markUnconfirmed('primary')
  expect(await settleActiveWallet()).toBe(false)
  expect((await loadRegistry()).wallets).toEqual([])
})
