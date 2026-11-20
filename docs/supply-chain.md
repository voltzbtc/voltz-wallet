# Supply chain and dependency installation

The rules below answer the kind of attack the **keyv worm** carried out. A hijacked maintainer
account republishes packages with a `preinstall` hook that steals cloud and CI credentials, and the
payload republishes itself through any npm token it finds, reaching hundreds of packages in hours. A
lockfile pinned to earlier versions keeps a project out of reach only if nobody installs while the
poisoned versions are live, which is luck rather than design. This file is the design.

## The two files, and which one actually pins

| File | Role |
|------|------|
| `package.json` | the *intent*, where `"i18next": "^26.3.6"` means any `26.x` at or above `26.3.6` |
| `package-lock.json` | the *fact*, the exact version and integrity hash of every package in the tree |

A caret range is not the danger. The danger is the command:

- `npm ci` installs **exactly** the lockfile. It never moves a version.
- `npm install`, bare, is free to move versions inside their ranges and rewrite the lockfile.

**Use `npm ci`. Use `npm install` only when deliberately changing a dependency.**

## What `.npmrc` enforces

```ini
min-release-age=7
ignore-scripts=true
```

**`min-release-age=7`** refuses any version published less than 7 days ago. This is the single
control that would have stopped the keyv worm on its own, because hijacked releases are detected
and unpublished within hours, so a 7-day quarantine means a poisoned version is gone from the registry
before this project can ever resolve it. Verified working, npm rejects with
`No matching version found for keyv@6.0.0 with a date before ...`.

**`ignore-scripts=true`** blocks dependency lifecycle hooks. A payload like keyv's runs from
`preinstall`, during `npm install`, before a single line of app code executes, so importing the
package is never required. `npm run <script>` is unaffected, so `npm test` and `npm run lint` still
work.

> **`npm ci` ignores `min-release-age`.** Reproduced with npm 11.17.0. In a clean directory,
> `npm install left-pad@1.3.0 --min-release-age=3650` fails with
> `ETARGET ... no matching version ... with a date before`, while `npm ci --min-release-age=3650`
> against a lockfile that already contains that version **installs normally**. `npm ci` reifies the
> lockfile without consulting registry dates.
>
> So `npm run setup`, which is `npm ci`, and CI are **not** protected by the quarantine. The
> quarantine protects the one moment it needs to, when a dependency enters or moves version through
> `npm install`, and the lockfile protects everything else. That makes **reading the
> `package-lock.json` diff** more than good practice, since it is the control that remains.

## The one script this project genuinely needs

`@breeztech/breez-sdk-spark-react-native` uses `postinstall` to download its prebuilt native
artifacts (`android/src/main/jniLibs`, `build/RnBreezSdkSpark.xcframework`) from GitHub Releases and
verify them against SHA-256 checksums in its own `package.json`. Without it the iOS and Android
builds fail while the JS tests still pass, which makes the breakage easy to miss.

With `ignore-scripts=true` that hook no longer runs automatically, so it is invoked explicitly:

```bash
npm run setup        # npm ci --ignore-scripts && npm run native:fetch
```

After any `npm ci`, run `npm run native:fetch`, or just use `npm run setup`.

The script exits early when both artifact directories already exist, whatever version they came
from, so a bump of the SDK can leave the previous native artifacts in place. See
`docs/breez-sdk-binding.md`.

## The native artifacts, a chain npm does not cover

The npm lockfile covers nothing CocoaPods or Gradle downloads.

| Artifact | How it is verified |
|----------|--------------------|
| Spark (`RnBreezSdkSpark.xcframework`, `jniLibs`) | SHA-256 in the package's own `postinstall.sh`, with `exit 1` on a mismatch |
| The Gradle distribution | `distributionSha256Sum` in `gradle-wrapper.properties` |
| Play Billing and the two modules it brings (`billing`, `play-services-location`, `play-services-places-placereport`) | SHA-256 of each POM and AAR in `android/gradle/verification-metadata.xml` |
| Every other Maven dependency | **nothing.** The same file trusts every other component |

`play-services-mlkit-barcode-scanning` reaches the APK through VisionCamera. The app also names it
`compileOnly` in `android/app/build.gradle`, for the still image QR reader, which adds nothing to what
ships. `scanGallery.test.tsx` fails when the two versions differ, so a VisionCamera bump that moves it
has to move this line too.

The Android build declares `google()` and `mavenCentral()` and nothing else. A repository that
serves bare artifacts with no POM and no checksum (an ivy repository with
`metadataSources { artifact() }`) does not stay in the build, even when nothing currently resolves
from it.

A repository in `allprojects.repositories` is consulted for **every** coordinate in every module, so
a host that only needs to serve one artifact can answer for any group, ahead of mavenCentral. If a
Breez Maven artifact is ever needed, scope it with a `content { includeGroup ... }` filter.

