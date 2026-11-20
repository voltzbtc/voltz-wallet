package app.usevoltz.store

import android.app.Activity
import android.content.Context
import android.util.Log
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClient.BillingResponseCode
import com.android.billingclient.api.BillingClient.ProductType
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams

// Play Billing behind the store bridge. It relays what Google Play says, raw: response codes as they
// came and every listener call whole. src/wallet/store.ts decides which call answers the purchase in
// flight and what each code means, where Jest and Stryker reach the rules.
//
// Nothing here consumes or acknowledges a purchase. The gateway consumes after it delivers, and a
// consume on the device would race it and let the product be bought again before delivery.
object StoreBilling {
  private const val TAG = "VoltzStore"

  // The queue is a shortcut, not a source: queryPurchasesAsync lists every unconsumed purchase on
  // the next read, so losing the oldest costs a later confirmation, never a purchase.
  const val QUEUE_LIMIT = 100

  // One call of the PurchasesUpdatedListener.
  class Update(val code: Int, val subCode: Int, val message: String?, val purchases: List<Purchase>)

  private val lock = Any()
  private var client: BillingClient? = null
  private var connected = false
  private var connecting = false
  private val waiting = mutableListOf<(BillingClient, BillingResult?) -> Unit>()
  private val queue = ArrayDeque<Update>()
  private var emit: ((Update) -> Unit)? = null
  private val details = HashMap<String, ProductDetails>()

  private val listener = PurchasesUpdatedListener { result, purchases ->
    relay(Update(result.responseCode, result.onPurchasesUpdatedSubResponseCode, result.debugMessage, purchases.orEmpty()))
  }

  // Queues while nobody listens and hands over directly once takeQueued has run. The emitter is
  // called outside the lock, so a slow listener never holds up Play's callbacks.
  fun relay(update: Update) {
    val direct =
      synchronized(lock) {
        emit
          ?: run {
            queue.addLast(update)
            while (queue.size > QUEUE_LIMIT) {
              queue.removeFirst()
            }
            null
          }
      }
    direct?.invoke(update)
  }

  // Draining and switching to direct emission happen under one lock, so an update lands either in
  // the drained list or with the emitter, never in both and never in neither.
  fun takeQueued(emitter: (Update) -> Unit): List<Update> =
    synchronized(lock) {
      val drained = queue.toList()
      queue.clear()
      emit = emitter
      drained
    }

  // A JS reload invalidates the module that held the emitter, and what arrives until the next
  // takeQueued waits in the queue.
  fun detach() {
    synchronized(lock) { emit = null }
  }

  fun loadProducts(context: Context, ids: List<String>, done: (BillingResult?, List<ProductDetails>) -> Unit) {
    if (ids.isEmpty()) {
      done(null, emptyList())
      return
    }
    withClient(context) { client, failure ->
      if (failure != null) {
        done(failure, emptyList())
        return@withClient
      }
      queryDetails(client, ids) { result, found -> done(result, found) }
    }
  }

  fun buy(
    context: Context,
    activity: Activity,
    productId: String,
    reference: String,
    accountId: String?,
    done: (BillingResult) -> Unit,
  ) {
    withClient(context) { client, failure ->
      if (failure != null) {
        done(failure)
        return@withClient
      }
      val cached = synchronized(lock) { details[productId] }
      if (cached != null) {
        launch(client, activity, cached, reference, accountId, done)
        return@withClient
      }
      queryDetails(client, listOf(productId)) { result, found ->
        val product = found.firstOrNull { it.productId == productId }
        when {
          result != null -> done(result)
          product == null -> done(billingResult(BillingResponseCode.ITEM_UNAVAILABLE, "Play does not list $productId"))
          else -> launch(client, activity, product, reference, accountId, done)
        }
      }
    }
  }

