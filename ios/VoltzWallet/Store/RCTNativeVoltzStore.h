#import <Foundation/Foundation.h>
#import <VoltzStoreSpec/VoltzStoreSpec.h>

NS_ASSUME_NONNULL_BEGIN

// The store bridge's TurboModule. It only adapts the codegen spec to VoltzStoreCore, where the
// StoreKit work lives, and inherits the event emitter from the generated base.
@interface RCTNativeVoltzStore : NativeVoltzStoreSpecBase <NativeVoltzStoreSpec>

@end

NS_ASSUME_NONNULL_END
