import RNFS from 'react-native-fs'
import { DEFAULT_TOKENS } from './tokens'
import { isUnreadableFile, readDurable, serialQueue, writeDurable } from './durableFile'
import { getActiveWalletId, loadRegistry } from './walletRegistry'

// Metadata is resolved once and cached, so a zero-balance row renders with no network round-trip.
export type CatalogToken = {
  identifier: string
  name: string
  ticker: string
  decimals: number
}

// A held token always shows, so `hidden` only suppresses zero-balance catalog entries.
export type TokenPrefs = {
  added: CatalogToken[]
  hidden: string[]
}

// Each wallet's lists under its id, so a token added in one wallet is listed in that wallet alone.
// A file holding one pair of lists and no `wallets` is the device-wide shape: it reads as every wallet
// the registry lists holding those lists, which is what each of them showed, and is rewritten per wallet.
type PrefsFile = { wallets: Record<string, TokenPrefs> }

const FILE = `${RNFS.DocumentDirectoryPath}/token-prefs.json`

const EMPTY: TokenPrefs = { added: [], hidden: [] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPrefs = (value: unknown): boolean =>
  isRecord(value) &&
  (value.added === undefined || Array.isArray(value.added)) &&
  (value.hidden === undefined || Array.isArray(value.hidden))

const isDeviceWide = (value: unknown): boolean => isPrefs(value) && !('wallets' in (value as object))

const valid = (value: unknown): boolean =>
  isDeviceWide(value) || (isRecord(value) && isRecord(value.wallets) && Object.values(value.wallets).every(isPrefs))

const prefsOf = (value: unknown): TokenPrefs => {
  const prefs = (value ?? {}) as Partial<TokenPrefs>
  return { added: prefs.added ?? [], hidden: prefs.hidden ?? [] }
}

const serial = serialQueue()

// The file as it is now, null when nothing was ever written. A torn file, which never holds money,
// reads as no lists; a read the platform refused says nothing about the file and rejects, so no writer
// starts from it.
async function readFile(): Promise<unknown> {
  try {
    return await readDurable(FILE, valid, 'nothing')
  } catch (err) {
    if (isUnreadableFile(err)) {
      return null
    }
    throw err
  }
}

// The device-wide lists, copied to every wallet the registry lists now, and written per wallet. When
// the registry cannot be read or the write fails, the file stays as it is and the device-wide lists
// answer for the wallet in front, while no change is written over them.
async function upgrade(old: unknown): Promise<PrefsFile | null> {
  try {
    const ids = (await loadRegistry()).wallets.map(wallet => wallet.id)
    const prefs = prefsOf(old)
    const file: PrefsFile = { wallets: Object.fromEntries(ids.map(id => [id, prefs])) }
    await writeDurable(FILE, JSON.stringify(file), valid, 'replace', 'nothing')
    return file
  } catch {
    return null
  }
}

async function current(): Promise<{ file: PrefsFile; deviceWide?: TokenPrefs }> {
  const raw = await readFile()
  if (raw === null) {
    return { file: { wallets: {} } }
  }
  if (isDeviceWide(raw)) {
    const upgraded = await upgrade(raw)
    return upgraded ? { file: upgraded } : { file: { wallets: {} }, deviceWide: prefsOf(raw) }
  }
  return { file: raw as PrefsFile }
}

// The lists of the wallet in front. A read that fails answers no lists, so a screen still draws the
// built-in catalog.
async function read(): Promise<TokenPrefs> {
  return serial(async () => {
    try {
      const id = await getActiveWalletId()
      if (!id) {
        return EMPTY
      }
      const { file, deviceWide } = await current()
      return deviceWide ?? prefsOf(file.wallets[id])
    } catch {
      return EMPTY
    }
  })
}

// What a change to the lists throws when no wallet is in front. The lists belong to a wallet, so with
// none there is nowhere to write, and the screen that asked says the change did not happen.
export class NoWalletInFront extends Error {
  constructor() {
    super('no wallet in front to keep the token lists of')
    this.name = 'NoWalletInFront'
  }
}

// One change to the lists of the wallet in front, read and written in one turn of the queue so two
// changes never lose each other.
async function update(change: (prefs: TokenPrefs) => TokenPrefs): Promise<void> {
  await serial(async () => {
    const id = await getActiveWalletId()
    if (!id) {
      throw new NoWalletInFront()
    }
    const { file, deviceWide } = await current()
    if (deviceWide) {
      throw new Error('token lists not upgraded: the wallet list could not be read')
    }
    const wallets = { ...file.wallets, [id]: change(prefsOf(file.wallets[id])) }
    await writeDurable(FILE, JSON.stringify({ wallets }), valid, 'replace', 'nothing')
  })
}

// A removed wallet takes its lists with it.
export async function forgetTokenPrefs(walletId: string): Promise<void> {
  await serial(async () => {
    const { file, deviceWide } = await current()
    if (deviceWide || !(walletId in file.wallets)) {
      return
    }
    const wallets = Object.fromEntries(Object.entries(file.wallets).filter(([id]) => id !== walletId))
    await writeDurable(FILE, JSON.stringify({ wallets }), valid, 'replace', 'nothing')
  })
}

// Only a default is built in. A token the app merely knows, such as DePix, is added like any other.
const isKnown = (identifier: string): boolean =>
  DEFAULT_TOKENS.some(token => token.identifier === identifier)

// Shape gate only. The SDK stays the authority and returns no metadata for an id it does not know.
export function isTokenIdentifier(value: string): boolean {
  // Spark ids are bech32m with a `btkn1` prefix, and the charset drops b/i/o and reserves 1.
  return /^btkn1[023-9ac-hj-np-z]{20,}$/i.test(value.trim())
}

// Deduped by identifier, so a built-in that is also pasted in never gets two rows.
export function mergeCatalog(added: readonly CatalogToken[]): CatalogToken[] {
  const known: CatalogToken[] = DEFAULT_TOKENS.map(token => ({
    identifier: token.identifier,
    name: token.name,
    ticker: token.ticker,
    decimals: token.decimals,
  }))
  const knownIds = new Set(known.map(token => token.identifier))
  return [...known, ...added.filter(token => !knownIds.has(token.identifier))]
}

// A suggestion reads as added exactly when this holds, so a known token never added (DePix) is
// offered and a hidden default is offered back. A token the wallet holds is on Home whatever the
// lists say, so it reads as added too; `held` names the tokens with a nonzero balance.
export function isListed(
  identifier: string,
  home: { catalog: readonly CatalogToken[]; hidden: readonly string[] },
  held: ReadonlySet<string> = new Set(),
): boolean {
  return (
    held.has(identifier) ||
    (home.catalog.some(token => token.identifier === identifier) && !home.hidden.includes(identifier))
  )
}

export async function loadHomeTokens(): Promise<{ catalog: CatalogToken[]; hidden: string[] }> {
  const prefs = await read()
  return { catalog: mergeCatalog(prefs.added), hidden: prefs.hidden }
}

export async function loadCatalog(): Promise<CatalogToken[]> {
  return mergeCatalog((await read()).added)
}

// A built-in is never duplicated into `added`, so adding it only clears a prior hide.
export async function addToken(token: CatalogToken): Promise<void> {
  await update(prefs => {
    const hidden = prefs.hidden.filter(id => id !== token.identifier)
    if (isKnown(token.identifier)) {
      return { added: prefs.added, hidden }
    }
    return { added: [...prefs.added.filter(entry => entry.identifier !== token.identifier), token], hidden }
  })
}

// A built-in cannot be dropped, only hidden, so it can be brought back later.
export async function removeToken(identifier: string): Promise<void> {
  await update(prefs => {
    if (isKnown(identifier)) {
      return { added: prefs.added, hidden: prefs.hidden.includes(identifier) ? prefs.hidden : [...prefs.hidden, identifier] }
    }
    return {
      added: prefs.added.filter(entry => entry.identifier !== identifier),
      hidden: prefs.hidden.filter(id => id !== identifier),
    }
  })
}
