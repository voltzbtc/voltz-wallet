import StoreKit
import StoreKitTest
import XCTest

// VoltzStoreCore against StoreKit's local test environment, with the products of VoltzStore.storekit.
// The test target compiles the core's own source, so each case drives the code the app ships.
// Delivery is never exercised here: the gateway refuses the Xcode environment.
final class VoltzStoreCoreTests: XCTestCase {
  private var session: SKTestSession!
  private var core: VoltzStoreCore!

  // In capitals, because the gateway accepts only the lowercase form it issued and the core must
  // turn one into the other.
  private let reference = "6F9619FF-8B86-D011-B42D-00C04FC964FF"
  private let products = ["name_long", "name_standard", "name_five", "name_four", "name_short", "domain_year"]

  override func setUpWithError() throws {
    let url = try XCTUnwrap(Bundle(for: VoltzStoreCoreTests.self).url(forResource: "VoltzStore", withExtension: "storekit"))
    session = try SKTestSession(contentsOf: url)
    session.resetToDefaultState()
    session.disableDialogs = true
    session.clearTransactions()
    core = VoltzStoreCore()
  }

  override func tearDown() {
    core.stop()
    session.clearTransactions()
    super.tearDown()
  }

  // Helpers

  // Apple's iOS 26.5 simulator runtime refuses SKTestSession's configuration outside an Xcode debug
  // session (FB22237318, developer.apple.com/forums/thread/826971). Every session call then logs
  // SKInternalErrorDomain Code=3 and StoreKit lists no product. Only that runtime is skipped. On any
  // other, a store that lists none of the configured products fails the test, since every case below
  // would otherwise pass or fail against an empty store.
  private func requireStoreKitTesting() async throws {
    let listed = (try? await Product.products(for: ["name_long"])) ?? []
    guard listed.isEmpty else { return }
    let os = ProcessInfo.processInfo.operatingSystemVersion
    if os.majorVersion == 26, os.minorVersion == 5 {
      throw XCTSkip("StoreKit testing does not load on the iOS 26.5 simulator runtime (FB22237318)")
    }
    throw StoreFailure(code: "noProducts", message: "StoreKit lists none of the products in VoltzStore.storekit")
  }

  private func buy(_ productId: String, _ reference: String) async -> [String: Any] {
    await withCheckedContinuation { done in
      core.buy(productId, reference: reference) { done.resume(returning: $0) }
    }
  }

  private func open() async -> [[String: Any]] {
    await withCheckedContinuation { done in
      core.openPurchases { done.resume(returning: $0) }
    }
  }

  private func finish(_ key: String) async -> Bool {
    await withCheckedContinuation { done in
      core.finish(key) { done.resume(returning: $0) }
    }
  }

  private func load(_ ids: [String]) async -> Result<[[String: Any]], StoreFailure> {
    await withCheckedContinuation { done in
      core.loadProducts(ids, resolve: { done.resume(returning: .success($0)) }, reject: { code, message in
        done.resume(returning: .failure(StoreFailure(code: code, message: message)))
      })
    }
  }

  private struct StoreFailure: Error {
    let code: String
    let message: String
  }

  private func purchase(of result: [String: Any]) throws -> [String: Any] {
    try XCTUnwrap(result["purchase"] as? [String: Any], "no purchase in \(result)")
  }

  private func keys(_ purchases: [[String: Any]]) -> [String] {
    purchases.compactMap { $0["key"] as? String }
  }

  // Waits for the first relayed update whose purchase satisfies `match`, collecting every update in
  // `seen`, whether it was queued before the wait or emitted during it.
  private func waitForUpdate(
    timeout: TimeInterval,
    seen: UpdateLog,
    match: @escaping ([String: Any]) -> Bool
  ) async -> XCTWaiter.Result {
    let arrived = expectation(description: "an update")
    arrived.assertForOverFulfill = false
    let check: ([String: Any]) -> Void = { update in
      seen.append(update)
      let purchases = update["purchases"] as? [[String: Any]] ?? []
      if purchases.contains(where: match) {
        arrived.fulfill()
      }
    }
    core.takeQueued(emitter: check).forEach(check)
    return await XCTWaiter().fulfillment(of: [arrived], timeout: timeout)
  }

