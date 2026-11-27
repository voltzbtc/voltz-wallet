# Address card

Share on the lightning address screen offers the address in two forms, for a social bio, a status or
a chat: a square PNG card, and text alone. Breez's receive screen guide
([uxguide_receive](https://sdk-doc-spark.breez.technology/guide/uxguide_receive.html)) names Copy and
Share as the two main actions on an address; Copy stays the tap on the address, and Share sits under
the code as a secondary button, as on Receive.

## What the card holds

One `Svg` (`src/components/AddressCard.tsx`), so react-native-svg's `toDataURL` turns what the sheet
shows into the PNG: the Voltz wordmark in the brand orange whatever the wallet's accent, a line asking
to be paid in bitcoin, the QR on its white frame, and the address in the largest type that keeps it
on one line. It is laid out as a 360 point screen drawn at 3x, so every measure comes from
`src/theme.ts`, and it is square at 1080 pixels, so a status that crops to a square loses nothing.

The code is the screen's code. `LnAddressScreen` draws `lnAddr.lnurl` through react-native-qrcode-svg
with no level, so at its default `M`, and `cardQrPath` in `src/wallet/addressCard.ts` draws the
modules of `qrcode`'s symbol for the same text at the same level. The card is not a nested `Svg`
holding the `QRCode` component: both platforms draw a nested `Svg` through their own size rules
(density on Android, a clip on the context on iOS), and a path in the card's own coordinates is the
primitive every other shape on it already uses. `__tests__/addressCard.test.tsx` reads the cells back
from the path and holds them to the symbol, and holds the library's default level.

The text that goes with the image carries the address, so an app that takes only text still gets it.

## When it is offered

- Only beside an address the screen shows as current: not while the read is in flight, failed or
  empty, not while the domain is frozen or a deletion mark holds the address.
- Not while an emergency exit holds the wallet. The hold is read on every focus, as Receive reads it,
  and Share stays off until that read answers; it is read again at the press of Share and at each
  press that sends. A hold also takes the address card itself off the screen, with the line that says
  why.
- The sheet draws the address as it was when Share was pressed and sends that one. It closes when the
  screen's address changes or may no longer be handed out, and a press whose hold read answers after
  the address moved on opens nothing.

## What leaves the device

Nothing goes through the network. The PNG is written to one file, `Caches/share/voltz-address.png`
(`CARD_FILE`), and leaves only through the system share sheet, to the app the person picks.

- iOS: React Native's `Share` takes the file URL and the text. The file is removed once the sheet
  closes, whether it shared or failed.
- Android: React Native's `Share` sends text alone, so `specs/NativeVoltzShare.ts`
  (`android/app/src/main/java/app/usevoltz/share/`) sends an `ACTION_SEND` of `image/png` with the text
  as `EXTRA_TEXT`, through a content URI from `ShareFileProvider`, following
  [Sharing files](https://developer.android.com/training/secure-file-sharing). The provider is not
  exported, serves the cache's `share` folder and nothing else (`res/xml/share_paths.xml`), and the
  read grant rides on the intent with the URI in its `ClipData`, so only the chosen app can open the
  file. The chooser returns before that app reads it, so the file stays until the next share
  overwrites it; it is never in a public folder or the photo library.

A failure to draw (no answer from `toDataURL` within 5 s) or to share shows one line in the sheet and
leaves both buttons ready.

## Not measured yet

- The PNG itself on a device: `toDataURL` at 1080 pixels on iOS and Android, and how the system font
  draws the invite line in Arabic, Hebrew, Urdu, Hindi and Thai inside an `Svg`.
- The Android chooser handing the image and the text to real apps, and which apps keep the text when
  an image is attached.
