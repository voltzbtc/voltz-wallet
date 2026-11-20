package app.usevoltz.durable

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import app.usevoltz.store.NativeVoltzDurableSpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext

// fsync and rename(2) for src/wallet/durableFile.ts, which react-native-fs does not offer. The order
// is AtomicFile's (finishWrite syncs the new file before renaming it over the base) plus a sync of the
// directory, so the rename itself survives a power cut. fsync flushes the file, not the descriptor, so
// a read-only descriptor opened after the write is enough, and the only one a directory takes.
class NativeVoltzDurableModule(reactContext: ReactApplicationContext) : NativeVoltzDurableSpec(reactContext) {

  override fun syncFile(path: String, promise: Promise) = settle(promise) { sync(path) }

  override fun rename(from: String, to: String, promise: Promise) = settle(promise) { Os.rename(from, to) }

  override fun syncDirectory(path: String, promise: Promise) = settle(promise) { sync(path) }

  private fun sync(path: String) {
    val fd = Os.open(path, OsConstants.O_RDONLY or OsConstants.O_CLOEXEC, 0)
    try {
      Os.fsync(fd)
    } finally {
      Os.close(fd)
    }
  }

  private inline fun settle(promise: Promise, work: () -> Unit) {
    try {
      work()
      promise.resolve(null)
    } catch (error: ErrnoException) {
      promise.reject(OsConstants.errnoName(error.errno) ?: "EIO", error.message, error)
    }
  }

  companion object {
    const val NAME = NativeVoltzDurableSpec.NAME
  }
}
