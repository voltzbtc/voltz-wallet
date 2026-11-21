package app.usevoltz.age

import app.usevoltz.store.NativeVoltzAgeSpec
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableMap
import com.google.android.gms.tasks.Task
import com.google.android.play.agesignals.AgeSignalsAccessRequest
import com.google.android.play.agesignals.AgeSignalsException
import com.google.android.play.agesignals.AgeSignalsManager
import com.google.android.play.agesignals.AgeSignalsManagerFactory
import com.google.android.play.agesignals.AgeSignalsRequest
import com.google.android.play.agesignals.ApplicableAgeFeaturesRequest
import com.google.android.play.agesignals.model.AgeSignalsStatus
import com.google.android.play.agesignals.model.ApplicableAgeFeature

// Relays the Play Age Signals API (com.google.android.play:age-signals) and decides nothing:
// src/wallet/ageSignal.ts reads the range. The flow is Play's: getApplicableAgeFeatures says whether
// the person is in a region whose law makes sharing mandatory, requestAgeSignalsAccess may show Play's
// sharing prompt over the activity, and checkAgeSignals answers a range only once access is SHARED.
// Nothing is logged or kept here, and a failure rejects with Play's error code alone.
class NativeVoltzAgeModule(reactContext: ReactApplicationContext) : NativeVoltzAgeSpec(reactContext) {

  private val manager: AgeSignalsManager by lazy {
    AgeSignalsManagerFactory.create(reactApplicationContext.applicationContext)
  }

  override fun regulated(promise: Promise) {
    settle(promise, { manager.getApplicableAgeFeatures(ApplicableAgeFeaturesRequest.builder().build()) }) { result ->
      promise.resolve(result.features().contains(ApplicableAgeFeature.MANDATORY_SHARING))
    }
  }

  override fun request(promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("noActivity", "no activity to ask over")
      return
    }
    // The access request may start Play's prompt activity, which is started from the UI thread.
    UiThreadUtil.runOnUiThread {
      val access = AgeSignalsAccessRequest.builder().setActivity(activity).build()
      settle(promise, { manager.requestAgeSignalsAccess(access) }) { result ->
        when (result.ageSignalsStatus()) {
          AgeSignalsStatus.SHARED -> check(promise)
          AgeSignalsStatus.NOT_SHARED -> promise.resolve(answer("notShared", null, null))
          AgeSignalsStatus.VERIFICATION_REQUIRED -> promise.resolve(answer("verificationRequired", null, null))
          else -> promise.resolve(answer("unspecified", null, null))
        }
      }
    }
  }

  private fun check(promise: Promise) {
    settle(promise, { manager.checkAgeSignals(AgeSignalsRequest.builder().build()) }) { result ->
      promise.resolve(answer("shared", result.ageLower(), result.ageUpper()))
    }
  }

  // Every Task settles the promise once: a success through `done`, a failure or a cancel as a
  // rejection, and a manager that cannot be made or a call that throws as one too, so the reader's ask
  // always ends.
  private fun <T> settle(promise: Promise, start: () -> Task<T>, done: (T) -> Unit) {
    val task =
      try {
        start()
      } catch (error: Exception) {
        promise.reject("unavailable", "the age signals service could not be reached")
        return
      }
    task
      .addOnSuccessListener { result -> done(result) }
      .addOnFailureListener { error -> promise.reject(codeOf(error), "the age signals service failed") }
      .addOnCanceledListener { promise.reject("cancelled", "the age signals request was cancelled") }
  }

  private fun codeOf(error: Exception): String =
    if (error is AgeSignalsException) "play${error.errorCode}" else "failed"

  // A bound Play leaves open, or does not give, is -1.
  private fun answer(status: String, lower: Int?, upper: Int?): WritableMap =
    Arguments.createMap().apply {
      putString("status", status)
      putInt("lower", lower ?: -1)
      putInt("upper", upper ?: -1)
    }

  companion object {
    const val NAME = NativeVoltzAgeSpec.NAME
  }
}
