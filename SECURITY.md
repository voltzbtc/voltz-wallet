# Security policy

Voltz Wallet holds the keys to real funds, so security bugs are reported and handled in private
until a fix is released.

## Reporting a vulnerability

Report it through GitHub's private vulnerability reporting on this repository. Open the
**Security** tab, choose **Report a vulnerability**, and fill in the form
(<https://github.com/voltzbtc/voltz-wallet/security/advisories/new>). Only the maintainers see the
report.

Do not open a public issue, pull request or discussion for a security bug, and do not publish it
elsewhere before a fix is released.

## What to include

- The app version, shown at the foot of the side menu, or the commit you built from.
- The platform, the OS version and the device or simulator.
- What an attacker can do, and what they need first, such as physical access, another app on the
  same device, a position on the network or control of a server.
- Steps to reproduce, or a proof of concept.
- A suggested fix, if you have one.

Never send a real recovery phrase, passphrase, PIN or private key, and never one that guards funds
you need. Test with a wallet created for the test and holding small amounts only.

## Scope

In scope is the app in this repository, and above all:

- **Key handling.** Generating the recovery phrase, deriving it from a passkey, the BIP39
  passphrase, and any path that could take a mnemonic, a seed, a private key or a passkey's output
  off the device.
- **Signing.** Any way to make the wallet sign or send a payment, a conversion or a signed statement
  the person did not confirm, or to show an amount, a fee or a destination other than the one
  signed.
- **Storage.** The Keychain and Keystore entries, the wallet files kept on the device, the PIN, the
  lock after time away and the cover drawn in the app switcher.
- **The store bridge.** Buying names and domains through the App Store and Google Play, and the
  app's side of how a purchase is verified and delivered.
- **The rest of the app's own code**, including the emergency exit, the signed update notice and
  what the app sends to the lightning address service.

Out of scope:

- The Breez SDK Spark and the Spark network themselves. Report those to Breez, following
  <https://github.com/breez/spark-sdk/security/policy>.
- Services run by third parties, such as the card purchase provider, the App Store and Google Play.
- Attacks that need a rooted or jailbroken device, or an attacker who already knows the PIN.
- Reports from automated scanners with no demonstrated impact.

## What happens next

You get a first answer within 7 days. Once the issue is confirmed, the maintainers work on a fix,
keep you informed, and agree a disclosure date with you after the fix is released. The published
advisory credits you unless you ask otherwise.

## Supported versions

Fixes go into the `main` branch and the next release in the App Store and Google Play. Older
releases are not patched, so update before testing.
