import RNFS from 'react-native-fs'
import {
  isTokenIdentifier,
  mergeCatalog,
  loadHomeTokens,
  loadCatalog,
  isListed,
  addToken,
  removeToken,
  forgetTokenPrefs,
  NoWalletInFront,
} from '../src/wallet/tokenPrefs'
import { USDB, DEPIX, KNOWN_TOKENS, DEFAULT_TOKENS } from '../src/wallet/tokens'
import * as registry from '../src/wallet/walletRegistry'

const TOKEN_FILE = `${RNFS.DocumentDirectoryPath}/token-prefs.json`

// The wallets the registry lists, the one in front first, as the boot leaves the file.
let listed: string[] = []
const listWallets = (ids: string[], active: string | null = ids[0] ?? null): Promise<void> => {
  listed = ids
  return RNFS.writeFile(
    `${RNFS.DocumentDirectoryPath}/wallets.json`,
    JSON.stringify({ active, wallets: ids.map(id => ({ id, fingerprint: `fp-${id}` })) }),
    'utf8',
  )
}
const setActiveWallet = (id: string): Promise<void> => listWallets(listed, id)

// The lists belong to a wallet, so every case runs with one in front unless it says otherwise.
beforeEach(async () => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  await listWallets(['w_one'])
})

const OTHER = {
  identifier: 'btkn1other000000000000000000000000000000000000000000000000000',
  name: 'Other Token',
  ticker: 'OTK',
  decimals: 8,
}

describe('isTokenIdentifier', () => {
  it('accepts a real btkn1 identifier', () => {
    expect(isTokenIdentifier(USDB.identifier)).toBe(true)
    expect(isTokenIdentifier(`  ${USDB.identifier}  `)).toBe(true)
  })

  it('rejects the hex form, empty, garbage and a lightning invoice', () => {
    // The SDK token APIs take the bech32 id, never the hex form.
    expect(isTokenIdentifier('3206c93b24a4d18ea19d0a9a213204af2c7e74a6d16c7535cc5d33eca4ad1eca')).toBe(false)
    expect(isTokenIdentifier('')).toBe(false)
    expect(isTokenIdentifier('not a token')).toBe(false)
    expect(isTokenIdentifier('lnbc1u1p...')).toBe(false)
    expect(isTokenIdentifier('btkn1')).toBe(false)
  })
})

describe('mergeCatalog', () => {
  it('always includes the built-in default tokens (USDB) even with nothing added', () => {
    expect(mergeCatalog([]).map(t => t.identifier)).toEqual(DEFAULT_TOKENS.map(t => t.identifier))
  })

  it('appends user-added tokens after the built-ins', () => {
    expect(mergeCatalog([OTHER]).map(t => t.ticker)).toEqual([...DEFAULT_TOKENS.map(t => t.ticker), 'OTK'])
  })

  it('dedups a user-added token that collides with a built-in id (no double row)', () => {
    const dup = { identifier: USDB.identifier, name: 'x', ticker: 'x', decimals: 6 }
    expect(mergeCatalog([dup]).filter(t => t.identifier === USDB.identifier)).toHaveLength(1)
  })
})

