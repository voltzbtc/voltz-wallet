# R8 rules for the release build, beyond the ones the app's libraries ship in their own AARs.
#
# None are needed. AGP merges every library's consumer rules (the merged set lands in
# app/build/outputs/mapping/release/configuration.txt), and they already keep each class the app
# reaches by name at runtime:
#
# - React Native keeps every NativeModule with all its members, every @DoNotStrip member and the
#   names of native methods. That holds the app's own modules (store, QR image, restart), the
#   TurboModule specs codegen writes for them, and the Breez SDK binding, whose module binds its two
#   JNI functions by name. The binding reaches its Rust core through JSI, not JNA, so the JNA rules
#   it ships match nothing.
# - Hermes' Intl classes, VisionCamera's JNI classes and the gesture handler's hybrid module are
#   @DoNotStrip, or held by a kept module.
# - Reanimated, worklets, react-native-svg and react-native-screens ship rules for their own code;
#   Firebase, ML Kit, Play Billing, AndroidX Credentials, OkHttp and coroutines ship theirs.
# - Everything the manifest declares is kept by AAPT.
#
# A rule added here keeps no more than the lookup it protects, with its reason on the line above.
#
# R8 8.12 warns "Invalid stack map table ... Constructor mismatch" for classes inside
# play-services-auth 21.5.0 (com.google.android.gms.auth.api.identity, signin, internal), a
# bytecode defect in Google's jar that no rule here can fix. It still compiles those methods, but a
# later R8 may treat them as unreachable, and they sit on the Credentials path the passkey uses on
# Android below 14. Recheck that path on any AGP, R8 or play-services-auth upgrade.
