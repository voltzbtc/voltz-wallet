package app.usevoltz.share

import android.content.ClipData
import android.content.Intent
import androidx.core.content.FileProvider
import app.usevoltz.store.NativeVoltzShareSpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.io.File

// Hands the address card to the app the person picks in the system chooser, for
// src/wallet/addressCard.ts. React Native's Share carries text only on Android, so the image goes as a
// content URI from ShareFileProvider, per developer.android.com/training/secure-file-sharing: the
// provider is not exported, and the read grant rides on the intent, so only the chosen app opens it.
class NativeVoltzShareModule(reactContext: ReactApplicationContext) : NativeVoltzShareSpec(reactContext) {

  override fun shareImage(path: String, text: String, title: String, promise: Promise) {
    val context = reactApplicationContext
    val uri =
      try {
        // Throws for any file outside the provider's one root, so no other file can be handed out.
        FileProvider.getUriForFile(context, context.packageName + AUTHORITY_SUFFIX, File(path))
      } catch (error: IllegalArgumentException) {
        promise.reject(E_FAILED, error.message, error)
        return
      }
    val send =
      Intent(Intent.ACTION_SEND).apply {
        type = "image/png"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_TEXT, text)
        // The chooser passes the grant on to the target it starts only when the URI is in the ClipData.
        clipData = ClipData.newRawUri(null, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
    val activity = context.currentActivity
    if (activity == null) {
      promise.reject(E_FAILED, "no activity to show the chooser over")
      return
    }
    try {
      activity.startActivity(Intent.createChooser(send, title))
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject(E_FAILED, error.message, error)
    }
  }

  companion object {
    const val NAME = "NativeVoltzShare"
    // Matches android:authorities in AndroidManifest.xml.
    private const val AUTHORITY_SUFFIX = ".share"
    private const val E_FAILED = "E_FAILED"
  }
}
