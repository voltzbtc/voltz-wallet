import RNFS from 'react-native-fs'
import type { FiatCurrency } from './fiat'
import { announceDisplayCurrencyChanged } from './displayCurrencyNotice'
import { isUnreadableFile, readDurable, serialQueue, writeDurable } from './durableFile'
import { isHeroUnit, type HeroUnit } from './heroFigure'

// A plain file rather than the Keychain, since no preference here is sensitive.
const FILE = `${RNFS.DocumentDirectoryPath}/settings.json`

// Persisted preference only. spark.ts connects to mainnet unconditionally and reads nothing here.
export type NetworkName = 'mainnet' | 'testnet'

// A website for "view transaction". The SDK takes no explorer config, so this cannot affect sync.
export type TxExplorer = {
  id: string
  /** Site base, e.g. https://mempool.space. A path is kept, so a self-hosted subpath works. */
  url: string
}

// Every entry shares the /tx/{id} path, self-hosted mempool and esplora builds included.
export const TX_EXPLORER_PRESETS: TxExplorer[] = [
  { id: 'mempool', url: 'https://mempool.space' },
  { id: 'blockstream', url: 'https://blockstream.info' },
]

export const DEFAULT_TX_EXPLORER_ID = TX_EXPLORER_PRESETS[0].id

export type TxExplorerConfig = {
  /** Entries added by hand. Presets are never stored, so they can be changed without a migration. */
  custom: TxExplorer[]
  selectedId: string
}

const EMPTY_TX_EXPLORERS: TxExplorerConfig = { custom: [], selectedId: DEFAULT_TX_EXPLORER_ID }

type Settings = {
  displayCurrency?: FiatCurrency
  displayLanguage?: string
  network?: NetworkName
  txExplorer?: TxExplorerConfig
  /** Keyed by wallet id, as the dollar wallet is a per-wallet setting rather than an app-wide one. */
  dollarMode?: Record<string, boolean>
  /** Keyed by wallet id: the USDB base units the dollar invitation was last answered at. */
  dollarInviteSeen?: Record<string, number>
  /** The stablecoin network last received on, so the next receive opens on it. */
  lastReceiveRoute?: string
  /** The layout direction a restart was started for, read by the boot after it (i18n/direction.ts). */
  directionRestart?: LayoutDirection
  /** The version whose update banner was dismissed. App-wide, since the version is the app's. */
  dismissedUpdate?: string
  /** The unit the big balance draws. Per install, as a way of reading rather than a wallet setting. */
  heroUnit?: HeroUnit
}

export type LayoutDirection = 'ltr' | 'rtl'

// Every read and write of the file waits its turn in this one queue, so a patch always merges onto the
// last one written, and a read never lands in the gap a write leaves between its copy and the file.
const serial = serialQueue()

const isSettings = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Each preference falls back to a default, so a torn file, or a cut first write, reads as none set
// and the next write replaces it ('nothing', 'replace'). A read the platform refuses is not a torn
// file and rejects, so no write goes over a file it could not read.
async function readNow(): Promise<Settings> {
  try {
    return ((await readDurable(FILE, isSettings, 'nothing')) as Settings | null) ?? {}
  } catch (err) {
    if (isUnreadableFile(err)) {
      return {}
    }
    throw err
  }
}

// A reader gets the defaults on any failure, since no preference here guards funds.
async function read(): Promise<Settings> {
  return serial(readNow).catch(() => ({}))
}

// The change is worked out from the file inside the same turn as the write, so two changes never
// start from the same file and the later one never writes the earlier one away. A null change writes
// nothing. Answers the settings as they now stand.
async function update(change: (current: Settings) => Partial<Settings> | null): Promise<Settings> {
  return serial(async () => {
    const current = await readNow()
    const patch = change(current)
    if (patch === null) {
      return current
    }
    const next = { ...current, ...patch }
    await writeDurable(FILE, JSON.stringify(next), isSettings, 'replace', 'nothing')
    return next
  })
}

async function write(patch: Partial<Settings>): Promise<void> {
  await update(() => patch)
}

export async function loadDismissedUpdate(): Promise<string | null> {
  return (await read()).dismissedUpdate ?? null
}

export async function saveDismissedUpdate(version: string): Promise<void> {
  await write({ dismissedUpdate: version })
}

// Null until the person taps the balance, since the unit that leads depends on what the wallet holds.
export async function loadHeroUnit(): Promise<HeroUnit | null> {
  const stored = (await read()).heroUnit
  return isHeroUnit(stored) ? stored : null
}

export async function saveHeroUnit(unit: HeroUnit): Promise<void> {
  await write({ heroUnit: unit })
}

export async function loadLastReceiveRoute(): Promise<string | null> {
  return (await read()).lastReceiveRoute ?? null
}

export async function saveLastReceiveRoute(routeId: string): Promise<void> {
  await write({ lastReceiveRoute: routeId })
}

// Cached so the accent paints before the SDK connects, which stays the source of truth.
export async function loadDollarMode(walletId: string): Promise<boolean> {
  return (await read()).dollarMode?.[walletId] ?? false
}

