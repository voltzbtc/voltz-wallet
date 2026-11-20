import RNFS from 'react-native-fs'
import { isUnreadableFile, readDurable, serialQueue, writeDurable } from './durableFile'
import type { HistoryConversionSide, HistoryItem } from './payment'
import { formatBaseUnitsExact } from './sparkConvert'

/**
 * What the SDK quoted for a Convert, kept because it gives nothing else.
 *
 * A self conversion has no conversion status, and the leg that left is hidden from every read, so the
 * row of a Convert knows only what arrived. The quote is the one record of what left and of the fee.
 * It is a quote: a conversion by minimum output is priced again at send, so every figure read from
 * here is drawn as quoted, and whatever the SDK says outranks it.
 *
 * Keyed by wallet and by the id `sendPayment` returns, which for a self conversion is the id of the
 * leg that arrived, the row the list shows (`complete_conversion_and_send`, SDK 0.27.2). Nothing matches
 * by time or amount, so a note can only ever reach the payment it was written for.
 *
 * One file through `durableFile`, as the address memory: a process killed mid write leaves every
 * wallet's notes in place, and its queue keeps the two legs of a pair from writing over each other. A
 * lost note costs only this display, so unlike that memory a torn file is written over.
 */
const FILE = `${RNFS.DocumentDirectoryPath}/conversion-notes.json`

// Older rows go back to what the SDK gives. The file is read whenever a list shows a conversion, so
// it stays small.
export const MAX_NOTES_PER_WALLET = 200

// `ticker` null is Bitcoin. Amounts stay in base units with their decimals, so each side converts by
// its own asset when it is drawn.
type NoteAsset = { ticker: string | null; decimals: number }
type NoteAmount = NoteAsset & { baseUnits: string }

export type ConversionNote = { from: NoteAmount; to: NoteAsset; fee: NoteAmount }

type Stored = Record<string, Record<string, unknown>>

const valid = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value)

// One wallet's entry, which `valid` does not reach: anything else in its place holds no note.
const entryOf = (notes: Stored, walletId: string): Record<string, unknown> =>
  valid(notes[walletId]) ? notes[walletId] : {}

const serial = serialQueue()

const isAsset = (value: unknown): value is NoteAsset => {
  const asset = value as NoteAsset | null
  return (
    typeof asset === 'object' &&
    asset !== null &&
    (asset.ticker === null || typeof asset.ticker === 'string') &&
    Number.isInteger(asset.decimals) &&
    asset.decimals >= 0
  )
}

const isAmount = (value: unknown): value is NoteAmount =>
  isAsset(value) && typeof (value as NoteAmount).baseUnits === 'string' && /^\d+$/.test((value as NoteAmount).baseUnits)

function noteOf(value: unknown): ConversionNote | undefined {
  const note = value as ConversionNote | null
  return typeof note === 'object' && note !== null && isAmount(note.from) && isAsset(note.to) && isAmount(note.fee)
    ? note
    : undefined
}

// What a writer starts from. Only a torn file reads as empty, since a read the platform refuses says
// nothing about the notes in it, and writing then would lose them all.
async function stored(): Promise<Stored> {
  try {
    return ((await readDurable(FILE, valid, 'nothing')) as Stored | null) ?? {}
  } catch (err) {
    if (isUnreadableFile(err)) {
      return {}
    }
    throw err
  }
}

const save = (notes: Stored): Promise<void> => writeDurable(FILE, JSON.stringify(notes), valid, 'replace', 'nothing')

// How many times a wallet's notes were forgotten this run. A note on its way while they go belongs to
// the wallet that left, and written after it would reach whichever wallet takes the id next.
const forgotten = new Map<string, number>()

export function conversionNotesEra(walletId: string | null): number {
  return walletId === null ? 0 : forgotten.get(walletId) ?? 0
}

/** Rejects when the note could not be kept. Its caller logs that and goes on. */
export async function keepConversionNote(
  walletId: string,
  paymentId: string,
  note: ConversionNote,
  era = conversionNotesEra(walletId),
): Promise<void> {
  await serial(async () => {
    if (era !== conversionNotesEra(walletId)) {
      return
    }
    const notes = await stored()
    const kept = Object.entries({ ...entryOf(notes, walletId), [paymentId]: note }).slice(-MAX_NOTES_PER_WALLET)
    await save({ ...notes, [walletId]: Object.fromEntries(kept) })
  })
}

// Dropped in removeWallet, so a wallet that comes back on the same id starts from what the SDK gives.
export async function forgetConversionNotes(walletId: string): Promise<void> {
  forgotten.set(walletId, conversionNotesEra(walletId) + 1)
  await serial(async () => {
    const notes = await stored()
    if (walletId in notes) {
      delete notes[walletId]
      await save(notes)
    }
  })
}

// A file that cannot be read shows the rows with no note, never an error, since nothing is lost by it.
async function notesFor(walletId: string): Promise<Record<string, unknown>> {
  try {
    return entryOf(await serial(stored), walletId)
  } catch {
    return {}
  }
}

const figure = (amount: NoteAmount): string => formatBaseUnitsExact(BigInt(amount.baseUnits), amount.decimals)

// The note fills only what the SDK left out, field by field, and a row that names another asset than
// the note is not the conversion the note describes. A fee the SDK gave on either side stands alone.
export function withConversionNote(item: HistoryItem, note: ConversionNote | undefined): HistoryItem {
  const conversion = item.conversion
  if (!note || !conversion || item.direction !== 'converted') {
    return item
  }
  const { from, to } = conversion
  if ((from && from.ticker !== note.from.ticker) || (to && to.ticker !== note.to.ticker)) {
    return item
  }
  const left: HistoryConversionSide =
    from?.amount !== undefined ? from : { ...from, ticker: note.from.ticker, amount: figure(note.from), quoted: true }
  const feeKnown = from?.fee !== undefined || to?.fee !== undefined || BigInt(note.fee.baseUnits) === 0n
  return {
    ...item,
    conversion: {
      ...conversion,
      from: left,
      to: to ?? { ticker: note.to.ticker },
      ...(feeKnown ? {} : { quotedFee: { ticker: note.fee.ticker, amount: figure(note.fee) } }),
    },
  }
}

// The file is read only when a row could use it, and the wallet is the one the rows were read from.
export async function withConversionNotes(items: HistoryItem[], walletId: string | null): Promise<HistoryItem[]> {
  if (walletId === null || !items.some(item => item.direction === 'converted')) {
    return items
  }
  const notes = await notesFor(walletId)
  return items.map(item => withConversionNote(item, noteOf(notes[item.id])))
}