describe('add / remove persistence', () => {
  it('starts with just the built-in catalog and no hidden ids', async () => {
    const { catalog, hidden } = await loadHomeTokens()
    expect(catalog.map(t => t.identifier)).toEqual(DEFAULT_TOKENS.map(t => t.identifier))
    expect(hidden).toEqual([])
  })

  // DePix is known but not built in, so it is added like any token and removing it drops it.
  it('DePix is off the list until added, and removing it drops it rather than hiding it', async () => {
    expect((await loadCatalog()).some(t => t.identifier === DEPIX.identifier)).toBe(false)
    await addToken({ identifier: DEPIX.identifier, name: DEPIX.name, ticker: DEPIX.ticker, decimals: DEPIX.decimals })
    expect((await loadCatalog()).some(t => t.identifier === DEPIX.identifier)).toBe(true)
    await removeToken(DEPIX.identifier)
    const { catalog, hidden } = await loadHomeTokens()
    expect(catalog.some(t => t.identifier === DEPIX.identifier)).toBe(false)
    expect(hidden).not.toContain(DEPIX.identifier)
  })

  it('adds a user token and reloads it from disk', async () => {
    await addToken(OTHER)
    expect((await loadCatalog()).some(t => t.identifier === OTHER.identifier)).toBe(true)
  })

  it('adding the built-in USDB does not duplicate it into the stored list', async () => {
    await addToken({ identifier: USDB.identifier, name: USDB.name, ticker: USDB.ticker, decimals: USDB.decimals })
    const usdbRows = (await loadCatalog()).filter(t => t.identifier === USDB.identifier)
    expect(usdbRows).toHaveLength(1)
  })

  it('removing the built-in USDB hides it (kept in catalog, listed in hidden)', async () => {
    await removeToken(USDB.identifier)
    const { catalog, hidden } = await loadHomeTokens()
    // A built-in cannot leave the catalog, so hiding is what keeps it off the Home.
    expect(catalog.some(t => t.identifier === USDB.identifier)).toBe(true)
    expect(hidden).toContain(USDB.identifier)
  })

  it('re-adding a hidden built-in unhides it', async () => {
    await removeToken(USDB.identifier)
    await addToken({ identifier: USDB.identifier, name: USDB.name, ticker: USDB.ticker, decimals: USDB.decimals })
    expect((await loadHomeTokens()).hidden).not.toContain(USDB.identifier)
  })

  it('removing a user-added token drops it from the catalog entirely', async () => {
    await addToken(OTHER)
    await removeToken(OTHER.identifier)
    const { catalog, hidden } = await loadHomeTokens()
    expect(catalog.some(t => t.identifier === OTHER.identifier)).toBe(false)
    expect(hidden).not.toContain(OTHER.identifier)
  })

  it('adding the same user token twice updates in place instead of duplicating', async () => {
    await addToken(OTHER)
    await addToken({ ...OTHER, name: 'Renamed' })
    const rows = (await loadCatalog()).filter(t => t.identifier === OTHER.identifier)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Renamed')
  })
})

describe('Add-asset suggestions (official tokens, present vs addable)', () => {
  // isListed is what the AddAssetScreen reads, so this is the screen's rule and not a copy of it.
  const state = async (): Promise<{ ticker: string; present: boolean }[]> => {
    const home = await loadHomeTokens()
    return KNOWN_TOKENS.map(known => ({ ticker: known.ticker, present: isListed(known.identifier, home) }))
  }

  it('USDB shows as added by default, DePix as one tap away', async () => {
    expect(await state()).toEqual([
      { ticker: 'USDB', present: true },
      { ticker: 'DePix', present: false },
    ])
  })

  it('adding DePix from the suggestions marks it added', async () => {
    await addToken({ identifier: DEPIX.identifier, name: DEPIX.name, ticker: DEPIX.ticker, decimals: DEPIX.decimals })
    expect(await state()).toEqual([
      { ticker: 'USDB', present: true },
      { ticker: 'DePix', present: true },
    ])
  })

  // Home shows a held token whatever the lists say, so the suggestion has nothing to add.
  it('a held token reads as present, never added or hidden alike', async () => {
    await removeToken(USDB.identifier)
    const home = await loadHomeTokens()
    const held = new Set([USDB.identifier, DEPIX.identifier])
    expect(isListed(DEPIX.identifier, home, held)).toBe(true)
    expect(isListed(USDB.identifier, home, held)).toBe(true)
    expect(isListed(DEPIX.identifier, home, new Set([USDB.identifier]))).toBe(false)
  })

  it('hiding a built-in flips it to addable; re-adding restores present', async () => {
    await removeToken(USDB.identifier)
    expect((await state())[0]).toEqual({ ticker: 'USDB', present: false })
    await addToken({ identifier: USDB.identifier, name: USDB.name, ticker: USDB.ticker, decimals: USDB.decimals })
    expect((await state())[0]).toEqual({ ticker: 'USDB', present: true })
  })
})

