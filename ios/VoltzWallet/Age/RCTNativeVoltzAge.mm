#import "RCTNativeVoltzAge.h"

// The generated Swift header declares the app delegate's ReactNativeDelegate, whose superclass it
// brings in with @import, which Objective-C++ without C++ modules skips. Importing the superclass
// header first lets this file read the header.
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>

#import "VoltzWallet-Swift.h"

@implementation RCTNativeVoltzAge

+ (NSString *)moduleName
{
  return @"NativeVoltzAge";
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeVoltzAgeSpecJSI>(params);
}

- (void)regulated:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [VoltzAgeCore regulatedWithResolve:^(BOOL regulated) {
        resolve(@(regulated));
      }
      reject:^(NSString *code, NSString *message) {
        reject(code, message, nil);
      }];
}

- (void)request:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [VoltzAgeCore requestWithResolve:^(NSDictionary<NSString *, id> *answer) {
        resolve(answer);
      }
      reject:^(NSString *code, NSString *message) {
        reject(code, message, nil);
      }];
}

@end
