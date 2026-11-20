import RNFS from 'react-native-fs'
import { isUnreadableFile, readDurable, serialQueue, writeDurable } from './durableFile'
import { loadRegistry } from './walletRegistry'

/**
 * The wallets whose recovery phrase was shown and not yet confirmed. A wallet is stored at I wrote them
 * down with no proof of it, and its seed is only on this device, so the mark is what brings the
 * confirmation back once the wallet holds value (`BackupCard`).
 *
 * The file sits beside `wallets.json` and travels with it in an iCloud or computer backup, which leaves
 * the seeds behind. An id with no seed lights nothing, since Home never opens that wallet.
 *
 * Written before the seed (`wallet.ts`), so a kill between the two leaves a mark with no wallet and
 * never a wallet with no mark. A mark with no wallet costs nothing: the id is taken only by words
 * typed again, which clear it, or by a new wallet, which marks it anyway.
 */

const FILE = `${RNFS.DocumentDirectoryPath}/backup-marks.json`

const valid = (value: unknown): boolean => Array.isArray(value) && value.every(id => typeof id === 'string')

const serial = serialQueue()

// A first write's writer stores the seed only once the write resolved, so a first write that was cut
// stands behind no wallet, and a torn copy with no file is no file.
const read = async (): Promise<string[]> => ((await readDurable(FILE, valid, 'nothing')) as string[] | null) ?? []

const save = (ids: string[]): Promise<void> => writeDurable(FILE, JSON.stringify(ids), valid, 'replace', 'nothing')

// What a writer starts from. A file that cannot be read may have held any wallet, so every listed one
// counts as unconfirmed, which is what the reader answers for each of them until the file is whole
// again. A read the platform refused says nothing about the file, and writing then would lose its ids.
async function forWriting(): Promise<string[]> {
  try {
    return await read()
  } catch (err) {
    if (!isUnreadableFile(err)) {
      throw err
    }
    return (await loadRegistry()).wallets.map(wallet => wallet.id)
  }
}

/** Rejects when the mark could not be stored, and the caller then stores no seed. */
export async function markUnconfirmed(id: string): Promise<void> {
  await serial(async () => {
    const ids = await forWriting()
    if (!ids.includes(id)) {
      await save([...ids, id])
    }
  })
}

/** Rejects when the file could not be written, and the mark stays. */
export async function clearUnconfirmed(id: string): Promise<void> {
  await serial(async () => {
    const ids = await forWriting()
    if (ids.includes(id)) {
      await save(ids.filter(other => other !== id))
    }
  })
}

// Never rejects. A file that cannot be read answers yes: a card shown for words already confirmed costs
// one more confirmation, and a card missing can cost the wallet.
export async function isUnconfirmed(id: string): Promise<boolean> {
  try {
    return (await serial(read)).includes(id)
  } catch {
    return true
  }
}

/** How many of these wallets are unconfirmed, all of them when the file cannot be read. Never rejects. */
export async function countUnconfirmed(ids: readonly string[]): Promise<number> {
  try {
    const marked = await serial(read)
    return ids.filter(id => marked.includes(id)).length
  } catch {
    return ids.length
  }
}
