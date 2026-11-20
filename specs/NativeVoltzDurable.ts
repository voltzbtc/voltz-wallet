import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The codegen spec of the three calls that make a write survive a power cut, which react-native-fs
// does not have. src/wallet/durableFile.ts is the one reader, and it follows Android's AtomicFile:
// the new copy is synced, renamed over the file, and the directory synced after.
//
// A write the platform reported as done may still sit in the page cache, and the rename that puts it
// in place is a directory entry that may sit there too. A power cut then leaves the new name pointing
// at blocks that were never written, a file of 0 bytes (LWN, "ext4 and data loss", 2009). fsync on
// the file before the rename and on the directory after it is the order POSIX needs; on Darwin fsync
// stops at the drive's cache, so iOS asks for F_FULLFSYNC (fsync(2) and fcntl(2) on Darwin).

// Every call rejects with the errno as the error's code: its name on Android (ENOENT, EIO, from
// OsConstants.errnoName) and `E` with its number on iOS (E2, E5). Nothing in JS reads the code.
export interface Spec extends TurboModule {
  // Puts the file's data and size on stable storage.
  syncFile(path: string): Promise<void>
  // rename(2): moves `from` onto `to`, replacing a file at `to` in one step, so a reader or a cut sees
  // the old file or the new one and never neither. Both paths sit in one directory.
  rename(from: string, to: string): Promise<void>
  // Puts the directory's entries on stable storage, so a rename in it survives a cut.
  syncDirectory(path: string): Promise<void>
}

// `get`, not `getEnforcing`, so a binary without the module fails each durable write with a plain
// error instead of failing the boot at import.
export default TurboModuleRegistry.get<Spec>('NativeVoltzDurable')
