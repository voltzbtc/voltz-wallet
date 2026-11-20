#import "RCTNativeVoltzDurable.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

// On Darwin fsync hands the data to the drive, which may keep it in its own cache across a power
// loss; F_FULLFSYNC asks the drive to write it out (fsync(2), fcntl(2)). A file system that refuses
// F_FULLFSYNC gets fsync, as SQLite's full_fsync does. fsync flushes the file, not the descriptor, so
// a read-only descriptor opened after the write is enough, and the only one a directory takes.
static int VoltzFullSync(NSString *path)
{
  int fd = open(path.fileSystemRepresentation, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    return errno;
  }
  int failed = fcntl(fd, F_FULLFSYNC) == -1 && fsync(fd) == -1 ? errno : 0;
  close(fd);
  return failed;
}

static void VoltzSettle(int failed, RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject)
{
  if (failed == 0) {
    resolve(nil);
    return;
  }
  NSError *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:failed userInfo:nil];
  reject([NSString stringWithFormat:@"E%d", failed], [NSString stringWithUTF8String:strerror(failed)], error);
}

@implementation RCTNativeVoltzDurable

+ (NSString *)moduleName
{
  return @"NativeVoltzDurable";
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeVoltzDurableSpecJSI>(params);
}

- (void)syncFile:(NSString *)path resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  VoltzSettle(VoltzFullSync(path), resolve, reject);
}

// rename(2) replaces a file at `to` in one step, which NSFileManager's move refuses to do.
- (void)rename:(NSString *)from to:(NSString *)to resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  int failed = rename(from.fileSystemRepresentation, to.fileSystemRepresentation) == -1 ? errno : 0;
  VoltzSettle(failed, resolve, reject);
}

- (void)syncDirectory:(NSString *)path resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  VoltzSettle(VoltzFullSync(path), resolve, reject);
}

@end