`android/gradle/verification-metadata.xml` pins only the three modules above, the ones the store
bridge brought in, and trusts the rest through two regex rules: every group but
`com.android.billingclient` and `com.google.android.gms`, and every module of the second but
`play-services-location` and `play-services-places-placereport`. A bump of any of the three fails
the build until its checksums are in the file. Read each new value from `dl.google.com`, compare it
with the `.sha256` Google publishes beside the file (placereport publishes only a `.sha1`, so compare
that), and before trusting it, confirm that a wrong digit fails `./gradlew :app:checkDebugAarMetadata`.

Pinning the checksum of **every** Maven dependency is still open. It is the complete version of this,
and it is left out deliberately, since the file then breaks the build on every dependency bump and
can only be validated with a full Android build. See the end of `docs/release-signing.md`.

## Checklist before touching a dependency

1. **Read the `package-lock.json` diff in the commit.** Asked to bump one package and the lock moved
   300 lines? Something transitive came along, so look at what.

   For example, `@react-native-community/cli` 20.2.0, which clears a `fast-xml-parser` advisory,
   moves that library from 4.5.7, which has no dependencies, to 5.10.1, which has six:
   `@nodable/entities`, `fast-xml-builder`, `is-unsafe`, `path-expression-matcher`, `strnum` and
   `xml-naming`. All six are the same author's own modularization (the NaturalIntelligence org, same
   as `fast-xml-parser`), which is what makes the bump acceptable. It also means one npm account
   controls seven packages in this build chain, and a worm like keyv's needs exactly one hijacked
   account.
2. **`npm audit signatures`** checks registry provenance. It is useful but not decisive, since a
   hijacked release like keyv's carries *valid* provenance when it is built by the project's real
   GitHub Actions workflow. The quarantine is what actually protects the build.
3. **Never `npm install` in a rush before a build or a release.** That is the exact moment poison
   gets pulled in.
4. **Before adding a new package**, check download counts, the last publish date, and how many
   transitive dependencies it drags in. A three line helper pulling 40 packages is 40 maintainer
   accounts that can be hijacked.

## Skipping the quarantine, on purpose

The quarantine is time for someone else to notice a hijacked release. Skipping it means doing by
hand what that time would have done, and writing down that it was skipped. The override is per
command (`--min-release-age=0`); `.npmrc` never changes.

Four checks stand in for the seven days. The figures below are from applying them to
`@breeztech/breez-sdk-spark-react-native` 0.26.0 a day after its release.

1. **Diff the package against the previous version, not against expectations.** `npm pack` both
   with `--ignore-scripts`, unpack, compare `package.json` (scripts, dependencies) and every file
   outside the generated bindings. Between 0.25.0 and 0.26.0 the only differences are the version
   and the two native artifact checksums, and `scripts/postinstall.sh` is byte-identical.
2. **Same publisher and same release shape as the version already trusted.** 0.25.0 and 0.26.0 are
   both published by the same npm account, both with a `gitHead` that is the "Update React Native
   bindings" commit in `breez/breez-sdk-spark-react-native`, and both with the native release
   created by the same GitHub account seconds after it.
3. **Hash the native artifacts yourself.** The postinstall script checks sha256 against
   `package.json`, which only helps if `package.json` is honest. Download both zips from the GitHub
   release and compare against the declared checksums, with a negative control (one zip against the
   other's checksum must differ), so a comparison of two empty strings cannot read as a match.
4. **Read the lock diff** as in the checklist above. For 0.26.0 it is 8 lines for the one package,
   with an integrity hash that matches the tarball checked in step 1, and the iOS lock moves 2 lines,
   the pod version and its checksum.

A passing check here says the release is what Breez published. It says nothing about whether Breez's
own accounts were compromised in the last day, which is the one thing only time answers.

## Incident response for a worm of this kind

1. `grep` every lockfile for the affected `name-version` strings.
2. Hunt IOCs on disk: `setup.mjs`, `math_init.js`, `router_runtime.js`, `gh-token-monitor*`,
   `bun-dl-*`, a `SessionStart` hook in `.claude/settings.json`, a `folderOpen` task in
   `.vscode/tasks.json`.
3. Check the GitHub organisation that hosts this repository, and every account with push access to
   it, for repositories the worm creates (description `Shai-Hulud: Here We Go Again`) and for
   workflow runs dated after the compromise.
4. If anything is found, rotate npm, GitHub and cloud credentials **before** cleaning up, since the
   payload's purpose is credential theft.

## The SDK and its LNURL server

Breez requires the LNURL server to be updated before the SDK of the apps that use it
(`crates/breez-sdk/lnurl/README.md`). The server is a separate deployment that nothing in this
repository can see, so `__tests__/sdkServerVersion.test.ts` pins the server version the app runs
against and fails when the SDK version in `package.json` or the lockfile is above it. A bump of the
SDK updates the server first and moves the pin after it.

## Beyond this repository

A user-level `~/.npmrc` with `min-release-age=7` extends the same quarantine to a freshly cloned
repository, a one-off `npx`, or any project without its own `.npmrc`. Override it per command when a
genuinely fresh release is needed (`npm install <pkg> --min-release-age=0`). `ignore-scripts` belongs
in each project rather than there, since set globally it silently breaks unrelated projects that
build native binaries at install time.