  // Purchased and pending one-time purchases not consumed yet. A consumed purchase is gone from
  // this list, which is why the gateway, and not this list, is the record of what was delivered.
  fun openPurchases(context: Context, done: (BillingResult?, List<Purchase>) -> Unit) {
    withClient(context) { client, failure ->
      if (failure != null) {
        done(failure, emptyList())
        return@withClient
      }
      val params = QueryPurchasesParams.newBuilder().setProductType(ProductType.INAPP).build()
      client.queryPurchasesAsync(params) { result, purchases ->
        done(if (result.responseCode == BillingResponseCode.OK) null else result, purchases)
      }
    }
  }

  // The client starts on the first call from JS rather than with the process: the listener only
  // fires while connected, and what arrived before that comes back through queryPurchasesAsync.
  // enableAutoServiceReconnection reconnects when a call finds the service gone, so only the first
  // connection is waited for here.
  private fun withClient(context: Context, action: (BillingClient, BillingResult?) -> Unit) {
    var ready: BillingClient? = null
    var start: BillingClient? = null
    synchronized(lock) {
      val current =
        client
          ?: BillingClient.newBuilder(context.applicationContext)
            .setListener(listener)
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .enableAutoServiceReconnection()
            .build()
            .also { client = it }
      if (connected) {
        ready = current
      } else {
        waiting.add(action)
        if (!connecting) {
          connecting = true
          start = current
        }
      }
    }
    ready?.let { action(it, null) }
    val starting = start ?: return
    starting.startConnection(
      object : BillingClientStateListener {
        override fun onBillingSetupFinished(result: BillingResult) {
          val ok = result.responseCode == BillingResponseCode.OK
          val pending =
            synchronized(lock) {
              connecting = false
              connected = ok
              waiting.toList().also { waiting.clear() }
            }
          pending.forEach { it(starting, if (ok) null else result) }
        }

        // Left empty on purpose: the automatic reconnection handles a lost service on the next call.
        override fun onBillingServiceDisconnected() = Unit
      },
    )
  }

  private fun queryDetails(client: BillingClient, ids: List<String>, done: (BillingResult?, List<ProductDetails>) -> Unit) {
    val products =
      ids.map { QueryProductDetailsParams.Product.newBuilder().setProductId(it).setProductType(ProductType.INAPP).build() }
    val params = QueryProductDetailsParams.newBuilder().setProductList(products).build()
    client.queryProductDetailsAsync(params) { result, found ->
      if (result.responseCode != BillingResponseCode.OK) {
        done(result, emptyList())
        return@queryProductDetailsAsync
      }
      // An unfetched product is left out, so a screen never offers what Play cannot sell, and buying
      // it answers ITEM_UNAVAILABLE.
      found.unfetchedProductList.forEach { Log.w(TAG, "unfetched ${it.productId}, status ${it.statusCode}") }
      val listed = found.productDetailsList
      synchronized(lock) { listed.forEach { details[it.productId] = it } }
      done(null, listed)
    }
  }

  // The order's reference travels as obfuscatedProfileId and the wallet's HMAC as
  // obfuscatedAccountId, both copied from the gateway's order. The offer token goes whenever Play
  // gives one, since the reference does not say when it may be left out.
  private fun launch(
    client: BillingClient,
    activity: Activity,
    product: ProductDetails,
    reference: String,
    accountId: String?,
    done: (BillingResult) -> Unit,
  ) {
    val productParams =
      BillingFlowParams.ProductDetailsParams.newBuilder()
        .setProductDetails(product)
        .apply { product.oneTimePurchaseOfferDetails?.offerToken?.let { setOfferToken(it) } }
        .build()
    val flow =
      BillingFlowParams.newBuilder()
        .setProductDetailsParamsList(listOf(productParams))
        .setObfuscatedProfileId(reference)
        .apply { accountId?.let { setObfuscatedAccountId(it) } }
        .build()
    // launchBillingFlow belongs on the main thread.
    activity.runOnUiThread { done(client.launchBillingFlow(activity, flow)) }
  }

  private fun billingResult(code: Int, message: String): BillingResult =
    BillingResult.newBuilder().setResponseCode(code).setDebugMessage(message).build()
}
