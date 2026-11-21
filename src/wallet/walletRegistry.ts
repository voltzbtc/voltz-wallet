import RNFS from 'react-native-fs'
import { hasSeedFor } from './seed'
import { secureBytes, toHex } from './secureRandom'
import { asideExists, isUnreadableFile, readDurable, serialQueue, setAside, writeDurable } from './durableFile'

// Which wallets exist on this device and which is active. Nothing sensitive lives here, only a
// wallet id (the seed's Keychain key) and its fingerprint, while the seeds stay in the Keychain.
export type WalletEntry = { id: string; fingerprint: string }
export type Registry = { wallets: WalletEntry[]; active: string | null }

const FILE = `${RNFS.DocumentDirectoryPath}/wallets.json`
const EMPTY: Registry = { wallets: [], active: null }

// Time-based, since a fingerprint is not stable per wallet (a BIP39 passphrase derives another), and
// the boot's repair of an unreadable list orders wallets by it. The id holds no secret, and its tail
// still comes from the secure source the seed uses (secureBytes), so the wallet code has a single
// kind of randomness to audit.
export function newWalletId(): string {
  return `w_${Date.now().toString(36)}${toHex(secureBytes(4, 'a wallet id'))}`
}

export function registerWallet(reg: Registry, id: string, fingerprint: string): Registry {
  const wallets = reg.wallets.some(w => w.id === id)
    ? reg.wallets.map(w => (w.id === id ? { ...w, fingerprint } : w))
    : [...reg.wallets, { id, fingerprint }]
  return { wallets, active: reg.active ?? id }
}

type RawEntry = { id?: string; fingerprint?: string; engine?: string }
type RawRegistry = { wallets?: RawEntry[]; active?: string | null }