  private final class UpdateLog {
    private let lock = NSLock()
    private var items: [[String: Any]] = []
    func append(_ item: [String: Any]) {
      lock.lock()
      items.append(item)
      lock.unlock()
    }
    var all: [[String: Any]] {
      lock.lock()
      defer { lock.unlock() }
      return items
    }
  }

  private func update(_ key: String) -> [String: Any] {
    ["code": "OK", "subCode": NSNull(), "message": NSNull(), "purchases": [["key": key]]]
  }

  // Products

  func testLoadsTheSixConsumablesAndLeavesAnUnknownIdOut() async throws {
    try await requireStoreKitTesting()
    let result = await load(products + ["no_such_product"])
    let found = try result.get()
    XCTAssertEqual(Set(found.compactMap { $0["id"] as? String }), Set(products))
    for product in found {
      let price = try XCTUnwrap(product["displayPrice"] as? String)
      XCTAssertFalse(price.isEmpty)
    }
    let long = try XCTUnwrap(found.first { $0["id"] as? String == "name_long" })
    XCTAssertTrue((long["displayPrice"] as? String ?? "").contains("4.99"))
  }

  func testALoadFailureRejectsWithTheStoreKitCaseName() async throws {
    try await requireStoreKitTesting()
    guard #available(iOS 17.0, *) else { throw XCTSkip("setSimulatedError needs iOS 17") }
    try await session.setSimulatedError(.generic(.networkError(URLError(.notConnectedToInternet))), forAPI: .loadProducts)
    let result = await load(products)
    guard case .failure(let failure) = result else {
      return XCTFail("loaded despite the simulated error: \(result)")
    }
    XCTAssertEqual(failure.code, "networkError")
  }

  // Purchase

  func testAPurchaseCarriesTheReferenceInLowercaseAndStaysUnfinished() async throws {
    try await requireStoreKitTesting()
    let result = await buy("name_standard", reference)
    XCTAssertEqual(result["status"] as? String, "purchased")
    let bought = try purchase(of: result)
    XCTAssertEqual(bought["reference"] as? String, reference.lowercased())
    XCTAssertEqual(bought["productIds"] as? [String], ["name_standard"])
    XCTAssertEqual(bought["state"] as? String, "purchased")
    XCTAssertEqual(bought["verified"] as? Bool, true)
    XCTAssertEqual(bought["revoked"] as? Bool, false)
    let key = try XCTUnwrap(bought["key"] as? String)
    // Nothing finishes on its own: the transaction is still open for the gateway's verdict.
    let stillOpen = await open()
    XCTAssertEqual(keys(stillOpen), [key])
  }

  // Stands for an app killed after paying: a core that never saw the purchase reads it from
  // Transaction.unfinished.
  func testACoreStartedAfterThePurchaseRecoversItFromTheUnfinishedList() async throws {
    try await requireStoreKitTesting()
    let bought = try purchase(of: await buy("domain_year", reference))
    let key = try XCTUnwrap(bought["key"] as? String)
    let fresh = VoltzStoreCore()
    let recovered = await withCheckedContinuation { done in
      fresh.openPurchases { done.resume(returning: $0) }
    }
    let found = try XCTUnwrap(recovered.first { $0["key"] as? String == key })
    XCTAssertEqual(found["reference"] as? String, reference.lowercased())
    XCTAssertEqual(found["productIds"] as? [String], ["domain_year"])
  }

  func testFinishTakesOnlyTheTransactionWithThatId() async throws {
    try await requireStoreKitTesting()
    let long = await buy("name_long", reference)
    let four = await buy("name_four", reference)
    let first = try XCTUnwrap(try purchase(of: long)["key"] as? String)
    let second = try XCTUnwrap(try purchase(of: four)["key"] as? String)
    let before = await open()
    XCTAssertEqual(Set(keys(before)), [first, second])
    let finished = await finish(first)
    XCTAssertTrue(finished)
    let after = await open()
    XCTAssertEqual(keys(after), [second])
    // A repeated finish finds nothing, which is what makes repeating it harmless.
    let again = await finish(first)
    XCTAssertFalse(again)
    let unknown = await finish("0")
    XCTAssertFalse(unknown)
    let last = await open()
    XCTAssertEqual(keys(last), [second])
  }

