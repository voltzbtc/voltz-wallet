# Onboarding

The first run is drawn by `App.tsx` outside the navigator, one stage at a time. Add wallet reuses the
same step screens inside the navigator, with stages and back rules of its own (`AddWalletScreen`,
`__tests__/addWalletBack.test.tsx`).

## Stages

| Stage | Screen | Next |
|---|---|---|
| `welcome` | drawn in `App.tsx` | Create to `backup`, Import to `import` |
| `backup` | `BackupScreen` | the first write, then `setPin` |
| `import` | `ImportScreen` | the first write, then `setPin` |
| `setPin` | `PinScreen` (`set`) | `biometrics` when the device has enrolled biometry, `ready` otherwise |
| `biometrics` | `BiometricOfferScreen` | `ready`, whether turned on or declined |
| `locked` | `PinScreen` (`enter`) | `biometrics` once, after a keypad unlock, or `ready`; a forgotten PIN erases down to `welcome` |

The welcome ends with a line saying that continuing accepts the terms of use, with the terms and the
privacy policy each a link to the site in the app's language (`TermsAcceptance`; the address rule,
English at the root and every other language under its code in lower case, is in
`src/i18n/legalLinks.ts`). Each locale marks the two names with `<terms>` and `<privacy>` inside its
own sentence, so the links inflect with the grammar, and a test fails when a locale drops a tag. The
Legal screen in the menu opens the same two pages.

The first run is the short way in: twelve words, I wrote them down, a PIN. The phrase step has no
length picker, no redraw and no wallet id, and the first run has no dice and no passphrase on the
create path. Those live in Add wallet, along with 24 words.

Add wallet draws a 12 and a 24 word phrase together (`useSeedPair`), so the length picker swaps
between two drawn phrases rather than drawing again. A drawn phrase there is stored from the phrase
step, with a passphrase behind a closed link on that step. A dice phrase is the long way chosen on
purpose and keeps its confirmation and its passphrase step: phrase, `VerifyBackupScreen`,
`PassphraseScreen`, then the write.

## The first write

I wrote them down on the phrase step and Restore on the import step write the wallet through
`addFirstWallet`: the passphrase first, then the seed, with the wallet made active. Nothing is stored
before that tap. From the moment that write starts, `committed` is set, and every step from there has
no back, since a step back could lead into a second write. Only a passkey's failed write clears it,
because the next tap derives the same words. A ref holds the write while it runs, so a second tap
waits on it and writes nothing.

A write that fails releases the ref, and the step shows an `ErrorBox` and keeps its button, which
repeats the write with the same words, on screen all along. A repeat that finds those words already
listed keeps that row rather than listing the key twice. The PIN step does the same with Try
again, which saves the PIN already typed twice.

Once the write lands, both drawn phrases are cleared from the app's state. The Keychain holds the
only copy from then on.

A boot that finds a seed and no PIN resumes at `setPin`, where back does nothing.

## Confirming the words later

A wallet stored at I wrote them down carries a mark (`src/wallet/backupMark.ts`, `backup-marks.json`
beside the registry) until its recovery phrase is confirmed. `Home` shows `BackupCard` when the
connected wallet has the mark and holds anything, sats or tokens. The card names no amount, so a
figure the sync has not confirmed cannot make it false, and it has no way to be dismissed. A wallet
spent to zero hides the card and keeps the mark, so it comes back with the next payment.

- **Order.** The mark goes in before the seed (`saveSeedMarked`), and one that cannot be stored stops
  the add. A kill between them leaves a mark with no wallet, which opens nothing, and never a wallet
  with no mark.
- **Who has none.** Words that were typed, in the first run or in Add wallet, and a dice phrase, which
  passed its confirmation before the add. Typed words that take a marked id back clear the mark, since
  they prove the words. A wallet from before the mark existed never sees the card.
- **The confirmation.** The card opens `RecoveryPhraseScreen`, behind the same PIN gate and over the
  same read of the active wallet's words, and a Confirm button there leads to `VerifyBackupScreen`.
  The check asks one numbered word at a time, three in all, one position from each third of the
  phrase, each among four words of the same phrase, so a pick proves where a word sits on the paper
  rather than that it looks familiar (the pattern of Blockstream Green). A right pick moves on with no
  button to press. A wrong one names the word it missed, draws new positions and starts over, so
  trying the options one by one does not get through (three guesses in a row pass one run in 64), and
  offers the words again. Back from the check returns to the words in every flow, and the question
  and its back stay on screen while a recording hides the options. The right words show a confirmed
  screen (the accent disc and check of the received overlay, a line on what the words are for, and
  Done), drawn only once the mark is off the disk. The header keeps the short name, Recovery phrase,
  since a long title shrinks to fit the header of a narrow phone; the question is the heading on
  screen. Positions are drawn on each visit and never stored, and the comparison is by value, so a
  word the phrase repeats passes at any of its positions. The right words clear the mark.
  Nothing else is written. It proves the words and not a passphrase, which `RecoveryPhraseScreen`
  shows beside them.
- **A file that cannot be read** answers yes for every wallet, the card being the safe side. A write
  over a torn file marks every listed wallet, except the one that just confirmed. A read the platform
  refuses leaves the file alone: a confirmation then says it could not be saved and offers Try again.
