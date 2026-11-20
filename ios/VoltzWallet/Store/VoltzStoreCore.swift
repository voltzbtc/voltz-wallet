import Foundation
import StoreKit
import UIKit

// StoreKit 2 behind the store bridge. It relays what the App Store says, raw: case names for errors,
// the transaction as it came, and nothing finished unless the JS side asks for that one id.
// src/wallet/store.ts is the one reader that maps it, where Jest and Stryker reach the rules.
@objcMembers public final class VoltzStoreCore: NSObject {
  public static let shared = VoltzStoreCore()

  // The queue is a shortcut, not a source: Transaction.unfinished hands every open purchase back on
  // the next read, so losing the oldest costs a later confirmation, never a purchase.
  public static let queueLimit = 100

  private let lock = NSLock()
  private var queued: [[String: Any]] = []
  private var emit: (([String: Any]) -> Void)?
  private var listening: Task<Void, Never>?

  public override init() {
    super.init()
  }

  // Apple hands the transactions left unfinished to Transaction.updates once, right after launch, so
  // the listener starts from the app delegate, before the JS runtime and this module exist.
  public func start() {
    lock.lock()
    defer { lock.unlock() }
    guard listening == nil else { return }
    listening = Task.detached(priority: .background) { [weak self] in
      for await result in Transaction.updates {
        self?.relay(VoltzStoreCore.update([VoltzStoreCore.purchase(result)]))
      }
    }
  }

  public func stop() {
    lock.lock()
    defer { lock.unlock() }
    listening?.cancel()
    listening = nil
  }

  // Queues while nobody listens and hands over directly once takeQueued has run. The emitter is
  // called outside the lock, so a slow listener never holds up the store's stream.
  func relay(_ update: [String: Any]) {
    lock.lock()
    let direct = emit
    if direct == nil {
      queued.append(update)
      if queued.count > VoltzStoreCore.queueLimit {
        queued.removeFirst()
      }
    }
    lock.unlock()
    direct?(update)
  }

