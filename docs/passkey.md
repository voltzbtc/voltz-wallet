# Passkey wallets

A passkey wallet is a wallet of twelve words whose words come from a passkey instead of the random
generator. From the seed on nothing differs: the words go through `addFirstWallet` and
`addAndActivateWallet`, live in the Keychain, and connect, sign and show a recovery phrase as any
others. The passkey enters at three moments only: creating, restoring and testing.

`PASSKEY_LIVE` in `src/wallet/passkey.ts` is the switch, and it is on. A device below the minimums
draws what it drew before any of this code, from the first frame, and never reads the native module:
the screens ask `passkeyOffered`, which is the switch and the minimums together, before drawing a
passkey's place. `__tests__/passkeyOff.test.tsx` holds that with the switch as it ships on iOS 17.7,
with snapshots of the first run, Add wallet, the import step and the recovery phrase, taken before the
first line of this code, and on Android API 27. A test picks its path through
`__setPasskeyLiveForTests`, and `null` returns to the switch; `__DEV__` and the `NODE_ENV` Metro writes
into a bundle keep it inert outside Jest.

## Derivation

The passkey's PRF is evaluated over two salts in one ceremony. The first gives the Nostr key of the
label directory. The second is the label, and the first sixteen bytes of its output are the entropy of
twelve BIP39 words, with no passphrase (`derivation.rs`, `mod.rs` in the SDK). The SDK stores nothing,
and the same credential, relying party and label give the same words every time.

So three values are part of every wallet and are constants: `PASSKEY_RP_ID`, `PASSKEY_RP_NAME` and
`PASSKEY_LABEL`. Each credential gives a different wallet under the same label. `user.name` is unique
per registration and carries nothing of the person, because Apple's Passwords treats two passkeys of
one domain and name as one.

## Minimums

iOS 18 and Android API 28. Below them `passkeyAvailable` answers no without loading the provider, and
the words are the only way in. The app's own minimums stay at iOS 15.1 and API 24.

The provider is reached by `import()`, in a function. A static import would read the native module on
any device, and a `require` resolves by the package's `require` condition to `lib/commonjs`, while the
app's imports resolve to `lib/module`: two copies of the generated bindings, with the provider in one
copy's handle map and Rust calling the other's vtable. Only `import()` is both lazy and on the same
copy. `react-native bundle` holds `lib/module/passkey-prf-provider.js` and no `lib/commonjs` file.
Node has no loader behind `import()` under Jest, so `babel.config.js` turns it into a require there.

## Who calls what

| Screen | Call | Notes |
|---|---|---|
| Welcome | `connectWithPasskey`; on iOS after a refusal, `register` | Signs in silently, registers only when the system finds no credential. On iOS a refusal offers the same tap again and Create a new passkey, which registers |
| Add wallet | `register` | `excludeCredentials` stays empty, or the system refuses a second wallet |
| Restore step | `signIn` | `preferImmediatelyAvailableCredentials: false`, so the system offers another device. Never registers |
| Edit wallet | `signIn`, pinned | Test passkey, compares the fingerprint |

Whether a wallet was registered or found is read from `createPasskey` having run in the ceremony. A
sign-in carries no attestation, so `backupEligible` and `aaguid` exist only from a registration.

A credential the system created stays unclaimed in `passkey.ts` from the moment `createPasskey`
answers until a stored wallet claims it (`passkeyWalletStored`), compared by credential id. Until then
every tap on a way to create, Welcome's Create a new passkey included, signs in pinned to it and never
registers again, whatever came between: `CreatedButNotDerived`, any other failure after the create, a
Keychain that refused, an answer that landed after the screen left, or leaving the screen and coming
back. A restore takes no pin, since that
would hide the passkey the person came for. It lives in process memory, so after a kill Welcome's next
tap finds the credential by signing in. Add wallet registers directly, so there the first passkey stays
with a wallet nobody saw.

## The bridge to the SDK

