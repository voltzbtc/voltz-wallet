import RNFS from 'react-native-fs'
import { isUnreadableFile, readDurable, serialQueue, writeDurable } from './durableFile'
import { readCrop, type PhotoCrop } from './photoCrop'

// Custom name and avatar for a wallet, keyed by its fingerprint.
// Non-sensitive (no keys), so it lives in a plain JSON file like settings, never the Keychain.
// `imageCrop` is the square of the photo the avatar shows; a photo without one shows centred.
export type WalletMeta = { name?: string; color?: string; imagePath?: string; imageCrop?: PhotoCrop }

const FILE = `${RNFS.DocumentDirectoryPath}/wallet-meta.json`

type Store = Record<string, WalletMeta>

const isStore = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value)

// Written whole through a temporary copy (durableFile), and every read and write in one queue.
const serial = serialQueue()

// What the screens show. A file that cannot be read shows every wallet under its default name and
// colour rather than an error.
async function read(): Promise<Store> {
  try {
    return ((await serial(() => readDurable(FILE, isStore))) as Store | null) ?? {}
  } catch {
    return {}
  }
}

// What a write builds on, inside the queue. A read the platform refused says nothing about the file
// and always rejects, so no write lays one wallet's entry over the others. A torn file holds nothing
// readable: a save the person asked for starts from an empty store and replaces it (`replaceTorn`),
// while a write nobody asked for leaves it as it is.
async function readForWrite(replaceTorn = false): Promise<Store> {
  try {
    return ((await readDurable(FILE, isStore)) as Store | null) ?? {}
  } catch (err) {
    if (replaceTorn && isUnreadableFile(err)) {
      return {}
    }
    throw err
  }
}

const writeStore = (store: Store): Promise<void> => writeDurable(FILE, JSON.stringify(store), isStore, 'replace')

// A crop that is not one is dropped here, so every screen draws that photo centred, as before crops.
export async function loadWalletMeta(fingerprint: string): Promise<WalletMeta> {
  const { imageCrop, ...meta } = (await read())[fingerprint] ?? {}
  const crop = readCrop(imageCrop)
  return crop ? { ...meta, imageCrop: crop } : meta
}

// Only the wallet's own entry is touched, so other wallets' metadata is preserved.
export async function saveWalletMeta(fingerprint: string, patch: WalletMeta): Promise<void> {
  await serial(async () => {
    const store = await readForWrite(true)
    store[fingerprint] = { ...(store[fingerprint] ?? {}), ...patch }
    await writeStore(store)
  })
}

// A legacy entry may sit under the fingerprint of a wallet's words alone, which for a passphrase
// wallet is another key than the registry's. The first time a wallet is read through here, its key
// gets a copy of the entry under legacyKey, or an empty entry when there is none, so the copy happens
// once and a later name is never overwritten. The source entry stays: the same words without a
// passphrase are another wallet, whose own key it is.
//
// legacyKey is a PBKDF2 derivation, asked only when the copy is due and off the JS thread. The store
// is read again after it, so a name saved while it ran is kept rather than written over.
export async function carryWalletMeta(key: string, legacyKey: () => Promise<string>): Promise<void> {
  if (key in (await serial(readForWrite))) {
    return
  }
  const legacy = await legacyKey()
  await serial(async () => {
    const store = await readForWrite()
    if (key in store) {
      return
    }
    store[key] = { ...(store[legacy] ?? {}) }
    await writeStore(store)
  })
}
