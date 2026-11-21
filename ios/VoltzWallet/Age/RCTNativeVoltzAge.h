#import <Foundation/Foundation.h>
#import <VoltzStoreSpec/VoltzStoreSpec.h>

NS_ASSUME_NONNULL_BEGIN

// The age signal's TurboModule. It only adapts the codegen spec to VoltzAgeCore, whose Swift links
// DeclaredAgeRange on its own; an Objective-C++ import would not.
@interface RCTNativeVoltzAge : NSObject <NativeVoltzAgeSpec>

@end

NS_ASSUME_NONNULL_END
