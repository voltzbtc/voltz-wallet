package app.usevoltz.review

import app.usevoltz.store.NativeVoltzReviewSpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import com.google.android.play.core.review.ReviewException
import com.google.android.play.core.review.ReviewManagerFactory

// Relays the Play In-App Review API (com.google.android.play:review) and decides nothing:
// src/wallet/storeReview.ts decides when to ask. The flow is Play's: requestReviewFlow answers a
// ReviewInfo, and launchReviewFlow shows the card over the activity when Play's quota allows. Play says
// nothing about whether the card showed, so the promise resolves once the flow ends either way. Nothing
// is logged or kept here, and a failure rejects with Play's error code alone.
class NativeVoltzReviewModule(reactContext: ReactApplicationContext) : NativeVoltzReviewSpec(reactContext) {

  override fun request(promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("noActivity", "no activity to ask over")
      return
    }
    val manager =
      try {
        ReviewManagerFactory.create(reactApplicationContext.applicationContext)
      } catch (error: Exception) {
        promise.reject("unavailable", "the review service could not be reached")
        return
      }
    // The flow starts Play's own activity, which is started from the UI thread.
    UiThreadUtil.runOnUiThread {
      val ask =
        try {
          manager.requestReviewFlow()
        } catch (error: Exception) {
          promise.reject("unavailable", "the review service could not be reached")
          return@runOnUiThread
        }
      ask.addOnCompleteListener { info ->
        if (!info.isSuccessful) {
          promise.reject(codeOf(info.exception), "the review service failed")
          return@addOnCompleteListener
        }
        val flow =
          try {
            manager.launchReviewFlow(activity, info.result)
          } catch (error: Exception) {
            promise.reject("unavailable", "the review flow could not start")
            return@addOnCompleteListener
          }
        flow.addOnCompleteListener { promise.resolve(null) }
      }
    }
  }

  private fun codeOf(error: Exception?): String =
    if (error is ReviewException) "play${error.errorCode}" else "failed"

  companion object {
    const val NAME = NativeVoltzReviewSpec.NAME
  }
}
