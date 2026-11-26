package app.usevoltz

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import app.usevoltz.age.NativeVoltzAgePackage
import app.usevoltz.biometric.NativeVoltzBiometricPackage
import app.usevoltz.durable.NativeVoltzDurablePackage
import app.usevoltz.privacy.NativeVoltzPrivacyPackage
import app.usevoltz.review.NativeVoltzReviewPackage
import app.usevoltz.qrimage.NativeVoltzQrImagePackage
import app.usevoltz.restart.VoltzRestartPackage
import app.usevoltz.share.NativeVoltzSharePackage
import app.usevoltz.store.NativeVoltzStorePackage
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Autolinking finds library packages only, so the app's own modules are added here.
          add(NativeVoltzStorePackage())
          add(VoltzRestartPackage())
          add(NativeVoltzQrImagePackage())
          add(NativeVoltzPrivacyPackage())
          add(NativeVoltzDurablePackage())
          add(NativeVoltzBiometricPackage())
          add(NativeVoltzAgePackage())
          add(NativeVoltzReviewPackage())
          add(NativeVoltzSharePackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    createNotificationChannel()
  }

  // Android 8 and up refuses to draw a notification whose channel does not exist, and refuses it in
  // silence: the message is delivered and accepted by FCM, Firebase logs nothing beyond a warning,
  // and the device shows nothing.
  //
  // Created here rather than from JS, because a message arriving while the app is not running has
  // no JS to run, and that is the case the notification exists for.
  private fun createNotificationChannel() {
    val id = getString(R.string.default_notification_channel_id)
    val channel =
      NotificationChannel(id, getString(R.string.default_notification_channel_name), NotificationManager.IMPORTANCE_HIGH)
    val manager = getSystemService(NotificationManager::class.java)
    manager?.createNotificationChannel(channel)
  }
}
