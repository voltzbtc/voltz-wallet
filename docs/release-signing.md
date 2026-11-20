# Release signing (Android)

## Why a release never signs with the debug key

The React Native template ships `android/app/build.gradle` with this release block:

```groovy
release {
    // Caution! In production, you need to generate your own keystore file.
    signingConfig signingConfigs.debug
}
```

Kept as it comes, it signs **every release APK with the debug key**, `debug.keystore`, which is
committed to this repository with alias `androiddebugkey` and password `android`. That is worse than
a weak key. It is the Android SDK's default debug key, whose private half sits on every machine that
has the SDK installed.

On Android an app's identity is the pair `applicationId` plus signing key. Anybody can build an APK
with the same `applicationId` signed with the same key, and the system accepts it as a **legitimate
update** of the app. An update inherits the app's identity, including the Keystore entries the real
app wrote through react-native-keychain, and with them the user's seed.

Exploiting this needs no entropy bug or any other flaw in the app, so it ranks above the entropy
risks in `docs/open-risks.md`.

## How release signing works

The credentials live in `android/keystore.properties`, which is **gitignored**:

```ini
storeFile=app/voltz-release.keystore
storePassword=...
keyAlias=voltz
keyPassword=...
```

`storeFile` is relative to `android/`. The `build.gradle` defines the release `signingConfig` only
when that file exists, and `assembleRelease` and `bundleRelease` **fail with an explicit message**
when it does not.

Failing loudly is the point. Without the guard, AGP emits an unsigned APK, and the error surfaces
much later, far from its cause. A silent fallback to the debug key is the exact defect the guard
exists to prevent.

`debug.keystore` stays committed and keeps signing debug builds, deliberately, because debug builds
from different machines need the same key to replace one another on a device.

## Generating the keystore (once)

```bash
keytool -genkeypair -v -keystore android/app/voltz-release.keystore \
  -alias voltz -keyalg RSA -keysize 4096 -validity 10000
```

Then create `android/keystore.properties` with the four keys above.

**Back up the keystore and the passwords somewhere other than the repository.** Losing the keystore
means losing the ability to publish updates to the app on the Play Store, permanently. There is no
recovery, and the only way out is publishing a new `applicationId` and migrating users by hand.
Losing that on a self-custody wallet is worse than average, because the user is left on a version
nobody can fix.

If the app is on Play App Signing, the upload key can be rotated from the console. The final signing
key cannot.

## CI

Neither `keystore.properties` nor the keystore enter the repository. In CI, write both from secrets
before the build (the keystore base64 encoded in a secret, decoded on the runner) and delete them
afterwards. There is no path in which the release key is committed.

## What is left out

**Gradle dependency verification** (`android/gradle/verification-metadata.xml`) pins only the three
modules the store bridge brought in and trusts every other Maven dependency (`docs/supply-chain.md`).
Pinning every one produces a large file that breaks the build on every dependency bump and can only
be validated with a full Android build, and hardening applied without that validation turns into a
regression (see the `SECURE_HARDWARE` trap in `AGENTS.md`).