- **Removing.** Wallets and Edit wallet warn that the words were not confirmed. The mark goes after
  the seed, so a removal that fails half way keeps it on the wallet that is still here.

## A forgotten PIN

The boot lock alone draws a link (`onForgot`), which opens `ForgotPinSheet`. Every other PIN gate is
behind an open app, and has a way back. The sheet says that a PIN cannot be recovered, that the way
back in is to erase the wallets and restore each from its recovery phrase, and that a wallet is lost
without one, with a count of the wallets whose words were never confirmed.

Erase asks the device's own lock first (`passesDeviceCheck`), through an entry behind
`ACCESS_CONTROL.DEVICE_PASSCODE` that is written, read and reset. A cancel erases nothing and nothing
asks again without a tap. A device with no lock has nothing to ask, so the warning stands alone, and
Android below 11 takes that path as well, since react-native-keychain reports no lock there.

`eraseAllWallets` removes every wallet through `removeWallet`, by the ids of the list and of the
Keychain together, so a seed an earlier install left and a passphrase a cut write left go too.

**The PIN goes last, and only once `listSeedIds()` answers empty.** A boot that finds a seed and no PIN
opens at `setPin`, so a PIN taken first would let a kill in the middle hand a wallet to whoever sets a
new one. Any failure propagates, leaves the PIN and keeps the sheet on Try again, and a kill leaves a
lock over the wallets that are left. A kill after the last seed and before the PIN leaves the old PIN
with no wallet: the boot goes to the welcome, and the first PIN set there overwrites it.

Purchase proofs stay, as on any removal, and a purchase proof left under the primary id is read by
whichever wallet takes that id next. The SDK's folder (`Documents/spark`) goes with the wallets, since
it is more than a cache: each wallet's payment history, contacts and lightning address sit there in the
clear. A folder that cannot be erased never stops the way out, because it holds no seed. A push token
stays registered at the gateway. That is why the button says it erases the wallets and not everything.

## Adding a wallet that is already here

Add wallet refuses the same words and passphrase as a wallet whose seed is on the device
(`addAndActivateWallet` throws `WalletAlreadyAdded` before any write), since two ids for one key keep
two sets of records and a reader of one misses the other's. Only a listed wallet with the same
fingerprint is read, and its stored words and passphrase are compared, because the fingerprint can
collide. The screen names that wallet and Back returns to the step the phrase came from, with an
imported phrase kept. The same words with another passphrase are another wallet and are added.
Devices that already list one key twice keep both rows.

## Going back

Before the first write, the phrase and import steps each go back to the welcome. Going back only
changes the stage; it writes, deletes and draws nothing.

- **The chevron.** Each step draws its back as `BackButton` or through `ScreenTitle`
  (`src/components/BackHeader.tsx`, `src/components/ScreenTitle.tsx`). A step that opened with a back and loses it at the first write
  keeps a concealed chevron of the same box in its place (`BackSlot`), hidden from screen readers,
  so the title does not move.
- **Android.** On every onboarding stage and on the biometric offer, the hardware back takes the
  step back or does nothing, and never leaves the app. On the welcome, the lock and the navigator it
  keeps the system's own behaviour. Jest resolves React Native for iOS, so
  `__tests__/onboardingBack.test.tsx` swaps in the Android `BackHandler` to test this (see
  [testing.md](testing.md)).
- **The edge swipe.** The steps sit outside the navigator, so `App.tsx` draws iOS's swipe from the
  leading edge itself with react-native-gesture-handler: a 24pt strip on the leading side, completed
  past 64pt or by a quick flick. It takes the same step as the chevron and Android back, only while
  there is one, so it takes none past the first write. It works on Android too, where it does nothing
  the system back does not.

## The biometric offer

After the first PIN, and only with enrolled biometry, the app offers biometric unlock once. The
offer is marked as made in `biometric-offer.json` in the documents directory when it shows, not when
it is answered, so closing the app on the offer still counts. A mark that fails to write costs at
most one more offer: the next keypad unlock finds no mark, offers again and marks then.

An install whose PIN came before the offer meets it after a keypad unlock, once per device, through
`biometricOfferAfterUnlock`. A biometric unlock hands back no PIN, so it never leads to the offer.
Touching the biometric switch in PIN settings, either way, also marks the offer as made, so turning
biometrics off there is not answered by an offer at the next unlock; that mark is not waited on.

Turning it on stores the PIN just typed where only a biometric releases it: on iOS a Keychain entry
behind `BiometryCurrentSet`, on Android the app's own module (`specs/NativeVoltzBiometric.ts`), whose
key opens once per strong biometric. On Android the write raises the system prompt, worded by the
caller (confirm your face or fingerprint, and the shared cancel), and a cancelled prompt stores
nothing: the offer stays up with a message, and the PIN settings route goes back with the switch off.
Why neither can be the device's passcode is in [app-lock.md](app-lock.md).

An install that turned biometric unlock on before this module existed kept the copy under an entry that
the passcode could release. That entry is never read again: the lock asks for the PIN, and the
keypad unlock removes the entry and offers biometric unlock again, whatever the mark says.