// Tolerates the legacy fingerprint-keyed format (no ids, `active` holding a fingerprint) by
// remapping it onto ids. A legacy `engine` field is ignored, since reading one must not crash.
function normalize(raw: RawRegistry): Registry {
  const list = Array.isArray(raw.wallets) ? raw.wallets : []
  const wallets: WalletEntry[] = list.map((w, i) => ({
    id: typeof w.id === 'string' ? w.id : i === 0 ? 'primary' : `w_${i}`,
    fingerprint: typeof w.fingerprint === 'string' ? w.fingerprint : '',
  }))
  let active = typeof raw.active === 'string' ? raw.active : null
  if (active && !wallets.some(w => w.id === active)) {
    const byFp = wallets.find(w => w.fingerprint === active)
    active = byFp ? byFp.id : (wallets[0]?.id ?? null)
  }
  return { wallets, active }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// The shapes this build can read, the legacy fingerprint-keyed one included, which normalize remaps.
// Anything else is a file this build cannot read, which is never taken for an empty list.
function valid(value: unknown): boolean {
  if (!isObject(value)) {
    return false
  }
  const { wallets, active } = value
  return (
    (wallets === undefined || (Array.isArray(wallets) && wallets.every(isObject))) &&
    (active === undefined || active === null || typeof active === 'string')
  )
}

const registryOf = (raw: unknown): Registry => (raw === null ? EMPTY : normalize(raw as RawRegistry))

// A list that cannot be read throws UnreadableFile. Read as empty, it would let the next writer list
// one wallet over it, and the other wallets' ids would be gone with their seeds still in the Keychain.
async function read(): Promise<Registry> {
  return registryOf(await readDurable(FILE, valid))
}

// Refuses a file that cannot be read, so a writer that reached here past its own read still never
// writes over one.
async function write(reg: Registry): Promise<void> {
  await writeDurable(FILE, JSON.stringify(reg), valid)
}

// Every writer reads, changes and writes the whole file, so two writers interleaved across their
// awaits would each write back a copy without the other's change. Reads run in the same queue, since
// one sent between a write's unlink and its move would find no file at all. Nothing inside a turn calls
// loadRegistry or getActiveWalletId, which would wait on the turn itself.
const serialised = serialQueue()

export async function loadRegistry(): Promise<Registry> {
  return serialised(read)
}

// Idempotent, so it is safe on every connect and adopts a pre-existing wallet as "primary".
//
// Writes only while the wallet's seed is on this device, asked inside the queue. A removal deletes the
// seed before the entry, so a register that lands before the removal's entry write is undone by it,
// and one that lands after finds no seed: a connect that derived its fingerprint while the wallet was
// being removed never lists it again. A presence read that throws propagates and writes nothing. The
// list is read first, so one that cannot be read refuses whether or not the seed is here.
export async function ensureRegistered(id: string, fingerprint: string): Promise<void> {
  await serialised(async () => {
    const reg = await read()
    if (!(await hasSeedFor(id))) {
      return
    }
    await write(registerWallet(reg, id, fingerprint))
  })
}

export async function getActiveWalletId(): Promise<string | null> {
  return (await serialised(read)).active
}

// Reconnecting to the newly active wallet is left to the caller.
export async function setActiveWallet(id: string): Promise<void> {
  await serialised(async () => {
    const reg = await read()
    if (reg.wallets.some(w => w.id === id)) {
      await write({ ...reg, active: id })
    }
  })
}

// Defensive fallback to the first remaining wallet, as the UI only removes non-active ones.
export async function removeWalletEntry(id: string): Promise<void> {
  await serialised(async () => {
    const reg = await read()
    const wallets = reg.wallets.filter(w => w.id !== id)
    const active = reg.active === id ? (wallets[0]?.id ?? null) : reg.active
    await write({ wallets, active })
  })
}

// Display order only, so the active pointer is untouched and a wallet missing from `ids` is kept.
export function reorder(reg: Registry, ids: string[]): Registry {
  const byId = new Map(reg.wallets.map(w => [w.id, w]))
  const wallets: WalletEntry[] = []
  for (const id of ids) {
    const w = byId.get(id)
    if (w) {
      wallets.push(w)
      byId.delete(id)
    }
  }
  for (const w of byId.values()) {
    wallets.push(w)
  }
  return { ...reg, wallets }
}

export async function reorderWallets(ids: string[]): Promise<void> {
  await serialised(async () => {
    await write(reorder(await read(), ids))
  })
}

// No list, beside one set aside: a repair moved an unreadable list out of the way and wrote nothing
// after it, because it found no seed, or because a kill or a failed write came between the two. Read
// as empty, it would open the primary alone and the next connect would list only that wallet, so the
// boot repairs again from it.
async function repairPending(): Promise<boolean> {
  return (await readDurable(FILE, valid)) === null && (await asideExists(FILE))
}

export async function registryRepairPending(): Promise<boolean> {
  return serialised(repairPending)
}

// The boot's repair of a list that cannot be read, from the wallets whose seeds the Keychain holds.
// Read again in its turn: a list that answers (a good file, or another repair that already wrote) is
// returned as it is and nothing is written. Otherwise the unreadable file is set aside, never deleted,
// so the ids of wallets whose seeds are not on this device stay on the device for support, and the
// rebuilt list is written. With no entries nothing is written, and the list reads as empty from then.
export async function replaceUnreadableRegistry(entries: WalletEntry[], active: string | null): Promise<Registry> {
  return serialised(async () => {
    let unreadable = false
    let raw: unknown = null
    try {
      raw = await readDurable(FILE, valid)
    } catch (err) {
      if (!isUnreadableFile(err)) {
        throw err
      }
      unreadable = true
    }
    if (!unreadable && (raw !== null || !(await asideExists(FILE)))) {
      return registryOf(raw)
    }
    await setAside(FILE)
    if (entries.length === 0) {
      return EMPTY
    }
    const rebuilt: Registry = { wallets: entries, active }
    await write(rebuilt)
    return rebuilt
  })
}
