#import <Foundation/Foundation.h>
#import <VoltzStoreSpec/VoltzStoreSpec.h>

NS_ASSUME_NONNULL_BEGIN

// The JS side's way to VoltzPrivacyCover; src/wallet/relock.ts is the one reader.
@interface RCTNativeVoltzPrivacy : NSObject <NativeVoltzPrivacySpec>

@end

NS_ASSUME_NONNULL_END
