import RNFS from 'react-native-fs'

import Durable from '../../specs/NativeVoltzDurable'

/**
 * JSON files of the app that must survive a process killed mid write, and that must never be read as
 * empty when they cannot be read.
 *
 * RNFS writes in place on Android: RNFSManager.java opens the file truncating it, so a process killed
 * between the truncation and the last byte leaves it torn. On Darwin `createFileAtPath` replaces
 * through a new file (the inode changes on macOS Foundation, and a descriptor opened before keeps the
 * old bytes), so the tear is an Android case there.
 *
 * A write goes whole to `<file>.tmp`, is read back, synced, and only then renamed over the file, and
 * the directory is synced after the rename, the order of Android's AtomicFile and of POSIX
 * (specs/NativeVoltzDurable.ts). Without the syncs a power cut seconds after a write can keep the
 * rename and lose the data it points at, leaving a file of 0 bytes (LWN, "ext4 and data loss", 2009).
 * The rename replaces the file in one step, so the file is never missing while a write runs over it;
 * RNFS's own move cannot do that on iOS, which refuses a destination that exists
 * (`NSFileManager moveItemAtPath`, error 516). A removal and a set aside sync the directory as well,
 * so neither is undone by a cut after it resolved.
 *
 * RNFS answers its calls in order on one native queue and the syncs and the rename run on another, so
 * a read interleaved with a write that moves a finished copy in can find no file and then no copy, and
 * answer nothing at all. Every read and every write of one file therefore runs in one `serialQueue`.
 *
 * A torn copy with no file beside it is a first write that was cut. A finished copy is synced and
 * moved in before any new write starts, and a write renames its own copy over the file only once it
 * read back whole and was synced, so a write leaves its copy torn with no file only when the file was
 * missing as it began. The last finished state is then no file at all. `FirstWriteCut` says whether a
 * caller may read it so. The one other way to leave it is a `setAside` cut between its two moves,
 * after the torn file is already aside, so `asideExists` still answers for what that file held.
 *
 * One residue remains. `RNFS.exists` answers false on any failed stat, not only on a missing file. In
 * react-native-fs 2.20.0 iOS answers `fileExistsAtPath` (RNFSManager.m, `exists`) and Android
 * `File.exists()` (RNFSManager.java, `exists`), and on Android no other call tells the two apart:
 * `stat` goes through `exists`, and `readFile` rejects every FileNotFoundException, a refused open
 * included, as ENOENT. So a stat the platform refuses reads here as no file. That case is unmeasured on hardware;
 * the files live in the app's own Documents directory, where a refusal of the directory also refuses
 * the copy a write starts with, but a refusal of the one file would not. Closing it takes a native
 * exists that reports the error.
 */

type Valid = (value: unknown) => boolean

/** What a file that cannot be read throws. Read by name, which survives any transpilation of the class. */
export class UnreadableFile extends Error {
  constructor(readonly path: string) {
    super(`${path} cannot be read`)
    this.name = 'UnreadableFile'
  }
}

export function isUnreadableFile(err: unknown): boolean {
  return (err as Error | null)?.name === 'UnreadableFile'
}

type OnDisk = { kind: 'missing' } | { kind: 'ok'; value: unknown } | { kind: 'torn' }

const tmpOf = (path: string): string => `${path}.tmp`

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

function durable(): NonNullable<typeof Durable> {
  if (!Durable) {
    throw new Error('NativeVoltzDurable is missing from this binary')
  }
  return Durable
}

// Only the bytes decide that a file is torn. A read the platform refuses says nothing about them, so its
// error reaches the caller as it is, never as `torn`: a torn file is set aside, written over or, under
// 'nothing', taken for no file, and none of that may happen to an intact file a read failed on.
//
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// The bytes as UTF-8 text, or a throw when they are not UTF-8. decodeURIComponent refuses any octet
// sequence that is not well formed UTF-8 (ECMA-262 Decode), overlong forms and surrogates included.
function utf8OfBase64(encoded: string): string {
  // The rules of the base-64 package RNFS decodes with: padding is dropped only at the end of whole
  // groups, any other '=' or a lone digit past the last group is refused, and a last group of two
  // or three digits holds one or two bytes.
  let digits = encoded.replace(/[\t\n\f\r ]/g, '')
  if (digits.length % 4 === 0) {
    digits = digits.replace(/[=]{1,2}$/, '')
  }
  if (digits.length % 4 === 1 || /[^+a-zA-Z0-9/]/.test(digits)) {
    throw new Error('not base64')
  }
  let escaped = ''
  for (let at = 0; at < digits.length; at += 4) {
    const group = digits.slice(at, at + 4)
    // Four digits of six bits are three bytes.
    let value = 0
    for (const digit of group.padEnd(4, 'A')) {
      value = value * 64 + BASE64.indexOf(digit)
    }
    const bytes = [Math.floor(value / 65536), Math.floor(value / 256) % 256, value % 256].slice(0, group.length - 1)
    escaped += bytes.map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('')
  }
  return decodeURIComponent(escaped)
}

