#import <Foundation/Foundation.h>
#import <VoltzStoreSpec/VoltzStoreSpec.h>

NS_ASSUME_NONNULL_BEGIN

// The review prompt's TurboModule. It only adapts the codegen spec to VoltzReviewCore, whose Swift
// reaches StoreKit's AppStore type, which Objective-C cannot.
@interface RCTNativeVoltzReview : NSObject <NativeVoltzReviewSpec>

@end

NS_ASSUME_NONNULL_END
