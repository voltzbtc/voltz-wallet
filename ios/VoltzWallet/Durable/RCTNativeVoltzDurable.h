#import <Foundation/Foundation.h>
#import <VoltzStoreSpec/VoltzStoreSpec.h>

NS_ASSUME_NONNULL_BEGIN

// fsync and rename(2) for src/wallet/durableFile.ts, which react-native-fs does not offer.
@interface RCTNativeVoltzDurable : NSObject <NativeVoltzDurableSpec>

@end

NS_ASSUME_NONNULL_END