// RNFS decodes UTF-8 in JS after the native read, so a file cut inside a multibyte character rejects
// the 'utf8' read as well, with the decoder's error. The bytes, read again as base64 and decoded here,
// tell the two apart. Bytes that decode are the file's text, the first read having failed for a reason
// of the platform's that is gone. Bytes that do not decode are a file that is not text, which is torn.
// A read that fails again, or that answers no bytes (iOS resolves nil when contentsAtPath fails), is
// the platform refusing, and its first error is what the caller meets.
async function readText(path: string): Promise<{ text: string } | { torn: true }> {
  try {
    return { text: await RNFS.readFile(path, 'utf8') }
  } catch (refused) {
    const bytes: unknown = await RNFS.readFile(path, 'base64').catch(() => null)
    if (typeof bytes !== 'string' || bytes.length === 0) {
      throw refused
    }
    try {
      return { text: utf8OfBase64(bytes) }
    } catch {
      return { torn: true }
    }
  }
}

async function readAt(path: string, valid: Valid): Promise<OnDisk> {
  if (!(await RNFS.exists(path))) {
    return { kind: 'missing' }
  }
  const read = await readText(path)
  if (!('text' in read)) {
    return { kind: 'torn' }
  }
  const text = read.text
  try {
    const value: unknown = JSON.parse(text)
    return valid(value) ? { kind: 'ok', value } : { kind: 'torn' }
  } catch {
    return { kind: 'torn' }
  }
}

/**
 * What a torn copy with no file stands for.
 * - `'unreadable'`, the default, reads it as a file that cannot be read, for a file whose first write
 *   may record something nothing else holds.
 * - `'nothing'` reads it as no file, and the next write removes the copy. Only for a file each of
 *   whose first writers acts on what it wrote once the write resolved, or records a fact that lives
 *   elsewhere and is read back from there, so a cut first write lost nothing.
 *
 * A torn file is unreadable under both, with or without a copy beside it.
 */
export type FirstWriteCut = 'unreadable' | 'nothing'

/**
 * The last finished write of a file: the file itself, or the temporary copy a write finished and was
 * cut before moving in. Null when nothing was ever written, and, under `'nothing'`, when only a torn
 * copy is there. Throws `UnreadableFile` when what is there cannot be read: a torn file, and under
 * `'unreadable'` a torn copy with no file too. A read the platform refuses rejects with its own error,
 * which says nothing about the file, so a caller retries rather than taking it for torn.
 */
export async function readDurable(
  path: string,
  valid: Valid,
  firstWriteCut: FirstWriteCut = 'unreadable',
): Promise<unknown> {
  const file = await readAt(path, valid)
  if (file.kind === 'ok') {
    return file.value
  }
  const temp = await readAt(tmpOf(path), valid)
  if (temp.kind === 'ok') {
    return temp.value
  }
  if (file.kind === 'missing' && (temp.kind === 'missing' || firstWriteCut === 'nothing')) {
    return null
  }
  throw new UnreadableFile(path)
}

// A name that holds nothing yet. Android's moveFile replaces its destination, so a taken name is never
// handed to it.
async function freeName(base: string): Promise<string> {
  if (!(await RNFS.exists(base))) {
    return base
  }
  let stamp = Date.now()
  while (await RNFS.exists(`${base}-${stamp}`)) {
    stamp += 1
  }
  return `${base}-${stamp}`
}

async function moveAside(from: string): Promise<string | null> {
  if (!(await RNFS.exists(from))) {
    return null
  }
  const to = await freeName(`${from}.unreadable`)
  await RNFS.moveFile(from, to)
  return to
}

/**
 * Keeps a file that could not be read, and a `<path>.tmp` beside it, out of the way of the next write
 * without deleting a byte: the file goes to `<path>.unreadable` and the copy to
 * `<path>.tmp.unreadable`, each with `-<ms>` after the name when that name is taken. Answers where the
 * file went, where the copy went when there was no file, and an empty string when neither existed.
 *
 * Meant for a file `readDurable` refused, when whatever sits at `<path>.tmp` is torn as well.
 */
