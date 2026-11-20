import UIKit

// The cover over the app while it is away, and the stamp of the leave on the clock that times the
// trip. AppDelegate calls `didEnterBackground` and `didBecomeActive`; RCTNativeVoltzPrivacy is the JS
// side's way in, and src/wallet/relock.ts its one reader.
//
// The stamp is taken here because a JS 'background' handler runs only on the return when iOS suspends
// the process first, which reads a long trip as none. The cover is shown here because UIKit takes the
// switcher snapshot once applicationDidEnterBackground returns and shows it again on the return, before
// any JS runs. It is a window of its own above `.alert`, as in MetaMask mobile's PrivacyCover (PR
// 37256), so it sits over React Native Modals and anything UIKit presented, and it stays up until the
// JS side has decided, so the first frame back is never the wallet and a touch never reaches it.
// `inactive` alone (the app switcher, Control Center, the Face ID prompt) raises nothing.
@objc(VoltzPrivacyCover)
final class VoltzPrivacyCover: NSObject {
  @objc static let shared = VoltzPrivacyCover()

  // A cover that comes and goes within a few frames reads as a flicker, so it stays up at least this
  // long; one already up longer comes down at once.
  private static let minShownNs: UInt64 = 250_000_000

  // The mark is drawn at the size and corner radius the app draws its logo with (App.tsx, radius.xl).
  private static let markSide: CGFloat = 88
  private static let markRadius: CGFloat = 20

  // The codes takeAway answers with, as specs/NativeVoltzPrivacy.ts documents them. iOS has no leave
  // of the app's own: its pickers and prompts show inside the app, so the own trip is always -1.
  @objc static let noLeave: Double = -1
  private static let clockFailed: Double = -2

  // Written on the main thread and read from the JS thread, so behind this lock.
  private let stampLock = NSLock()
  private var leftAt: UInt64?

  // Main thread only.
  private weak var host: UIWindow?
  private var cover: UIWindow?
  private var shownAt: UInt64 = 0
  private var away = false
  private var leaves = 0

  private override init() {
    super.init()
  }

  // CLOCK_MONOTONIC_RAW keeps counting while the device sleeps and nothing can set it, per
  // clock_gettime(3). CLOCK_UPTIME_RAW, behind mach_absolute_time and the C++ steady clock, stops in
  // sleep, and CLOCK_REALTIME is the wall clock Settings can set back. Zero is a failed read.
  private static func now() -> UInt64 {
    clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)
  }

  @objc func install(host window: UIWindow?) {
    host = window
  }

  @objc func didEnterBackground() {
    stampLock.lock()
    // The first leave since the last take keeps its stamp, so the clock never restarts while away.
    if leftAt == nil {
      leftAt = Self.now()
    }
    stampLock.unlock()
    away = true
    leaves += 1
    show()
  }

  // Before React Native posts 'active', so the hide the JS side sends after it is not taken for one
  // left over from an earlier return.
  @objc func didBecomeActive() {
    away = false
  }

  @objc func takeAway() -> Double {
    stampLock.lock()
    let left = leftAt
    leftAt = nil
    stampLock.unlock()
    guard let left else {
      return Self.noLeave
    }
    let back = Self.now()
    // A clock that reads zero or runs backwards cannot time the trip, so it counts as long enough.
    if left == 0 || back == 0 || back < left {
      return Self.clockFailed
    }
    return Double(back - left) / 1_000_000
  }

  @objc func whenInFront(_ done: @escaping (Bool) -> Void) {
    DispatchQueue.main.async {
      done(!self.away)
    }
  }

  // A hide that finds the app away again belongs to a return that is over, and one held for the floor
  // is dropped if a leave came meanwhile, so neither uncovers the next trip's snapshot.
  @objc func hide() {
    DispatchQueue.main.async {
      guard !self.away else {
        return
      }
      let shown = Self.now() &- self.shownAt
      if self.shownAt == 0 || shown >= Self.minShownNs {
        self.cover?.isHidden = true
        return
      }
      let leave = self.leaves
      DispatchQueue.main.asyncAfter(deadline: .now() + .nanoseconds(Int(Self.minShownNs - shown))) {
        guard !self.away, self.leaves == leave else {
          return
        }
        self.cover?.isHidden = true
      }
    }
  }

  // Dismisses what UIKit presented that is not a React Native Modal: the share sheet, ActionSheetIOS,
  // the photo picker. Those sit above the app's whole view and would stay over the lock. A Modal is
  // left to React, which dismisses its own controller, and whose controller would otherwise dismiss
  // what it presented instead of itself and leave React out of step. Calls `done` once they are gone.
  @objc func dismissPresented(_ done: @escaping () -> Void) {
    DispatchQueue.main.async {
      guard var presenter = self.host?.rootViewController else {
        done()
        return
      }
      while let next = presenter.presentedViewController {
        if !String(describing: type(of: next)).contains("ModalHostViewController") {
          presenter.dismiss(animated: false, completion: done)
          return
        }
        presenter = next
      }
      done()
    }
  }

  private func show() {
    shownAt = Self.now()
    // The keyboard is a window above every app window and would come back over the cover on the
    // return, with what was being typed.
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    guard let scene = cover?.windowScene ?? host?.windowScene else {
      return
    }
    let window = cover ?? makeCover(for: scene)
    window.frame = scene.coordinateSpace.bounds
    window.isHidden = false
  }

  // The app's background with the Voltz mark in its middle, as on Android. VoiceOver finds the mark and
  // nothing under it.
  private func makeCover(for scene: UIWindowScene) -> UIWindow {
    let window = UIWindow(windowScene: scene)
    window.windowLevel = .alert + 1
    window.accessibilityViewIsModal = true
    let root = UIViewController()
    // colors.background in src/theme.ts.
    root.view.backgroundColor = .black
    root.view.accessibilityViewIsModal = true

    let mark = UIImageView(image: UIImage(named: "VoltzCoverMark"))
    mark.translatesAutoresizingMaskIntoConstraints = false
    mark.contentMode = .scaleAspectFill
    mark.layer.cornerRadius = Self.markRadius
    mark.layer.cornerCurve = .continuous
    mark.clipsToBounds = true
    mark.isAccessibilityElement = true
    mark.accessibilityLabel = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
    root.view.addSubview(mark)
    NSLayoutConstraint.activate([
      mark.centerXAnchor.constraint(equalTo: root.view.centerXAnchor),
      mark.centerYAnchor.constraint(equalTo: root.view.centerYAnchor),
      mark.widthAnchor.constraint(equalToConstant: Self.markSide),
      mark.heightAnchor.constraint(equalToConstant: Self.markSide),
    ])

    window.rootViewController = root
    cover = window
    return window
  }
}
