#import "RCTNativeVoltzNotifications.h"

#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>

static NSString *VoltzAuthorizationStatusName(UNAuthorizationStatus status)
{
  switch (status) {
    case UNAuthorizationStatusNotDetermined:
      return @"notDetermined";
    case UNAuthorizationStatusDenied:
      return @"denied";
    case UNAuthorizationStatusAuthorized:
      return @"authorized";
    case UNAuthorizationStatusProvisional:
      return @"provisional";
    case UNAuthorizationStatusEphemeral:
      return @"ephemeral";
  }
  // A status a later SDK adds is not a grant the app knows how to use.
  return @"unknown";
}

@implementation RCTNativeVoltzNotifications

+ (NSString *)moduleName
{
  return @"NativeVoltzNotifications";
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeVoltzNotificationsSpecJSI>(params);
}

// The status is read back from the settings rather than taken from `granted`, which is also true for
// an ephemeral grant, the App Clip kind this app never gets. The APNs registration is left to
// registerForRemoteNotifications, which JS calls only after a grant.
- (void)requestAuthorization:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                        completionHandler:^(BOOL granted, NSError *_Nullable error) {
                          if (error != nil) {
                            reject(@"request-failed", error.localizedDescription, error);
                            return;
                          }
                          [center getNotificationSettingsWithCompletionHandler:^(
                                      UNNotificationSettings *_Nonnull settings) {
                            resolve(VoltzAuthorizationStatusName(settings.authorizationStatus));
                          }];
                        }];
}

// Not skipped when UIKit already reports the app registered: that flag survives a relaunch, while the
// device token reaches FIRMessaging only through the app delegate callback this call triggers, and
// FIRMessaging keeps it in memory. Resolves once UIKit has the request; the token arrives later.
- (void)registerForRemoteNotifications:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(dispatch_get_main_queue(), ^{
    [[UIApplication sharedApplication] registerForRemoteNotifications];
    resolve(nil);
  });
}

@end
