import RNFS from 'react-native-fs'
import { isUnreadableFile, readDurable, removeDurable, serialQueue, setAside, writeDurable } from './durableFile'

/**
 * The sends a wallet left pending and has not yet told the person the end of, one file per wallet.
 * This module is its only writer.
 *
 * A Lightning send can stay pending for days while the receiver holds the HTLC, and the SDK stops
 * polling it after about 185 s (lightning_sender.rs, MAX_POLL_ATTEMPTS), so the end can come long after
 * the screen and even the process are gone. An id leaves this record exactly once, through
 * `settlePendingSend`, and only the call that removed it may tell, so one send is told at most once,
 * across restarts too.
 *
 * It holds ids and nothing else, since the outcome is always read from the SDK, never from here.
 */

const VERSION = 1

type Stored = { version: number; walletId: string; sends: string[] }

const isStored = (value: unknown): boolean => {
  const v = value as Partial<Stored> | null
  return (
    typeof v === 'object' &&
    v !== null &&
    v.version === VERSION &&
    typeof v.walletId === 'string' &&
    Array.isArray(v.sends) &&
    v.sends.every(id => typeof id === 'string')
  )
}

const pathOf = (walletId: string): string =>
  `${RNFS.DocumentDirectoryPath}/pending-sends-${encodeURIComponent(walletId)}.json`

const serial = serialQueue()

// Ids whose write failed, kept for this process and written again with the next write, so a send is
// still followed while the disk refuses rather than dropped without a trace.
const unwritten = new Map<string, Set<string>>()

function unwrittenOf(walletId: string): Set<string> {
  let set = unwritten.get(walletId)
  if (!set) {
    set = new Set()
    unwritten.set(walletId, set)
  }
  return set
}

// Ids noted by this process. The sync that vouches for the SDK's word that it never stored a send
// has to come after the send, and one this process noted can postdate every sync the connection
// heard, so only a later process, whose syncs all follow it, drops it as unknown.
const notedHere = new Map<string, Set<string>>()

async function readIds(walletId: string): Promise<string[]> {
  const stored = (await readDurable(pathOf(walletId), isStored)) as Stored | null
  return stored?.sends ?? []
}

async function writeIds(walletId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    await removeDurable(pathOf(walletId))
    return
  }
  const stored: Stored = { version: VERSION, walletId, sends: ids }
  await writeDurable(pathOf(walletId), JSON.stringify(stored), isStored)
}

// The file's ids with every unwritten one added, written back when anything was missing. A file that
// cannot be read throws, and nothing is written over it.
async function merged(walletId: string): Promise<string[]> {
  const ids = await readIds(walletId)
  const extra = [...unwrittenOf(walletId)].filter(id => !ids.includes(id))
  if (extra.length > 0) {
    await writeIds(walletId, [...ids, ...extra])
  }
  unwrittenOf(walletId).clear()
  return [...ids, ...extra]
}

/** Notes a send its confirm left pending. Never rejects: a failed write keeps the id in memory. */
export function notePendingSend(walletId: string, paymentId: string): Promise<void> {
  notedHere.set(walletId, (notedHere.get(walletId) ?? new Set()).add(paymentId))
  unwrittenOf(walletId).add(paymentId)
  return serial(() => merged(walletId)).then(
    () => undefined,
    () => undefined,
  )
}

export type PendingSends = { kind: 'ok'; ids: string[] } | { kind: 'torn' }

/**
 * The wallet's pending sends. `torn` when the file's bytes cannot be read, which no caller may take
 * for an empty list; a read the platform refuses rejects with its own error.
 */
export function readPendingSends(walletId: string): Promise<PendingSends> {
  return serial(async () => {
    try {
      return { kind: 'ok', ids: await merged(walletId) } as const
    } catch (cause) {
      if (isUnreadableFile(cause)) {
        return { kind: 'torn' } as const
      }
      throw cause
    }
  })
}

/**
 * Replaces a torn file with the sends the SDK still holds pending: the torn bytes go aside, never
 * deleted, and the unwritten ids join the new list. What the torn file held that is no longer pending
 * is not told, since nothing readable says it was ever untold.
 */
export function rebuildPendingSends(walletId: string, stillPending: string[]): Promise<void> {
  return serial(async () => {
    await setAside(pathOf(walletId))
    const ids = [...new Set([...stillPending, ...unwrittenOf(walletId)])]
    await writeIds(walletId, ids)
    unwrittenOf(walletId).clear()
  })
}

/**
 * Takes the send out of the record. True only for the one call that removed it, which is the only
 * one allowed to tell; false when it was not there, or when the file cannot be read or written, so a
 * file in doubt never produces a notice.
 */
export function settlePendingSend(walletId: string, paymentId: string): Promise<boolean> {
  return serial(async () => {
    const memory = unwrittenOf(walletId)
    let ids: string[]
    try {
      ids = await readIds(walletId)
    } catch {
      return memory.delete(paymentId)
    }
    if (!ids.includes(paymentId)) {
      return memory.delete(paymentId)
    }
    try {
      await writeIds(
        walletId,
        ids.filter(id => id !== paymentId),
      )
    } catch {
      return false
    }
    memory.delete(paymentId)
    return true
  })
}

/**
 * Takes out, with no notice, a send the SDK holds no row for. False for a send this process noted,
 * as well as when it was not there or the file cannot be read or written.
 */
export function dropUnknownSend(walletId: string, paymentId: string): Promise<boolean> {
  if (notedHere.get(walletId)?.has(paymentId)) {
    return Promise.resolve(false)
  }
  return settlePendingSend(walletId, paymentId)
}

/** Drops the wallet's record, for a wallet being removed. */
export function forgetPendingSends(walletId: string): Promise<void> {
  unwritten.delete(walletId)
  notedHere.delete(walletId)
  return serial(() => removeDurable(pathOf(walletId)))
}
