#import <Foundation/Foundation.h>
#import <VoltzStoreSpec/VoltzStoreSpec.h>

NS_ASSUME_NONNULL_BEGIN

// The still image QR reader's TurboModule. It only adapts the codegen spec to VoltzQrImageCore, whose
// Swift links Vision on its own; an Objective-C++ import would not.
@interface RCTNativeVoltzQrImage : NSObject <NativeVoltzQrImageSpec>

@end

NS_ASSUME_NONNULL_END
