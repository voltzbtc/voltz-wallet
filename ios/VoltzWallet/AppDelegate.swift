import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import FirebaseCore

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Before the React tree, because the JS side asks for a token as soon as a screen mounts and a
    // request that arrives before configure() throws inside the SDK. Reads GoogleService-Info.plist
    // from the bundle, and raises when that file is missing.
    FirebaseApp.configure()

    // Before the React tree as well. Apple delivers the transactions left unfinished to the
    // Transaction.updates listener right after launch, and the store module is created much later,
    // so the core listens from here and queues until the JS side drains it.
    VoltzStoreCore.shared.start()

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)
    VoltzPrivacyCover.shared.install(host: window)

    factory.startReactNative(
      withModuleName: "VoltzWallet",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }

  // Stamps the leave and raises the cover before UIKit takes the switcher snapshot it writes to disk
  // and shows again on the return. The cover waits for didEnterBackground rather than resigning
  // active, which the Face ID prompt and Control Center also do without leaving the app, and stays
  // until the JS side has decided whether to ask the PIN (src/hooks/useRelock.ts).
  func applicationDidEnterBackground(_ application: UIApplication) {
    VoltzPrivacyCover.shared.didEnterBackground()
  }

  func applicationDidBecomeActive(_ application: UIApplication) {
    VoltzPrivacyCover.shared.didBecomeActive()
  }

  // Forward inbound URLs (a nostr client opening a `lightning:` zap invoice) to React Native's Linking
  // module, so JS's Linking.getInitialURL()/'url' event fire and the app routes to Send.
  func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return RCTLinkingManager.application(app, open: url, options: options)
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