// A token added in one wallet is that wallet's alone; the other wallets on the phone never list it.
describe('the lists of each wallet', () => {
  beforeEach(async () => {
    await listWallets(['w_one', 'w_two'])
  })

  it('lists a token added in one wallet in that wallet alone', async () => {
    await addToken(OTHER)
    await setActiveWallet('w_two')
    expect((await loadCatalog()).map(t => t.identifier)).not.toContain(OTHER.identifier)
    await setActiveWallet('w_one')
    expect((await loadCatalog()).map(t => t.identifier)).toContain(OTHER.identifier)
  })

  it('hides a built-in in one wallet only', async () => {
    await removeToken(USDB.identifier)
    await setActiveWallet('w_two')
    expect((await loadHomeTokens()).hidden).toEqual([])
    await setActiveWallet('w_one')
    expect((await loadHomeTokens()).hidden).toEqual([USDB.identifier])
  })

  it('keeps every change when two land at once', async () => {
    const DEPIX_ENTRY = { identifier: DEPIX.identifier, name: DEPIX.name, ticker: DEPIX.ticker, decimals: DEPIX.decimals }
    await Promise.all([addToken(OTHER), removeToken(USDB.identifier), addToken(DEPIX_ENTRY)])
    const { catalog, hidden } = await loadHomeTokens()
    expect(catalog.map(t => t.identifier)).toEqual(expect.arrayContaining([OTHER.identifier, DEPIX.identifier]))
    expect(hidden).toEqual([USDB.identifier])
  })

  it('drops the lists of a removed wallet and leaves the others', async () => {
    await addToken(OTHER)
    await setActiveWallet('w_two')
    await removeToken(USDB.identifier)
    await forgetTokenPrefs('w_one')
    const file = JSON.parse(await RNFS.readFile(TOKEN_FILE, 'utf8'))
    expect(Object.keys(file.wallets)).toEqual(['w_two'])
  })

  // A change that answered with nothing written would let the screen that asked act as if it held.
  it('refuses a change with no wallet in front, and writes nothing', async () => {
    await RNFS.unlink(`${RNFS.DocumentDirectoryPath}/wallets.json`).catch(() => undefined)
    await expect(addToken(OTHER)).rejects.toBeInstanceOf(NoWalletInFront)
    await expect(removeToken(USDB.identifier)).rejects.toBeInstanceOf(NoWalletInFront)
    expect(await RNFS.exists(TOKEN_FILE)).toBe(false)
  })
})

// The update keeps what each wallet showed: the old device-wide lists become every listed wallet's own.
describe('the device-wide file from before the split', () => {
  beforeEach(async () => {
    await listWallets(['w_one', 'w_two'])
    await RNFS.writeFile(TOKEN_FILE, JSON.stringify({ added: [OTHER], hidden: [USDB.identifier] }), 'utf8')
  })

  it('reads as every listed wallet holding the old lists', async () => {
    for (const id of ['w_one', 'w_two']) {
      await setActiveWallet(id)
      const { catalog, hidden } = await loadHomeTokens()
      expect(catalog.map(t => t.identifier)).toContain(OTHER.identifier)
      expect(hidden).toEqual([USDB.identifier])
    }
  })

  it('is rewritten per wallet, so a wallet created after it starts with no lists of its own', async () => {
    await loadHomeTokens()
    await listWallets(['w_one', 'w_two', 'w_three'], 'w_three')
    const { catalog, hidden } = await loadHomeTokens()
    expect(catalog.map(t => t.identifier)).not.toContain(OTHER.identifier)
    expect(hidden).toEqual([])
    const file = JSON.parse(await RNFS.readFile(TOKEN_FILE, 'utf8'))
    expect(Object.keys(file.wallets).sort()).toEqual(['w_one', 'w_two'])
  })

  it('after the upgrade a change in one wallet stays in that wallet', async () => {
    await removeToken(OTHER.identifier)
    await setActiveWallet('w_two')
    expect((await loadCatalog()).map(t => t.identifier)).toContain(OTHER.identifier)
  })
})

// No change is ever written from a read that said nothing about the file, nor over old lists that
// could not be carried to each wallet.
describe('what is never written', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('keeps the old lists on disk and answers with them while the wallet list cannot be read', async () => {
    const old = JSON.stringify({ added: [OTHER], hidden: [] })
    await RNFS.writeFile(TOKEN_FILE, old, 'utf8')
    jest.spyOn(registry, 'loadRegistry').mockRejectedValue(new Error('registry unreadable'))

    expect((await loadCatalog()).map(t => t.identifier)).toContain(OTHER.identifier)
    await expect(addToken({ ...OTHER, identifier: DEPIX.identifier })).rejects.toThrow()
    expect(await RNFS.readFile(TOKEN_FILE, 'utf8')).toBe(old)
  })

  it('writes nothing after a read the platform refused', async () => {
    await addToken(OTHER)
    const before = await RNFS.readFile(TOKEN_FILE, 'utf8')
    const readFile = RNFS.readFile.bind(RNFS)
    jest
      .spyOn(RNFS, 'readFile')
      .mockImplementation((path: string, encoding?: string) =>
        path === TOKEN_FILE ? Promise.reject(new Error('EACCES: permission denied')) : readFile(path, encoding),
      )

    await expect(removeToken(OTHER.identifier)).rejects.toThrow('EACCES')
    jest.restoreAllMocks()
    expect(await RNFS.readFile(TOKEN_FILE, 'utf8')).toBe(before)
  })
})
