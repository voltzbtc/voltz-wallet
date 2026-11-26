#import "RCTNativeVoltzReview.h"

// The generated Swift header declares the app delegate's ReactNativeDelegate, whose superclass it
// brings in with @import, which Objective-C++ without C++ modules skips. Importing the superclass
// header first lets this file read the header.
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>

#import "VoltzWallet-Swift.h"

@implementation RCTNativeVoltzReview

+ (NSString *)moduleName
{
  return @"NativeVoltzReview";
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeVoltzReviewSpecJSI>(params);
}

- (void)request:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [VoltzReviewCore requestWithResolve:^{
        resolve(nil);
      }
      reject:^(NSString *code, NSString *message) {
        reject(code, message, nil);
      }];
}

@end