export async function setAside(path: string): Promise<string> {
  const file = await moveAside(path)
  const copy = await moveAside(tmpOf(path))
  // A move is a directory entry a power cut can undo until the directory is synced, which would put
  // the unreadable file back under its name after this resolved.
  await durable().syncDirectory(dirOf(path))
  return file ?? copy ?? ''
}

/**
 * Whether anything was ever set aside for the path. The plain name is always taken first, so a name
 * with a timestamp never exists without it.
 */
export async function asideExists(path: string): Promise<boolean> {
  return (
    (await RNFS.exists(`${path}.unreadable`)) || (await RNFS.exists(`${tmpOf(path)}.unreadable`))
  )
}

/**
 * Writes the text as the file's content, whole or not at all. Once it resolves the content is on stable
 * storage, so a power cut keeps it; a cut before then leaves the content from before or the new one.
 *
 * `overTorn` says what a file that cannot be read (torn, or of another shape) is worth:
 * - `'refuse'` keeps it. A finished copy beside it enters first and the torn file is set aside; a torn
 *   file with no finished copy, or under `firstWriteCut` `'unreadable'` only a torn copy with no file,
 *   throws `UnreadableFile` before anything is touched. Nothing in the app overwrites what it could
 *   not read.
 * - `'replace'` writes over it, for a file the caller rebuilds from another source when it cannot be
 *   read.
 *
 * `firstWriteCut` is the setting the file's reader passes to `readDurable`. Under `'nothing'` a torn
 * copy with no file is removed and the write goes on, in either mode.
 *
 * A read the platform refuses, of the file or of the copy, rejects with its own error before anything
 * is touched, in either mode.
 */
export async function writeDurable(
  path: string,
  text: string,
  valid: Valid,
  overTorn: 'refuse' | 'replace' = 'refuse',
  firstWriteCut: FirstWriteCut = 'unreadable',
): Promise<void> {
  const tmp = tmpOf(path)
  const file = await readAt(path, valid)
  if (file.kind !== 'ok') {
    const copy = await readAt(tmp, valid)
    if (copy.kind === 'ok') {
      // With the file gone or torn, a finished temporary copy is the only good one, so it is moved in
      // before this write overwrites it. Under 'replace' it goes over the torn file in one step. A copy
      // whose process was killed before its sync may still sit only in the page cache, so it reaches
      // stable storage before the file's name points at it.
      await durable().syncFile(tmp)
      if (file.kind === 'torn' && overTorn === 'refuse') {
        await moveAside(path)
      }
      await durable().rename(tmp, path)
    } else if (
      overTorn === 'refuse' &&
      (file.kind === 'torn' || (copy.kind === 'torn' && firstWriteCut === 'unreadable'))
    ) {
      throw new UnreadableFile(path)
    }
  }
  if (await RNFS.exists(tmp)) {
    await RNFS.unlink(tmp)
  }
  await RNFS.writeFile(tmp, text, 'utf8')
  // Read back before it replaces anything, so a short write the platform reported as done never
  // lands over a good file.
  if ((await RNFS.readFile(tmp, 'utf8')) !== text) {
    throw new Error(`${path}: the temporary copy did not read back`)
  }
  // The copy's bytes reach stable storage before any name points at them, and the rename reaches it
  // before the write resolves; the directory sync also keeps any earlier move of this write.
  const sync = durable()
  await sync.syncFile(tmp)
  await sync.rename(tmp, path)
  await sync.syncDirectory(dirOf(path))
}

export async function removeDurable(path: string): Promise<void> {
  // The temporary copy goes first: left behind a removed file, it would read as its last write.
  if (await RNFS.exists(tmpOf(path))) {
    await RNFS.unlink(tmpOf(path))
  }
  if (await RNFS.exists(path)) {
    await RNFS.unlink(path)
  }
  // An unlink is a directory entry a power cut can undo until the directory is synced, which would
  // bring the removed file back after this resolved. The sync runs when nothing was there as well,
  // since an unlink by a process killed before its own sync may still sit in the page cache.
  await durable().syncDirectory(dirOf(path))
}

/**
 * A queue of its own: `serial(work)` runs the work after every earlier one has settled, whether it
 * resolved or rejected, and answers with the work's own result. One per module that owns files, so
 * modules never wait on each other.
 */
export function serialQueue(): <T>(work: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve()
  return function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work)
    queue = run.catch(() => undefined)
    return run
  }
}