The provider is handed to the client through `bridgedProvider`, never left to the zero-config default.
The package's JS does not meet the generated bridge in four places, read on 0.26.0 and with the same
controls passing on 0.27.2, nor its own iOS module in a fifth, measured on 0.28.0:

| What the provider does | What the bridge does with it |
|---|---|
| Rejects with `PasskeyPrfException` | `isErrorType` is `PrfProviderError.instanceOf`, so it is `CALL_UNEXPECTED_ERROR`. `PrfProviderError` has no `From<UnexpectedUniFFICallbackError>`, so `handle_callback_unexpected_error` panics, and `[profile.release]` sets `panic = "abort"` |
| Answers `null` for an absent field | `FfiConverterOptional` tests `value !== undefined`, so the item converter reads `null`. The throw lands in `handleSuccess`, past the promise, and the Rust future never completes |
| Answers the domain check with `{ kind }` | The converter switches on `.tag`, with the same outcome as null |
| Iterates `allowCredentials` as bytes | The bridge hands `ArrayBuffer`s, which are not iterable, so a pinned sign-in throws before the native call |
| Asks the iOS domain check with `rpId` alone | `BreezSdkSparkPasskey.m` declares `rpId`, `teamId`, `resolve`, `reject`. The TurboModule hands the resolve block over as `teamId`, Swift's string bridge raises `NSInvalidArgumentException`, and the app ends at the first availability check. No JS `catch` sees it. `bridgedProvider` answers `Skipped` on iOS without crossing |

`__tests__/passkey.test.ts` runs the package's real `PasskeyProvider` over a fake native module, and
shows the panic, the hang and the pinned sign-in with the bare provider as controls. The double in
`__mocks__/@breeztech/breez-sdk-spark-react-native/passkey-prf-provider.ts` applies the bridge's rules
to whatever crosses it, so a value the real bridge would refuse fails there too.

The first four were read in the generated code and in uniffi and reproduced under Node; the effect of
the abort in particular is an inference from the profile and the conversion. The fifth was measured on
the iOS 26.5 simulator in November 2026: with the switch on, a build without the guard closed itself as
Welcome opened. `CredentialNotFound` is what `connectWithPasskey` falls through on, so without the
mapping a first registration from Welcome could not happen at all.

On iOS that fall-through rests on a timer in the package. With `preferImmediatelyAvailableCredentials`
and no passkey, iOS answers `.canceled`, the same code as a dismissed sheet, and
`PasskeyAssertionCore.swift` reads a cancel under 300 ms as no credential and anything longer as the
person's. Apple offers no way to tell the two apart, and a cold first tap can pass the 300 ms with no
sheet shown, as one device did on the iOS 26.5 simulator while another answered in about 280 ms.
Breez's rule and its 300 ms are the same from 0.28.0 to 0.28.5.

So on iOS a refused connect on Welcome claims nothing about the person. Its line says only that the
passkey did not open and asks which way to go. Try again runs the same connect, and Create a new
passkey runs `register`, which `passkeyAttempt` still pins to an unclaimed credential. Nothing retries
or registers on its own, as Apple's sample and Breez's documentation advise for a cancel, because a
registration nobody asked for is a second wallet. The two buttons share one guard, so neither starts a
ceremony while the other's runs. Add wallet and the restore step keep the plain refusal and its one Try
again, since neither can fall through to a registration. Android's Credential Manager names the absent
credential, so it has no timer, and a refusal there is the person's, with that line and one Try again.

An error's text is in `inner`, and what a screen acts on comes from the tag, never from a message.

## Availability

`checkAvailability` is asked once per opening, with a ceiling of three seconds, and never rejects. Yes
for `Available` and for `Skipped`. No for a failure, `PrfUnsupported`, `NotAssociated` (the reason goes
to the development log) and silence. A ceremony that ends in `PrfNotSupported` or `Configuration`
overrides an earlier yes.

