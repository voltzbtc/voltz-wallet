#import "RCTNativeVoltzCapture.h"

#import <React/RCTInvalidating.h>
#import <UIKit/UIKit.h>

@interface RCTNativeVoltzCapture () <RCTInvalidating>
@end

@implementation RCTNativeVoltzCapture {
  id<NSObject> _capturedObserver;
  id<NSObject> _screenshotObserver;
}

+ (NSString *)moduleName
{
  return @"NativeVoltzCapture";
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeVoltzCaptureSpecJSI>(params);
}

// Observing starts here rather than in init, because an emit before this call runs an empty callback
// and aborts. Each block holds the module weakly: after a reload the old module is gone.
- (void)setEventEmitterCallback:(EventEmitterCallbackWrapper *)eventEmitterCallbackWrapper
{
  [super setEventEmitterCallback:eventEmitterCallbackWrapper];
  if (_capturedObserver != nil) {
    return;
  }
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  NSOperationQueue *main = NSOperationQueue.mainQueue;
  __weak RCTNativeVoltzCapture *weakSelf = self;
  _capturedObserver = [center addObserverForName:UIScreenCapturedDidChangeNotification
                                          object:nil
                                           queue:main
                                      usingBlock:^(NSNotification *note) {
                                        [weakSelf emitOnCapturedChange:UIScreen.mainScreen.isCaptured];
                                      }];
  _screenshotObserver = [center addObserverForName:UIApplicationUserDidTakeScreenshotNotification
                                            object:nil
                                             queue:main
                                        usingBlock:^(NSNotification *note) {
                                          [weakSelf emitOnScreenshot];
                                        }];
}

// UIKit is read on the main thread, and this resolves on it rather than on the module's queue.
- (void)isCaptured:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(dispatch_get_main_queue(), ^{
    resolve(@(UIScreen.mainScreen.isCaptured));
  });
}

- (void)invalidate
{
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  if (_capturedObserver != nil) {
    [center removeObserver:_capturedObserver];
    _capturedObserver = nil;
  }
  if (_screenshotObserver != nil) {
    [center removeObserver:_screenshotObserver];
    _screenshotObserver = nil;
  }
}

@end
