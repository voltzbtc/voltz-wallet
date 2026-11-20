import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import {
  ensureRegistered,
  loadRegistry,
  registerWallet,
  removeWalletEntry,
  reorder,
  reorderWallets,
  type WalletEntry,
} from '../src/wallet/walletRegistry'

describe('registerWallet', () => {
  it('adds the first wallet and makes it active', () => {
    const r = registerWallet({ wallets: [], active: null }, 'primary', 'aaaa')
    expect(r.wallets).toEqual([{ id: 'primary', fingerprint: 'aaaa' }])
    expect(r.active).toBe('primary')
  })

  it('adds a second wallet without changing the active one', () => {
    const r = registerWallet(
      { wallets: [{ id: 'primary', fingerprint: 'aaaa' }], active: 'primary' },
      'w_1',
      'bbbb',
    )
    expect(r.wallets.map(w => w.id)).toEqual(['primary', 'w_1'])
    expect(r.active).toBe('primary')
  })

  it('refreshes the fingerprint of an existing wallet and keeps the active pointer', () => {
    const r = registerWallet(
      { wallets: [{ id: 'primary', fingerprint: 'aaaa' }], active: 'primary' },
      'primary',
      'cccc',
    )
    expect(r.wallets).toEqual([{ id: 'primary', fingerprint: 'cccc' }])
    expect(r.active).toBe('primary')
  })
})

describe('reorder', () => {
  const reg = {
    wallets: [
      { id: 'primary', fingerprint: 'aaaa' },
      { id: 'w_1', fingerprint: 'bbbb' },
      { id: 'w_2', fingerprint: 'cccc' },
    ] satisfies WalletEntry[],
    active: 'w_1',
  }

  it('repositions wallets to the given id order and keeps the active pointer', () => {
    const r = reorder(reg, ['w_2', 'primary', 'w_1'])
    expect(r.wallets.map(w => w.id)).toEqual(['w_2', 'primary', 'w_1'])
    expect(r.active).toBe('w_1')
  })

  it('keeps a wallet missing from the id list, appended at the end', () => {
    const r = reorder(reg, ['w_2', 'w_1'])
    expect(r.wallets.map(w => w.id)).toEqual(['w_2', 'w_1', 'primary'])
  })

  it('ignores ids that are not in the registry', () => {
    const r = reorder(reg, ['ghost', 'w_1', 'primary', 'w_2'])
    expect(r.wallets.map(w => w.id)).toEqual(['w_1', 'primary', 'w_2'])
  })
})

// The writers over the in-memory fs and a Keychain presence read the test controls.
describe('registry writers', () => {
  const FILE = `${RNFS.DocumentDirectoryPath}/wallets.json`
  const seeds = new Set<string>()
  const SEED = 'com.voltz.wallet.seed'

  beforeEach(async () => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    seeds.clear()
    jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options => seeds.has(options?.service ?? ''))
    seeds.add(SEED)
    seeds.add(`${SEED}.w_1`)
    seeds.add(`${SEED}.w_2`)
    await RNFS.writeFile(
      FILE,
      JSON.stringify({
        wallets: [
          { id: 'primary', fingerprint: 'aaaa' },
          { id: 'w_1', fingerprint: 'bbbb' },
        ],
        active: 'primary',
      }),
      'utf8',
    )
  })

  afterEach(() => {
    slow?.mockRestore()
    slow = undefined
    jest.mocked(Keychain.hasGenericPassword).mockImplementation(async () => false)
  })

  // A write that takes a moment, as a native file write does, so both writers have read the file
  // before either writes unless something orders them.
  const realWrite = RNFS.writeFile.bind(RNFS)
  let slow: jest.SpyInstance | undefined
  function slowWrites(): void {
    slow = jest.spyOn(RNFS, 'writeFile').mockImplementation(async (path, content, encoding) => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return realWrite(path, content, encoding)
    })
  }

  it('lands a reorder and a register sent together, neither losing the other', async () => {
    slowWrites()
    await Promise.all([reorderWallets(['w_1', 'primary']), ensureRegistered('w_2', 'cccc')])
    const reg = await loadRegistry()
    expect(reg.wallets.map(w => w.id)).toEqual(['w_1', 'primary', 'w_2'])
    expect(reg.active).toBe('primary')
  })

  it('lands a register and a removal sent together', async () => {
    slowWrites()
    await Promise.all([ensureRegistered('w_2', 'cccc'), removeWalletEntry('w_1')])
    expect((await loadRegistry()).wallets.map(w => w.id)).toEqual(['primary', 'w_2'])
  })

  it('lists nothing for a wallet whose seed is not on this device', async () => {
    const before = await RNFS.readFile(FILE, 'utf8')
    await ensureRegistered('w_gone', 'dddd')
    expect(await RNFS.readFile(FILE, 'utf8')).toBe(before)
  })

  it('asks for the seed when its turn comes, so a register queued before a removal never lists the wallet', async () => {
    const written: string[] = []
    slow = jest.spyOn(RNFS, 'writeFile').mockImplementation(async (path, content, encoding) => {
      await new Promise(resolve => setTimeout(resolve, 5))
      // A write lands whole in the temporary copy first, which then replaces the file.
      if (path === `${FILE}.tmp`) {
        written.push(content)
      }
      return realWrite(path, content, encoding)
    })
    // A reorder holds the queue while a connect asks to list w_2, and the removal of w_2 then
    // deletes its seed and its entry.
    const reordered = reorderWallets(['w_1', 'primary'])
    const register = ensureRegistered('w_2', 'cccc')
    seeds.delete(`${SEED}.w_2`)
    await Promise.all([reordered, register, removeWalletEntry('w_2')])
    expect(written.length).toBeGreaterThan(0)
    expect(written.some(content => content.includes('"w_2"'))).toBe(false)
    expect((await loadRegistry()).wallets.map(w => w.id)).toEqual(['w_1', 'primary'])
  })

  it('writes nothing and rejects when the seed presence cannot be read', async () => {
    const before = await RNFS.readFile(FILE, 'utf8')
    jest.mocked(Keychain.hasGenericPassword).mockRejectedValueOnce(new Error('keychain unavailable'))
    await expect(ensureRegistered('w_2', 'cccc')).rejects.toThrow('keychain unavailable')
    expect(await RNFS.readFile(FILE, 'utf8')).toBe(before)
    // A failed writer does not stall the queue for the next one.
    await ensureRegistered('w_2', 'cccc')
    expect((await loadRegistry()).wallets.map(w => w.id)).toEqual(['primary', 'w_1', 'w_2'])
  })
})
