package app.usevoltz.store

import com.android.billingclient.api.BillingClient.BillingResponseCode
import com.android.billingclient.api.Purchase
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import java.lang.ref.WeakReference

// The store bridge's TurboModule. It only translates between the codegen spec and StoreBilling,
// where the Play Billing work lives.
class NativeVoltzStoreModule(reactContext: ReactApplicationContext) : NativeVoltzStoreSpec(reactContext) {

  override fun loadProducts(ids: ReadableArray, promise: Promise) {
    val wanted = (0 until ids.size()).mapNotNull { ids.getString(it) }
    StoreBilling.loadProducts(reactApplicationContext, wanted) { failure, products ->
      if (failure != null) {
        promise.reject(failure.responseCode.toString(), failure.debugMessage)
        return@loadProducts
      }
      val listed = Arguments.createArray()
      products.forEach { product ->
        // One offer per one-time product; a product without one has no price to show and is left out.
        val offer = product.oneTimePurchaseOfferDetails ?: return@forEach
        listed.pushMap(
          Arguments.createMap().apply {
            putString("id", product.productId)
            putString("displayPrice", offer.formattedPrice)
          },
        )
      }
      promise.resolve(listed)
    }
  }

  override fun buy(productId: String, reference: String, accountId: String?, promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("noActivity", "no activity to show the purchase sheet on")
      return
    }
    StoreBilling.buy(reactApplicationContext, activity, productId, reference, accountId) { result ->
      // A sheet that opened answers through onUpdate; any other code means it never opened.
      val launched = result.responseCode == BillingResponseCode.OK
      promise.resolve(
        Arguments.createMap().apply {
          putString("status", if (launched) "launched" else "failed")
          putString("code", result.responseCode.toString())
          putNull("subCode")
          putString("message", result.debugMessage)
          putNull("purchase")
        },
      )
    }
  }

  override fun openPurchases(promise: Promise) {
    StoreBilling.openPurchases(reactApplicationContext) { failure, purchases ->
      if (failure != null) {
        promise.reject(failure.responseCode.toString(), failure.debugMessage)
        return@openPurchases
      }
      promise.resolve(Arguments.createArray().apply { purchases.forEach { pushMap(purchaseMap(it)) } })
    }
  }

  // Play purchases are never finished on the device: the gateway consumes after it delivers.
  override fun finish(transactionId: String, promise: Promise) {
    promise.resolve(false)
  }

  // Apple's refund sheet has no Play counterpart: the gateway asks Google for the refund itself.
  override fun beginRefundRequest(transactionId: String, promise: Promise) {
    promise.resolve(
      Arguments.createMap().apply {
        putString("status", "failed")
        putString("code", "unsupported")
        putNull("message")
      },
    )
  }

  // The emitter holds the module weakly: after a reload the old module is gone and invalidate has
  // already put StoreBilling back to queueing.
  override fun takeQueued(promise: Promise) {
    val module = WeakReference(this)
    val drained = StoreBilling.takeQueued { update -> module.get()?.emitOnUpdate(updateMap(update)) }
    promise.resolve(Arguments.createArray().apply { drained.forEach { pushMap(updateMap(it)) } })
  }

  override fun invalidate() {
    StoreBilling.detach()
    super.invalidate()
  }

  companion object {
    const val NAME = NativeVoltzStoreSpec.NAME

    private fun updateMap(update: StoreBilling.Update): WritableMap =
      Arguments.createMap().apply {
        putString("code", update.code.toString())
        putString("subCode", update.subCode.toString())
        putString("message", update.message)
        putArray("purchases", Arguments.createArray().apply { update.purchases.forEach { pushMap(purchaseMap(it)) } })
      }

    // Play signs nothing the app checks and reports refunds to the gateway alone, so verified is
    // always true and revoked always false here.
    private fun purchaseMap(purchase: Purchase): WritableMap =
      Arguments.createMap().apply {
        putArray("productIds", Arguments.createArray().apply { purchase.products.forEach { pushString(it) } })
        putString("key", purchase.purchaseToken)
        putString("reference", purchase.accountIdentifiers?.obfuscatedProfileId)
        putString("state", purchase.purchaseState.toString())
        putDouble("purchasedAt", purchase.purchaseTime.toDouble())
        putBoolean("verified", true)
        putBoolean("revoked", false)
      }
  }
}
