import RNFS from 'react-native-fs'
import { readDurable, serialQueue, writeDurable } from './durableFile'
import { getActiveWalletId } from './walletRegistry'

/**
 * The last address this wallet was seen holding.
 *
 * It exists so an empty read is not mistaken for an empty wallet. `getLightningAddress` answers
 * nothing while the domain is off the edge, and a wallet holds exactly one address, so minting one
 * then replaces the name the customer chose with a generated one and there is no way back: the old
 * name is released the moment the new one is registered.
 *
 * Kept per wallet, since switching wallets changes which address is the right answer.
 */
const FILE = `${RNFS.DocumentDirectoryPath}/ln-address-last.json`

// What the gateway answered was not taken back, and the annulled credits on its domain when it was asked.
type Kept = { address: string; credits: string[] }

type Stored = Record<string, string | Kept>

const valid = (value: unknown): boolean => typeof value === 'object' && value !== null

// Beside a wallet's address, under this prefix and its id, the same address once the gateway said it
// was not taken back (notTakenBack). No wallet id starts with it, so it never reads as an address.
const KEPT = 'kept:'

// A note in any other shape, an address alone included, reads as none, so the sweep asks once more.
function keptOf(memory: Stored, walletId: string): Kept | null {
  const kept = memory[KEPT + walletId]
  if (typeof kept !== 'object' || kept === null || typeof kept.address !== 'string' || !Array.isArray(kept.credits)) {
    return null
  }
  return { address: kept.address, credits: kept.credits.filter(id => typeof id === 'string') }
}

const same = (a: unknown, b: string): boolean =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

// Written whole through a temporary copy, since Android's writeFile truncates in place and a cut mid
// write would leave no memory, and then a mint over the name. Reads and writes share one queue.
const serial = serialQueue()

// What the writers start from. It throws when the file cannot be read, torn or refused by the platform,
// so a write never lays one wallet's name over the other wallets' memory it could not read.
async function stored(): Promise<Stored> {
  return ((await readDurable(FILE, valid)) as Stored | null) ?? {}
}

async function all(): Promise<Stored> {
  try {
    return await stored()
  } catch {
    // A file that cannot be read answers as no memory, never as an error: the caller's fallback is
    // to mint, and a wallet with no address at all is worse than a wallet with the wrong one.
    return {}
  }
}

/**
 * Never throws, and that is the whole contract. This is bookkeeping about an operation that already
 * happened, so a failure here must not become a failure of that operation.
 *
 * A throw here, after a registration that succeeded, would reach the caller as "could not create
 * the address" for an address that changed. Being told a thing failed while it worked is worse than
 * not recording it, and the record exists only to avoid minting over a name that already exists.
 */
export async function rememberLnAddress(address: string, walletId?: string): Promise<void> {
  try {
    // The wallet whose SDK made the change, when the caller knows it. The active one can already be
    // another by the time a slow registration lands, and the note would then describe that wallet.
    const id = walletId ?? (await getActiveWalletId())
    if (!id || !address.includes('@')) {
      return
    }
    // A file that cannot be read is left as it is rather than replaced with this one name.
    await serial(async () => {
      const memory = await stored()
      const next: Stored = { ...memory, [id]: address }
      // The gateway's answer was about the address it names, and stands only beside it.
      if (!same(keptOf(memory, id)?.address, address)) {
        delete next[KEPT + id]
      }
      await writeDurable(FILE, JSON.stringify(next), valid)
    })
  } catch {
    // The next empty read mints a name instead of claiming this one back, which is what happens with
    // no memory at all, so nothing is lost beyond the memory itself.
  }
}

export async function lastLnAddress(walletId?: string): Promise<string | null> {
  const id = walletId ?? (await getActiveWalletId())
  if (!id) {
    return null
  }
  const held = (await serial(all))[id]
  return typeof held === 'string' && held.includes('@') ? held : null
}

/**
 * Dropped when the wallet is removed (wallet.ts, removeWallet), so a new one on the same id does not
 * inherit a name, when the gateway says the wallet's data is deleted (deletion.ts, dropLocalRecords),
 * and when the wallet gives its address up or moves it to another wallet (spark.ts).
 */
export async function forgetLnAddress(walletId: string): Promise<void> {
  try {
    await serial(async () => {
      const memory = await stored()
      delete memory[walletId]
      delete memory[KEPT + walletId]
      await writeDurable(FILE, JSON.stringify(memory), valid)
    })
  } catch {
    // As with remembering, deleting an address must not fail because a note about it did.
  }
}

/**
 * Notes that the gateway said the wallet's remembered address was not taken back by a refund, so the
 * purchase sweep, which passes the annulled credits on every due run while they stay listed, does not
 * ask about that address again (spark.ts, sparkRefreshTakenBackAddress). Each such question costs the
 * gateway up to three holder calls. `credits` are the ids of the annulled credits on the address's
 * domain that prompted the question: the answer covers those refunds only, and a later one annuls
 * another credit. Written only while `address` is the one remembered, and dropped once another is
 * remembered or the memory is forgotten. Never throws.
 */
export async function noteNotTakenBack(
  address: string,
  walletId: string,
  credits: readonly string[],
): Promise<void> {
  try {
    await serial(async () => {
      const memory = await stored()
      if (!same(memory[walletId], address)) {
        return
      }
      const kept: Kept = { address, credits: [...credits] }
      await writeDurable(FILE, JSON.stringify({ ...memory, [KEPT + walletId]: kept }), valid)
    })
  } catch {
    // Without the note the sweep asks once more, which is what it did before the note existed.
  }
}

/**
 * The remembered address the gateway last said was not taken back, while every annulled credit in
 * `credits` was among those it was asked about; null once one is new to the note.
 */
export async function notTakenBack(walletId: string, credits: readonly string[]): Promise<string | null> {
  const memory = await serial(all)
  const kept = keptOf(memory, walletId)
  if (!kept || !same(memory[walletId], kept.address)) {
    return null
  }
  return credits.every(id => kept.credits.includes(id)) ? kept.address : null
}
