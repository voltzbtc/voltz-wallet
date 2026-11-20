#import "RCTNativeVoltzPrivacy.h"

// The generated Swift header declares the app delegate's ReactNativeDelegate, whose superclass it
// brings in with @import, which Objective-C++ without C++ modules skips. Importing the superclass
// header first lets this file read the header.
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>

#import "VoltzWallet-Swift.h"

@implementation RCTNativeVoltzPrivacy

+ (NSString *)moduleName
{
  return @"NativeVoltzPrivacy";
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeVoltzPrivacySpecJSI>(params);
}

// Synchronous, on the JS thread; the stamp is behind the cover's own lock. iOS shows the app's own
// activities inside the app, so no trip begins in one.
- (NSDictionary *)takeAway
{
  return @{@"left" : @([VoltzPrivacyCover.shared takeAway]), @"own" : @(VoltzPrivacyCover.noLeave)};
}

- (void)hideCover
{
  [VoltzPrivacyCover.shared hide];
}

// A Modal reads its animationType from the same update that hides it on iOS
// (RCTModalHostViewComponentView), so one the lock closes is dismissed unanimated, under the cover, and
// nothing is left to wait for.
- (void)hideCoverAfterModals
{
  [VoltzPrivacyCover.shared hide];
}

- (void)whenInFront:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [VoltzPrivacyCover.shared whenInFront:^(BOOL inFront) {
    resolve(@(inFront));
  }];
}

// iOS shows the app's pickers and prompts inside the app, without a leave, so there is nothing to
// bracket.
- (void)beginOwnActivity
{
}

- (void)endOwnActivity
{
}

- (void)dismissPresented:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [VoltzPrivacyCover.shared dismissPresented:^{
    resolve(nil);
  }];
}

@end
