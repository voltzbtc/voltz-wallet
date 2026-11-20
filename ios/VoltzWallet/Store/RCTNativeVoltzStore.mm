#import "RCTNativeVoltzStore.h"

#import <React/RCTInvalidating.h>
// The generated Swift header declares the app delegate's ReactNativeDelegate, whose superclass it
// brings in with @import, which Objective-C++ without C++ modules skips. Importing the superclass
// header first lets this file read the header.
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>

#import "VoltzWallet-Swift.h"

@interface RCTNativeVoltzStore () <RCTInvalidating>
@end

@implementation RCTNativeVoltzStore

+ (NSString *)moduleName
{
  return @"NativeVoltzStore";
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeVoltzStoreSpecJSI>(params);
}

- (void)loadProducts:(NSArray *)ids resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [VoltzStoreCore.shared loadProducts:ids
      resolve:^(NSArray<NSDictionary<NSString *, id> *> *products) {
        resolve(products);
      }
      reject:^(NSString *code, NSString *message) {
        reject(code, message, nil);
      }];
}

// The obfuscated account id is Google's; StoreKit carries the order in appAccountToken alone.
- (void)buy:(NSString *)productId
    reference:(NSString *)reference
    accountId:(NSString *_Nullable)accountId
      resolve:(RCTPromiseResolveBlock)resolve
       reject:(RCTPromiseRejectBlock)reject
{
  [VoltzStoreCore.shared buy:productId
                   reference:reference
                     resolve:^(NSDictionary<NSString *, id> *result) {
                       resolve(result);
                     }];
}

- (void)openPurchases:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [VoltzStoreCore.shared openPurchasesWithResolve:^(NSArray<NSDictionary<NSString *, id> *> *open) {
    resolve(open);
  }];
}

- (void)finish:(NSString *)transactionId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [VoltzStoreCore.shared finish:transactionId
                        resolve:^(BOOL finished) {
                          resolve(@(finished));
                        }];
}

- (void)beginRefundRequest:(NSString *)transactionId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  [VoltzStoreCore.shared beginRefundRequest:transactionId
                                    resolve:^(NSDictionary<NSString *, id> *result) {
                                      resolve(result);
                                    }];
}

// The emitter holds the module weakly: after a reload the old module is gone and invalidate has
// already put the core back to queueing.
- (void)takeQueued:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  __weak RCTNativeVoltzStore *weakSelf = self;
  resolve([VoltzStoreCore.shared takeQueuedWithEmitter:^(NSDictionary<NSString *, id> *update) {
    [weakSelf emitOnUpdate:update];
  }]);
}

- (void)invalidate
{
  [VoltzStoreCore.shared detach];
}

@end
