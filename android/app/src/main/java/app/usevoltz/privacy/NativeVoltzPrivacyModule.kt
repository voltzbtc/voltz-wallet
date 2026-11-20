package app.usevoltz.privacy

import app.usevoltz.store.NativeVoltzPrivacySpec
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.UiThreadUtil

// The JS side's way to the cover and the stamp that MainActivity keeps through PrivacyCover;
// src/wallet/relock.ts is the one reader. The cover's views live on the main thread, so every call
// that touches them goes there; the stamp is behind PrivacyCover's own lock and is read where it is
// asked, on the JS thread.
class NativeVoltzPrivacyModule(reactContext: ReactApplicationContext) : NativeVoltzPrivacySpec(reactContext) {

  override fun takeAway(): WritableMap {
    val (left, own) = PrivacyCover.takeAway()
    return Arguments.createMap().apply {
      putDouble("left", left)
      putDouble("own", own)
    }
  }

  override fun hideCover() {
    UiThreadUtil.runOnUiThread { PrivacyCover.hide(closing = false) }
  }

  override fun hideCoverAfterModals() {
    UiThreadUtil.runOnUiThread { PrivacyCover.hide(closing = true) }
  }

  override fun whenInFront(promise: Promise) {
    UiThreadUtil.runOnUiThread { PrivacyCover.whenInFront(promise) }
  }

  override fun beginOwnActivity() {
    PrivacyCover.beginOwnActivity()
  }

  override fun endOwnActivity() {
    PrivacyCover.endOwnActivity()
  }

  // Android shows a share sheet or a picker as an activity of its own, gone before the app resumes, so
  // there is nothing presented over the app to dismiss.
  override fun dismissPresented(promise: Promise) {
    promise.resolve(null)
  }

  companion object {
    const val NAME = NativeVoltzPrivacySpec.NAME
  }
}
