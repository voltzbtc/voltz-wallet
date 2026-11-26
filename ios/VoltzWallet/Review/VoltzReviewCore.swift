import Foundation
import StoreKit
import UIKit

// Relays StoreKit's review request and decides nothing: src/wallet/storeReview.ts decides when to ask.
// The system shows the prompt at most three times in 365 days, in a development build always and in
// TestFlight never, and says nothing about whether it showed. AppStore.requestReview(in:) from iOS 16,
// SKStoreReviewController.requestReview(in:) below it (deprecated from iOS 18). Nothing is logged or
// kept here.
@objcMembers public final class VoltzReviewCore: NSObject {

  public static func request(
    resolve: @escaping () -> Void,
    reject: @escaping (String, String) -> Void
  ) {
    Task { @MainActor in
      guard let scene = foregroundScene() else {
        reject("noScene", "no foreground scene to ask over")
        return
      }
      if #available(iOS 16.0, *) {
        AppStore.requestReview(in: scene)
      } else {
        SKStoreReviewController.requestReview(in: scene)
      }
      resolve()
    }
  }

  // The window scene in front, which the request needs; one in the background shows nothing.
  @MainActor static func foregroundScene() -> UIWindowScene? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .first { $0.activationState == .foregroundActive }
  }
}
