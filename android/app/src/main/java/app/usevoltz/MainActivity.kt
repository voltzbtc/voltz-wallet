package app.usevoltz

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
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
  //
  // FLAG_SECURE does not reach accessibility services, which read the text of every view. From
  // Android 14 a view marked accessibility data sensitive answers only services declared as
  // accessibility tools (TalkBack, Switch Access, Voice Access), and a view's descendants inherit the
  // mark (View.calculateAccessibilityDataSensitive). Marked on the decor before the window is attached,
  // it covers every view the window draws, the window's scope as for FLAG_SECURE, so the recovery words
  // and the passphrase carry it on every screen that draws them, whatever field or grid draws them. A
  // React Native Modal is a window of its own that the mark does not reach, and none draws either;
  // __tests__/androidActivity.test.ts holds that.
  override fun onCreate(savedInstanceState: Bundle?) {
    window.setFlags(
      WindowManager.LayoutParams.FLAG_SECURE,
      WindowManager.LayoutParams.FLAG_SECURE,
    )
    super.onCreate(null)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      window.decorView.setAccessibilityDataSensitive(View.ACCESSIBILITY_DATA_SENSITIVE_YES)
    }
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