  func testAReferenceThatIsNotAUUIDIsRefusedBeforeTheStoreOpens() async throws {
    let result = await buy("name_standard", "not-a-uuid")
    XCTAssertEqual(result["status"] as? String, "failed")
    XCTAssertEqual(result["code"] as? String, "invalidReference")
    XCTAssertTrue(session.allTransactions().isEmpty)
  }

  func testAProductTheStoreDoesNotListFailsAsUnavailable() async throws {
    try await requireStoreKitTesting()
    let result = await buy("no_such_product", reference)
    XCTAssertEqual(result["status"] as? String, "failed")
    XCTAssertEqual(result["code"] as? String, "productUnavailable")
  }

  func testACancelledPurchaseFinishesNothing() async throws {
    try await requireStoreKitTesting()
    guard #available(iOS 17.0, *) else { throw XCTSkip("setSimulatedError needs iOS 17") }
    try await session.setSimulatedError(.generic(.userCancelled), forAPI: .purchase)
    let result = await buy("name_standard", reference)
    XCTAssertEqual(result["status"] as? String, "failed")
    XCTAssertEqual(result["code"] as? String, "userCancelled")
    XCTAssertTrue(session.allTransactions().isEmpty)
    let stillOpen = await open()
    XCTAssertTrue(stillOpen.isEmpty)
  }

  func testANetworkFailureMidPurchaseFinishesNothing() async throws {
    try await requireStoreKitTesting()
    guard #available(iOS 17.0, *) else { throw XCTSkip("setSimulatedError needs iOS 17") }
    try await session.setSimulatedError(.generic(.networkError(URLError(.networkConnectionLost))), forAPI: .purchase)
    let result = await buy("name_five", reference)
    XCTAssertEqual(result["status"] as? String, "failed")
    XCTAssertEqual(result["code"] as? String, "networkError")
    let stillOpen = await open()
    XCTAssertTrue(stillOpen.isEmpty)
  }

  func testAPurchaseErrorKeepsItsCaseName() async throws {
    try await requireStoreKitTesting()
    guard #available(iOS 17.0, *) else { throw XCTSkip("setSimulatedError needs iOS 17") }
    try await session.setSimulatedError(.purchase(.purchaseNotAllowed), forAPI: .purchase)
    let result = await buy("name_short", reference)
    XCTAssertEqual(result["code"] as? String, "purchaseNotAllowed")
  }

  // The gateway decides about an unverified transaction by asking Apple, so it is relayed, not dropped.
  func testAnUnverifiedPurchaseIsRelayedAsUnverified() async throws {
    try await requireStoreKitTesting()
    guard #available(iOS 17.0, *) else { throw XCTSkip("setSimulatedError needs iOS 17") }
    try await session.setSimulatedError(.verification(.invalidSignature), forAPI: .verification)
    let result = await buy("name_standard", reference)
    XCTAssertEqual(result["status"] as? String, "purchased")
    XCTAssertEqual(try purchase(of: result)["verified"] as? Bool, false)
  }

  // The app declares no scene manifest, so iOS 17 and later take purchase(confirmIn:) only when UIKit
  // still hands it an implicit window scene.
  func testTheHostAppHasAWindowSceneToConfirmIn() async {
    let scene = await MainActor.run { VoltzStoreCore.activeScene() }
    XCTAssertNotNil(scene)
  }

