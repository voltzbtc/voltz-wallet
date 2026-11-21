import Foundation
import UIKit
#if canImport(DeclaredAgeRange)
import DeclaredAgeRange
#endif

// Relays Apple's Declared Age Range and decides nothing: src/wallet/ageSignal.ts reads the range.
// isEligibleForAgeFeatures (iOS 26.2) says whether the person is in a region whose law has the app ask;
// below it the answer is false and nothing is asked. requestAgeRange asks with one gate, 18, and may
// show the system's sharing sheet. The framework is weak linked (OTHER_LDFLAGS), so the app still
// launches below iOS 26. Nothing is logged or kept here.
@objcMembers public final class VoltzAgeCore: NSObject {

  public static func regulated(
    resolve: @escaping (Bool) -> Void,
    reject: @escaping (String, String) -> Void
  ) {
    #if canImport(DeclaredAgeRange)
    if #available(iOS 26.2, *) {
      Task {
        do {
          resolve(try await AgeRangeService.shared.isEligibleForAgeFeatures)
        } catch {
          reject("unavailable", "the age range service did not answer")
        }
      }
      return
    }
    #endif
    resolve(false)
  }

  public static func request(
    resolve: @escaping ([String: Any]) -> Void,
    reject: @escaping (String, String) -> Void
  ) {
    #if canImport(DeclaredAgeRange)
    if #available(iOS 26.0, *) {
      Task { @MainActor in
        guard let controller = presenter() else {
          reject("noController", "no view controller to ask over")
          return
        }
        do {
          switch try await AgeRangeService.shared.requestAgeRange(ageGates: 18, in: controller) {
          case .sharing(let range):
            resolve(answer("shared", range.lowerBound, range.upperBound))
          case .declinedSharing:
            resolve(answer("notShared", nil, nil))
          @unknown default:
            resolve(answer("unspecified", nil, nil))
          }
        } catch {
          // Newer systems add error cases (iOS 27 adds three), and the reader treats every one alike.
          reject("unavailable", "the age range service did not answer")
        }
      }
      return
    }
    #endif
    resolve(answer("unspecified", nil, nil))
  }

  // A bound Apple leaves open, or does not give, is -1.
  static func answer(_ status: String, _ lower: Int?, _ upper: Int?) -> [String: Any] {
    ["status": status, "lower": lower ?? -1, "upper": upper ?? -1]
  }

  // The topmost controller React Native presents from. The app delegate's window holds React's root,
  // and the privacy cover's window, which sits above it, is never the one to present over.
  @MainActor static func presenter() -> UIViewController? {
    guard let root = UIApplication.shared.delegate?.window??.rootViewController else {
      return nil
    }
    var top = root
    while let next = top.presentedViewController, !next.isBeingDismissed {
      top = next
    }
    return top
  }
}