  // Draining and switching to direct emission happen under one lock, so an update lands either in
  // the drained list or with the emitter, never in both and never in neither.
  public func takeQueued(emitter: @escaping ([String: Any]) -> Void) -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    let drained = queued
    queued = []
    emit = emitter
    return drained
  }

  // A JS reload invalidates the module that held the emitter, and what arrives until the next
  // takeQueued waits in the queue.
  public func detach() {
    lock.lock()
    defer { lock.unlock() }
    emit = nil
  }

  public func loadProducts(
    _ ids: [String],
    resolve: @escaping ([[String: Any]]) -> Void,
    reject: @escaping (String, String) -> Void
  ) {
    Task {
      do {
        // An id the store does not know is left out of the answer, not reported as an error.
        let products = try await Product.products(for: ids)
        resolve(products.map { ["id": $0.id, "displayPrice": $0.displayPrice] })
      } catch {
        reject(VoltzStoreCore.code(of: error), error.localizedDescription)
      }
    }
  }

  public func buy(_ productId: String, reference: String, resolve: @escaping ([String: Any]) -> Void) {
    // The gateway finds the order by this token, and StoreKit takes only a UUID, so anything else is
    // refused before the purchase sheet opens.
    guard let token = UUID(uuidString: reference) else {
      resolve(VoltzStoreCore.failure("invalidReference", "the reference is not a UUID"))
      return
    }
    Task { @MainActor in
      do {
        guard let product = try await Product.products(for: [productId]).first else {
          resolve(VoltzStoreCore.failure("productUnavailable", "the store does not list \(productId)"))
          return
        }
        let options: Set<Product.PurchaseOption> = [.appAccountToken(token)]
        let result: Product.PurchaseResult
        if #available(iOS 17.0, *), let scene = VoltzStoreCore.activeScene() {
          result = try await product.purchase(confirmIn: scene, options: options)
        } else {
          result = try await product.purchase(options: options)
        }
        resolve(VoltzStoreCore.outcome(result))
      } catch {
        resolve(VoltzStoreCore.failure(VoltzStoreCore.code(of: error), error.localizedDescription))
      }
    }
  }

  // Every transaction the app has not finished, read again on each call because Transaction.updates
  // hands each one over only once per launch.
  public func openPurchases(resolve: @escaping ([[String: Any]]) -> Void) {
    Task {
      var open: [[String: Any]] = []
      for await result in Transaction.unfinished {
        open.append(VoltzStoreCore.purchase(result))
      }
      resolve(open)
    }
  }

  // StoreKit finishes a Transaction value, not an id, so the id is looked up among the unfinished
  // ones. Not found means already finished, and answers false.
  public func finish(_ transactionId: String, resolve: @escaping (Bool) -> Void) {
    Task {
      for await result in Transaction.unfinished {
        let transaction = VoltzStoreCore.transaction(of: result)
        if String(transaction.id) == transactionId {
          await transaction.finish()
          resolve(true)
          return
        }
      }
      resolve(false)
    }
  }

  // Apple's refund sheet for one transaction (Transaction.beginRefundRequest(for:in:), iOS 15), on
  // the scene a purchase sheet would use. Apple decides on the refund afterwards, on no deadline it
  // publishes, so the answer only says what became of the sheet: success, userCancelled, or
  // failed with the RefundRequestError case (duplicateRequest, failed), a StoreKitError's case, or
  // the bridge's own refusal before anything is shown.
  public func beginRefundRequest(_ transactionId: String, resolve: @escaping ([String: Any]) -> Void) {
    guard let id = UInt64(transactionId) else {
      resolve(VoltzStoreCore.refund("failed", "invalidTransaction", "the transaction id is not a number"))
      return
    }
    Task { @MainActor in
      guard let scene = VoltzStoreCore.activeScene() else {
        resolve(VoltzStoreCore.refund("failed", "noScene", "no window scene to show the refund sheet on"))
        return
      }
      do {
        switch try await Transaction.beginRefundRequest(for: id, in: scene) {
        case .success:
          resolve(VoltzStoreCore.refund("success", nil, nil))
        case .userCancelled:
          resolve(VoltzStoreCore.refund("userCancelled", nil, nil))
        @unknown default:
          resolve(VoltzStoreCore.refund("failed", "unknown", "an unknown refund request status"))
        }
      } catch let error as Transaction.RefundRequestError {
        resolve(VoltzStoreCore.refund("failed", VoltzStoreCore.refundCode(of: error), error.localizedDescription))
      } catch {
        resolve(VoltzStoreCore.refund("failed", VoltzStoreCore.code(of: error), error.localizedDescription))
      }
    }
  }

  static func refundCode(of error: Transaction.RefundRequestError) -> String {
    switch error {
    case .duplicateRequest:
      return "duplicateRequest"
    case .failed:
      return "failed"
    @unknown default:
      return "unknown"
    }
  }

  static func refund(_ status: String, _ code: String?, _ message: String?) -> [String: Any] {
    ["status": status, "code": code ?? NSNull(), "message": message ?? NSNull()]
  }

  // The app declares no UIApplicationSceneManifest, so UIKit gives it one implicit window scene.
  @MainActor public static func activeScene() -> UIWindowScene? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
  }

  static func transaction(of result: VerificationResult<Transaction>) -> Transaction {
    switch result {
    case .verified(let transaction):
      return transaction
    case .unverified(let transaction, _):
      return transaction
    }
  }

  // An unverified transaction is relayed with verified false: the gateway asks Apple about the id and
  // decides, and the app never finishes on its own verdict.
  public static func purchase(_ result: VerificationResult<Transaction>) -> [String: Any] {
    let transaction = transaction(of: result)
    var verified = false
    if case .verified = result {
      verified = true
    }
    return [
      "productIds": [transaction.productID],
      "key": String(transaction.id),
      "reference": reference(of: transaction) ?? NSNull(),
      // A pending purchase has no transaction yet on Apple, so every transaction is a paid one.
      "state": "purchased",
      "purchasedAt": transaction.purchaseDate.timeIntervalSince1970 * 1000,
      "verified": verified,
      "revoked": transaction.revocationDate != nil,
    ]
  }

  // uuidString is uppercase and the gateway accepts only the lowercase form it issued.
  static func reference(of transaction: Transaction) -> String? {
    transaction.appAccountToken?.uuidString.lowercased()
  }

  static func update(_ purchases: [[String: Any]]) -> [String: Any] {
    ["code": "OK", "subCode": NSNull(), "message": NSNull(), "purchases": purchases]
  }

  static func outcome(_ result: Product.PurchaseResult) -> [String: Any] {
    switch result {
    case .success(let verification):
      return [
        "status": "purchased", "code": NSNull(), "subCode": NSNull(), "message": NSNull(),
        "purchase": purchase(verification),
      ]
    case .pending:
      return ["status": "pending", "code": NSNull(), "subCode": NSNull(), "message": NSNull(), "purchase": NSNull()]
    case .userCancelled:
      return ["status": "cancelled", "code": NSNull(), "subCode": NSNull(), "message": NSNull(), "purchase": NSNull()]
    @unknown default:
      return failure("unknown", "an unknown purchase result")
    }
  }

  static func failure(_ code: String, _ message: String) -> [String: Any] {
    ["status": "failed", "code": code, "subCode": NSNull(), "message": message, "purchase": NSNull()]
  }

  // The case name of a StoreKitError or Product.PurchaseError, which store.ts maps to a stable code.
  // Cases newer than the deployment target are matched behind an availability check.
  public static func code(of error: Error) -> String {
    if let storeKit = error as? StoreKitError {
      switch storeKit {
      case .unknown:
        return "unknown"
      case .userCancelled:
        return "userCancelled"
      case .networkError:
        return "networkError"
      case .systemError:
        return "systemError"
      case .notAvailableInStorefront:
        return "notAvailableInStorefront"
      default:
        break
      }
      if #available(iOS 15.4, *), case .notEntitled = storeKit {
        return "notEntitled"
      }
      if #available(iOS 18.4, *), case .unsupported = storeKit {
        return "unsupported"
      }
      return "unknown"
    }
    if let purchase = error as? Product.PurchaseError {
      switch purchase {
      case .invalidQuantity:
        return "invalidQuantity"
      case .productUnavailable:
        return "productUnavailable"
      case .purchaseNotAllowed:
        return "purchaseNotAllowed"
      case .ineligibleForOffer:
        return "ineligibleForOffer"
      case .invalidOfferIdentifier:
        return "invalidOfferIdentifier"
      case .invalidOfferPrice:
        return "invalidOfferPrice"
      case .invalidOfferSignature:
        return "invalidOfferSignature"
      case .missingOfferParameters:
        return "missingOfferParameters"
      default:
        return "unknown"
      }
    }
    return "unknown"
  }
}