  // Codegen maps the module name to the adapter class, and React Native creates the module by that
  // class name at run time, so a class that is missing or answers another name leaves the store
  // unavailable with no build error.
  func testTheBuiltAppRegistersTheStoreModuleUnderTheSpecName() throws {
    let registry: AnyClass = try XCTUnwrap(NSClassFromString("RCTModuleProviders"))
    let providers = try XCTUnwrap(
      (registry as AnyObject).perform(NSSelectorFromString("moduleProviders"))?.takeUnretainedValue() as? NSDictionary
    )
    let adapter = try XCTUnwrap(providers["NativeVoltzStore"] as? NSObject)
    let adapterClass: AnyClass = type(of: adapter)
    XCTAssertEqual(NSStringFromClass(adapterClass), "RCTNativeVoltzStore")
    let name = (adapterClass as AnyObject).perform(NSSelectorFromString("moduleName"))?.takeUnretainedValue() as? String
    XCTAssertEqual(name, "NativeVoltzStore")
    let methods = [
      "loadProducts:resolve:reject:", "buy:reference:accountId:resolve:reject:", "openPurchases:reject:",
      "finish:resolve:reject:", "takeQueued:reject:", "invalidate",
    ]
    for method in methods {
      XCTAssertTrue(adapter.responds(to: NSSelectorFromString(method)), method)
    }
  }

  // Ask to Buy and other late outcomes

  func testAskToBuyPendsAndTheApprovalArrivesThroughUpdates() async throws {
    try await requireStoreKitTesting()
    session.askToBuyEnabled = true
    core.start()
    let result = await buy("name_standard", reference)
    XCTAssertEqual(result["status"] as? String, "pending")
    let beforeApproval = await open()
    XCTAssertTrue(beforeApproval.isEmpty)
    let asked = try XCTUnwrap(session.allTransactions().first { $0.pendingAskToBuyConfirmation })
    try session.approveAskToBuyTransaction(identifier: asked.identifier)
    let seen = UpdateLog()
    let isApproved: ([String: Any]) -> Bool = { $0["productIds"] as? [String] == ["name_standard"] }
    let waited = await waitForUpdate(timeout: 20, seen: seen, match: isApproved)
    XCTAssertEqual(waited, .completed, "no update for the approved purchase; saw \(seen.all)")
    let approved = try XCTUnwrap(seen.all.flatMap { $0["purchases"] as? [[String: Any]] ?? [] }.first(where: isApproved))
    XCTAssertEqual(approved["reference"] as? String, reference.lowercased())
    let afterApproval = await open()
    XCTAssertEqual(keys(afterApproval), [try XCTUnwrap(approved["key"] as? String)])
  }

  // Apple does not tell the app about a declined request. Whatever arrives is printed for the record,
  // and nothing may be left open to confirm.
  func testAskToBuyDeclinedLeavesNothingOpen() async throws {
    try await requireStoreKitTesting()
    session.askToBuyEnabled = true
    core.start()
    let result = await buy("name_standard", reference)
    XCTAssertEqual(result["status"] as? String, "pending")
    let asked = try XCTUnwrap(session.allTransactions().first { $0.pendingAskToBuyConfirmation })
    try session.declineAskToBuyTransaction(identifier: asked.identifier)
    let seen = UpdateLog()
    _ = await waitForUpdate(timeout: 8, seen: seen) { _ in true }
    print("VOLTZ-STORE-RECORD declined Ask to Buy relayed \(seen.all.count) update(s): \(seen.all)")
    let stillOpen = await open()
    XCTAssertTrue(stillOpen.isEmpty)
  }

  // A purchase interrupted by a required action (terms, payment details) resolves later and arrives
  // through Transaction.updates, not as the answer to the purchase.
  func testAnInterruptedPurchaseArrivesThroughUpdatesOnceResolved() async throws {
    try await requireStoreKitTesting()
    session.interruptedPurchasesEnabled = true
    core.start()
    let result = await buy("name_four", reference)
    print("VOLTZ-STORE-RECORD interrupted purchase answered \(result)")
    XCTAssertNotEqual(result["status"] as? String, "purchased")
    let interrupted = try XCTUnwrap(session.allTransactions().first { $0.productIdentifier == "name_four" })
    try session.resolveIssueForTransaction(identifier: interrupted.identifier)
    let seen = UpdateLog()
    let waited = await waitForUpdate(timeout: 20, seen: seen) { $0["productIds"] as? [String] == ["name_four"] }
    print("VOLTZ-STORE-RECORD interrupted purchase relayed \(seen.all)")
    XCTAssertEqual(waited, .completed)
    let stillOpen = await open()
    XCTAssertEqual(stillOpen.count, 1)
  }

