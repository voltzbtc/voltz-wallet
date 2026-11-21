import RNFS from 'react-native-fs'
import { isUnreadableFile, readDurable, serialQueue, writeDurable } from './durableFile'

/**
 * The fingerprints of wallets removed from this device, by Remove wallet or by the erase behind Forgot
 * PIN and Erase and restore. Its one reader is the age gate in `wallet.ts`: a wallet this device held
 * is not a new wallet, so its words come back whatever the store's age signal says, as those sheets
 * promise. Nothing here says anything about age.
 *
 * A fingerprint is the BIP32 master fingerprint of the words and passphrase, eight hex characters, the
 * same identifier `wallets.json` lists and the wallet screens show. Written before the seed goes, so a
 * removal cut in the middle leaves the wallet restorable.
 */

const FILE = `${RNFS.DocumentDirectoryPath}/held-wallets.json`

const FINGERPRINT = /^[0-9a-f]{8}$/

const valid = (value: unknown): boolean =>
  Array.isArray(value) && value.every(fp => typeof fp === 'string' && FINGERPRINT.test(fp))

const serial = serialQueue()

const read = async (): Promise<string[]> => ((await readDurable(FILE, valid, 'nothing')) as string[] | null) ?? []

// A torn file is written over with this fingerprint alone: what it held is lost either way, and the
// removal under way keeps its own wallet restorable. A read the platform refused says nothing about the
// file, and writing then would lose what it holds.
async function forWriting(): Promise<string[]> {
  try {
    return await read()
  } catch (err) {
    if (!isUnreadableFile(err)) {
      throw err
    }
    return []
  }
}

/** Rejects when the file could not be written. An identifier that is not a fingerprint is ignored. */
export async function noteHeld(fingerprint: string): Promise<void> {
  if (!FINGERPRINT.test(fingerprint)) {
    return
  }
  await serial(async () => {
    const held = await forWriting()
    if (!held.includes(fingerprint)) {
      await writeDurable(FILE, JSON.stringify([...held, fingerprint]), valid, 'replace', 'nothing')
    }
  })
}

// Never rejects. A file that cannot be read answers no, which leaves the age gate where it would be on
// a device that never held the wallet.
export async function wasHeld(fingerprint: string): Promise<boolean> {
  try {
    return (await serial(read)).includes(fingerprint)
  } catch {
    return false
  }
}