iOS always lands on `Skipped`, because `bridgedProvider` answers it without asking the native module,
whose wrong arity ends the app (the bridge table above). A wrong association file shows only at the
ceremony, as a configuration error.

## What is stored

`passkey-wallets.json` in Documents, written only by `passkey.ts`, through `durableFile`, keyed by
wallet id: `credentialId`, `aaguid`, `backupEligible`, `created`, `fromCreate`, `userName`, `rpId`,
`label`, `fingerprint`, `at`. Nothing in it can rebuild the words. `normalize` in `walletRegistry.ts` copies only
`id` and `fingerprint`, which is why none of it lives in `wallets.json`.

The entry goes in before the seed, as the unconfirmed mark does. An entry whose fingerprint is not the
listed wallet's was left by a seed that never landed, and `passkeyEntryFor` ignores it. Losing the file
costs the row in Edit wallet and no key, so a torn file is written over.

`removeWallet` drops the entry. The passkey itself stays where the system keeps it: the package has no
call to delete one. The remove warnings and the data deletion screen say so and where it is deleted,
for a wallet that has one (`passkeyRemovalNote`).

## Words and confirmation

A passkey is not proof of holding the words, in creation or in a restore, so `WalletOrigin` keeps the
unconfirmed mark on both, and `BackupCard` works as it does for drawn words. A restore also takes the
import check, so a wallet whose data was deleted is read the same way as one typed in.

Apart from the restore button, everything that does not prove `backupEligible: true` owes the words,
so a tap on Create that lands on a sign-in owes them too. A sign-in carries no attestation and cannot
tell a passkey cut off by a kill before its write from a new phone, and the cost of the second is one
verification more. `fromCreate` records which way in it was, and the restore button keeps only the mark.

When the words are owed, `PasskeyWordsScreen`
stands before the PIN in the first run and before the end of Add wallet, and it ends only at
`VerifyBackupScreen`. Back from the check returns to the words, by the chevron in the first run, the
header in Add wallet and Android back in both, and it is the only back there is: the words themselves
stay held. The parent keeps which of the two is up, since its back is what moves between them. That is computed from the entry and the mark (`passkeyWordsOwed`), not stored, so
a confirmation from the recovery phrase screen settles it, and a boot cut in the middle comes back to it
(`activeWalletOwingWords`).

## Text

`backupEligible` is what the authenticator reports, so the sync line is given as what the device says,
and only for `true`. The line that says a passkey opens this wallet appears only after a test on the
same screen with the same fingerprint, and is not kept, since the passkey can be deleted from the account
at any moment. A failed test says it could not check, never that the passkey is lost.

The removal lines say that removing the wallet does not delete the passkey, and where it is deleted:
the Passwords app on iOS, which is where iOS 18 and later keep passkeys, and the phone's password
manager on Android. Nothing about restoring, since they are read at the moment of removing a wallet,
by people who may have no words and whose passkey may already be gone. The line before creating
describes what a passkey is, with no biometrics assumed, and says what deleting it can cost.

## What the switch needs

`PASSKEY_LIVE` and `webcredentials:usevoltz.app` in `ios/VoltzWallet/VoltzWallet.entitlements` change
together, and `__tests__/passkeyWallet.test.ts` reads both. A build with the switch on also needs:

- the App ID with the Associated Domains capability, and a profile rebuilt with it;
- `apple-app-site-association` and `assetlinks.json` served on `usevoltz.app`;
- R8 on the release build (`enableProguardInReleaseBuilds`). Credential Manager finds its Play
  Services provider by name, and `credentials-play-services-auth` 1.3.0 ships the rule that keeps
  `CredentialProviderPlayServicesImpl` whenever `CredentialManager` is kept, so `proguard-rules.pro`
  adds none. A build from a store track is the one that proves it.

Only hardware or a store's internal track shows whether PRF works there at all, whether Apple's
Passwords keeps two passkeys with different names, what a closed sheet does through the bridge, and a
real `connectWithPasskey` that falls through to registration.
