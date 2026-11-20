package app.usevoltz.restart

import com.facebook.react.ReactApplication
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

// Restarts the JS runtime, so I18nManager reads the direction flags again (src/i18n/direction.ts).
//
// react-native-restart cannot do this under the New Architecture: it asks for getReactNativeHost,
// which throws without the old bridge, and falls back to Activity.recreate, which keeps the runtime
// and restores the navigator's fragments into a new activity, where react-native-screens crashes.
// ReactHost.reload tears down the instance and starts a new one on the same activity.
class VoltzRestartModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun reload(reason: String) {
    (reactApplicationContext.applicationContext as? ReactApplication)?.reactHost?.reload(reason)
  }

  companion object {
    const val NAME = "VoltzRestart"
  }
}