export async function saveDollarMode(walletId: string, dollarMode: boolean): Promise<void> {
  await update(current => ({ dollarMode: { ...current.dollarMode, [walletId]: dollarMode } }))
}

// A copy of the map with one wallet's entry gone, or null when it had none.
function without<T>(map: Record<string, T> | undefined, walletId: string): Record<string, T> | null {
  if (map === undefined || !(walletId in map)) {
    return null
  }
  const rest = { ...map }
  delete rest[walletId]
  return rest
}

// For a removed wallet, whose entry would otherwise stay in the file for good.
export async function forgetDollarMode(walletId: string): Promise<void> {
  await update(current => {
    const rest = without(current.dollarMode, walletId)
    return rest === null ? null : { dollarMode: rest }
  })
}

// Lost with an unreadable file, this repeats one invitation and costs nothing.
export async function loadDollarInviteSeen(walletId: string): Promise<number> {
  return (await read()).dollarInviteSeen?.[walletId] ?? 0
}

export async function saveDollarInviteSeen(walletId: string, baseUnits: number): Promise<void> {
  await update(current => ({ dollarInviteSeen: { ...current.dollarInviteSeen, [walletId]: baseUnits } }))
}

export async function forgetDollarInviteSeen(walletId: string): Promise<void> {
  await update(current => {
    const rest = without(current.dollarInviteSeen, walletId)
    return rest === null ? null : { dollarInviteSeen: rest }
  })
}

export async function loadDisplayCurrency(): Promise<FiatCurrency | null> {
  return (await read()).displayCurrency ?? null
}

export async function saveDisplayCurrency(currency: FiatCurrency): Promise<void> {
  await write({ displayCurrency: currency })
  announceDisplayCurrencyChanged()
}

// Null follows the device locale, which i18n init falls back to only when nothing was chosen.
export async function loadDisplayLanguage(): Promise<string | null> {
  return (await read()).displayLanguage ?? null
}

export async function saveDisplayLanguage(language: string): Promise<void> {
  await write({ displayLanguage: language })
}

export async function loadDirectionRestart(): Promise<LayoutDirection | null> {
  return (await read()).directionRestart ?? null
}

// Rejects when the file cannot be written, which the caller takes as a reason not to restart.
export async function saveDirectionRestart(direction: LayoutDirection): Promise<void> {
  await write({ directionRestart: direction })
}

export async function clearDirectionRestart(): Promise<void> {
  await write({ directionRestart: undefined })
}

export async function loadNetwork(): Promise<NetworkName> {
  return (await read()).network ?? 'mainnet'
}

export async function saveNetwork(network: NetworkName): Promise<void> {
  await write({ network })
}

// Only http(s) passes, since a user-typed value ends up in Linking.openURL.
export function validateExplorerUrl(url: string): boolean {
  return /^https?:\/\/[^\s/]+\S*$/i.test(url.trim())
}

export async function loadTxExplorers(): Promise<TxExplorerConfig> {
  const stored = (await read()).txExplorer
  return stored ?? EMPTY_TX_EXPLORERS
}

export function allTxExplorers(config: TxExplorerConfig): TxExplorer[] {
  return [...TX_EXPLORER_PRESETS, ...config.custom]
}

// Falls back to the default preset when the selection points at an entry that no longer exists.
export function resolveTxExplorerUrl(config: TxExplorerConfig): string {
  const found = allTxExplorers(config).find(e => e.id === config.selectedId)
  return (found ?? TX_EXPLORER_PRESETS[0]).url
}

function newExplorerId(): string {
  return `exp_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

// Applies a change to the stored explorers inside the file's turn, and answers the list it wrote.
async function updateTxExplorers(
  change: (config: TxExplorerConfig) => TxExplorerConfig,
): Promise<TxExplorerConfig> {
  const next = await update(current => ({ txExplorer: change(current.txExplorer ?? EMPTY_TX_EXPLORERS) }))
  return next.txExplorer ?? EMPTY_TX_EXPLORERS
}

// An address already on the list is only selected, never duplicated.
export async function addTxExplorer(url: string): Promise<TxExplorerConfig> {
  const trimmed = normalizeUrl(url)
  return updateTxExplorers(config => {
    const existing = allTxExplorers(config).find(e => normalizeUrl(e.url) === trimmed)
    if (existing) {
      return { ...config, selectedId: existing.id }
    }
    const entry: TxExplorer = { id: newExplorerId(), url: trimmed }
    return { custom: [...config.custom, entry], selectedId: entry.id }
  })
}

export async function removeTxExplorer(id: string): Promise<TxExplorerConfig> {
  return updateTxExplorers(config => ({
    custom: config.custom.filter(e => e.id !== id),
    selectedId: config.selectedId === id ? DEFAULT_TX_EXPLORER_ID : config.selectedId,
  }))
}

// An unknown id is ignored rather than persisted, so the stored selection always resolves.
export async function selectTxExplorer(id: string): Promise<TxExplorerConfig> {
  return updateTxExplorers(config => {
    const known = allTxExplorers(config).some(e => e.id === id)
    return { ...config, selectedId: known ? id : DEFAULT_TX_EXPLORER_ID }
  })
}
