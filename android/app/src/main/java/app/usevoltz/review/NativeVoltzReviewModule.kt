package app.usevoltz.review

import app.usevoltz.store.NativeVoltzReviewSpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import com.google.android.play.core.review.ReviewException
import com.google.android.play.core.review.ReviewInfo
import com.google.android.play.core.review.ReviewManager
import com.google.android.play.core.review.ReviewManagerFactory

// Relays the Play In-App Review API (com.google.android.play:review) and decides nothing:
// src/wallet/storeReview.ts decides when to ask. Play's flow is split in the two calls JS makes:
// prepare runs requestReviewFlow and keeps the ReviewInfo it answers, and launch shows the card with it
// over the activity when Play's quota allows. JS looks at the screen again between the two, since
// requestReviewFlow answers asynchronously and the person may have opened something meanwhile. Play
// says nothing about whether the card showed, so launch resolves once the flow ends either way. Nothing
// is logged, the ReviewInfo is the one thing kept, and a failure rejects with Play's error code alone.
class NativeVoltzReviewModule(reactContext: ReactApplicationContext) : NativeVoltzReviewSpec(reactContext) {

  // Read and written on the UI thread only: Play's listeners run there, and so does every block below.
  private var manager: ReviewManager? = null
  private var prepared: ReviewInfo? = null

  override fun prepare(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val reviews =
        try {
          manager ?: ReviewManagerFactory.create(reactApplicationContext.applicationContext).also { manager = it }
        } catch (error: Exception) {
          promise.reject("unavailable", "the review service could not be reached")
          return@runOnUiThread
        }
      // Play gives a ReviewInfo a limited life, so an older one never outlives a new request.
      prepared = null
      val ask =
        try {
          reviews.requestReviewFlow()
        } catch (error: Exception) {
          promise.reject("unavailable", "the review service could not be reached")
          return@runOnUiThread
        }
      ask.addOnCompleteListener { info ->
        if (!info.isSuccessful) {
          promise.reject(codeOf(info.exception), "the review service failed")
          return@addOnCompleteListener
        }
        prepared = info.result
        promise.resolve(true)
      }
    }
  }

  override fun launch(promise: Promise) {
    // The flow starts Play's own activity, which is started from the UI thread.
    UiThreadUtil.runOnUiThread {
      val info = prepared
      val reviews = manager
      prepared = null
      if (info == null || reviews == null) {
        promise.reject("notPrepared", "no review flow was prepared")
        return@runOnUiThread
      }
      val activity = reactApplicationContext.currentActivity
      if (activity == null) {
        promise.reject("noActivity", "no activity to ask over")
        return@runOnUiThread
      }
      val flow =
        try {
          reviews.launchReviewFlow(activity, info)
        } catch (error: Exception) {
          promise.reject("unavailable", "the review flow could not start")
          return@runOnUiThread
        }
      flow.addOnCompleteListener { promise.resolve(null) }
    }
  }

  private fun codeOf(error: Exception?): String =
    if (error is ReviewException) "play${error.errorCode}" else "failed"

  companion object {
    const val NAME = NativeVoltzReviewSpec.NAME
  }
}
