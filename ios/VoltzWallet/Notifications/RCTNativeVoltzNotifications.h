#import <Foundation/Foundation.h>
#import <VoltzStoreSpec/VoltzStoreSpec.h>

NS_ASSUME_NONNULL_BEGIN

// The notification bridge's TurboModule. The permission request and the APNs registration stay two
// calls, so a refusal never reaches APNs and, through its token, Firebase.
@interface RCTNativeVoltzNotifications : NSObject <NativeVoltzNotificationsSpec>

@end

NS_ASSUME_NONNULL_END