  // Checks that an unfinished consumable does not block buying it again, and records the answer local
  // StoreKit testing gives; the sandbox answer can differ.
  func testBuyingAProductStillUnfinishedAgain() async throws {
    try await requireStoreKitTesting()
    let initial = await buy("name_standard", reference)
    let first = try XCTUnwrap(try purchase(of: initial)["key"] as? String)
    let second = await buy("name_standard", reference)
    print("VOLTZ-STORE-RECORD second purchase of an unfinished consumable answered \(second)")
    XCTAssertEqual(second["status"] as? String, "purchased")
    let secondKey = try XCTUnwrap(try purchase(of: second)["key"] as? String)
    XCTAssertNotEqual(secondKey, first)
    let stillOpen = await open()
    XCTAssertEqual(Set(keys(stillOpen)), [first, secondKey])
  }

  func testARefundedUnfinishedPurchaseIsRelayedAsRevoked() async throws {
    try await requireStoreKitTesting()
    let bought = try purchase(of: await buy("name_five", reference))
    let key = try XCTUnwrap(bought["key"] as? String)
    try session.refundTransaction(identifier: try XCTUnwrap(UInt(key)))
    let found = await open().first { $0["key"] as? String == key }
    print("VOLTZ-STORE-RECORD refunded unfinished purchase reads \(String(describing: found))")
    XCTAssertEqual(try XCTUnwrap(found)["revoked"] as? Bool, true)
  }

  // The queue

  func testUpdatesWaitUntilDrainedAndThenGoStraightToTheEmitter() {
    core.relay(update("1"))
    core.relay(update("2"))
    var emitted: [String] = []
    let drained = core.takeQueued { update in
      emitted.append(((update["purchases"] as? [[String: Any]])?.first?["key"] as? String) ?? "")
    }
    XCTAssertEqual(drained.compactMap { ($0["purchases"] as? [[String: Any]])?.first?["key"] as? String }, ["1", "2"])
    core.relay(update("3"))
    XCTAssertEqual(emitted, ["3"])
    // A second drain is empty, so nothing reaches the JS side twice.
    XCTAssertTrue(core.takeQueued { _ in }.isEmpty)
  }

  func testADetachedCoreQueuesAgain() {
    var emitted = 0
    _ = core.takeQueued { _ in emitted += 1 }
    core.detach()
    core.relay(update("4"))
    XCTAssertEqual(emitted, 0)
    let drained = core.takeQueued { _ in }
    XCTAssertEqual(drained.count, 1)
  }

  func testTheQueueKeepsTheNewestHundred() {
    for index in 0...VoltzStoreCore.queueLimit {
      core.relay(update(String(index)))
    }
    let drained = core.takeQueued { _ in }
    XCTAssertEqual(drained.count, VoltzStoreCore.queueLimit)
    XCTAssertEqual((drained.first?["purchases"] as? [[String: Any]])?.first?["key"] as? String, "1")
    XCTAssertEqual((drained.last?["purchases"] as? [[String: Any]])?.first?["key"] as? String, String(VoltzStoreCore.queueLimit))
  }

  func testStoreKitErrorsMapToTheirCaseNames() {
    XCTAssertEqual(VoltzStoreCore.code(of: StoreKitError.userCancelled), "userCancelled")
    XCTAssertEqual(VoltzStoreCore.code(of: StoreKitError.networkError(URLError(.timedOut))), "networkError")
    XCTAssertEqual(VoltzStoreCore.code(of: StoreKitError.notAvailableInStorefront), "notAvailableInStorefront")
    XCTAssertEqual(VoltzStoreCore.code(of: StoreKitError.systemError(URLError(.unknown))), "systemError")
    XCTAssertEqual(VoltzStoreCore.code(of: Product.PurchaseError.productUnavailable), "productUnavailable")
    XCTAssertEqual(VoltzStoreCore.code(of: Product.PurchaseError.purchaseNotAllowed), "purchaseNotAllowed")
    XCTAssertEqual(VoltzStoreCore.code(of: URLError(.badURL)), "unknown")
    if #available(iOS 18.4, *) {
      XCTAssertEqual(VoltzStoreCore.code(of: StoreKitError.unsupported), "unsupported")
    }
  }
}
