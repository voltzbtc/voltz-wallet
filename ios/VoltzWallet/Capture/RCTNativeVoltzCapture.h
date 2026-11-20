#import <Foundation/Foundation.h>
#import <VoltzStoreSpec/VoltzStoreSpec.h>

NS_ASSUME_NONNULL_BEGIN

// The capture bridge's TurboModule. iOS has no way to stop a screenshot or a recording, so this only
// relays UIKit's signals; src/wallet/screenCapture.ts is the one reader.
@interface RCTNativeVoltzCapture : NativeVoltzCaptureSpecBase <NativeVoltzCaptureSpec>

@end

NS_ASSUME_NONNULL_END
