package app.usevoltz

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import app.usevoltz.privacy.PrivacyCover
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  // Seed, keys and balances render in-app, so block screenshots, screen recording and the
  // recents thumbnail at the window level. The Receive screen's share sheet already covers the
  // one legitimate "share this invoice" flow, so nothing real is lost.
  //
  // The saved state is dropped by choice: react-native-screens' fragments throw when the system
  // restores them, which a per-app language change or a return to an app the system killed in the
  // background both do. Both paths were measured on an API 36 emulator, crashing with the state
  // passed and drawing the PIN screen again without it. React draws the screens again from JS. The
  // route the library's README documents keeps the state and sets RNScreensFragmentFactory instead.
  override fun onCreate(savedInstanceState: Bundle?) {
    window.setFlags(
      WindowManager.LayoutParams.FLAG_SECURE,
      WindowManager.LayoutParams.FLAG_SECURE,
    )
    super.onCreate(null)
  }

  // Stamps the leave and raises the cover before super, which is where React Native hears of the
  // pause, so the time away and the cover never wait on JS, and the cover is the top window before the
  // system can freeze the process. The JS side lowers it once it has decided (src/hooks/useRelock.ts).
  override fun onPause() {
    PrivacyCover.onPause(this)
    super.onPause()
  }

  // Before super, so a new activity that replaces one destroyed while away is covered before React
  // Native hears of the return.
  override fun onResume() {
    PrivacyCover.onResume(this)
    super.onResume()
  }

  // The return is complete only here: a biometric prompt shown before it fails, so the JS side waits
  // for it before deciding, and the cover ignores a hide that comes sooner.
  override fun onPostResume() {
    super.onPostResume()
    PrivacyCover.onPostResume()
  }

  override fun onDestroy() {
    PrivacyCover.release(this)
    super.onDestroy()
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "VoltzWallet"

  // A zap invoice, a lightning URI, opened while the app is already running (singleTask) arrives here.
  // Forward to React (super) so JS's Linking 'url' event fires, and update the activity intent so a
  // later getInitialURL() sees it too.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
  }

  /**
   * Returns the instance of the [ReactActivityDelegate]. [DefaultReactActivityDelegate] enables the
   * New Architecture through the single boolean flag [fabricEnabled].
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
