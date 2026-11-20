# Principles

Voltz is a non-custodial Bitcoin wallet. Three invariants hold for every feature, and a change that
breaks one of them is refused whatever convenience, polish or speed it buys.

## 1. The key is born on the device and stays there

The wallet's private key is created on the device and never leaves it. No server run by the project
receives a mnemonic, a seed, a key, a passkey or a passkey's PRF output, whatever the feature. A
passkey wallet derives its mnemonic on the device from the user's passkey, which the user's own
Apple or Google account may sync, end to end encrypted, and which the project never receives.

A wallet made from recovery words generates its mnemonic on the device (`src/wallet/seed.ts` refuses
to generate one when `crypto.getRandomValues` is unavailable), stores it in the platform keychain,
and never sends it to a server. Not for backup, not for sync, not to make recovery easier. Every
payment is signed on the device by the Breez SDK Spark running inside the app.

A passkey wallet takes its entropy from the passkey's secret instead, so the check in `seed.ts`
does not cover it. Its mnemonic is derived on the device and kept in the same keychain, and it opens
the wallet without the passkey. What the passkey adds to the points of trust is set out in
[trust-model.md](trust-model.md#passkey-wallets).

When the app has to prove something to a server, such as that it owns a lightning address name or a
domain, it signs a statement with the wallet's identity key on the device and sends the signature.
The key itself never leaves. What the optional server side can and cannot do is set out in
[trust-model.md](trust-model.md).

## 2. No custody in any leg, including fiat

The project never receives, holds or forwards the holder's money, in bitcoin, in tokens or in fiat,
not even for a moment in transit.

- Buying bitcoin opens the provider's own checkout (`BuyScreen`), and the bitcoin lands at the
  wallet's own address. Fiat goes from the buyer to the provider and never touches the project.
- A conversion between bitcoin and a token runs between the wallet and the pool the SDK selects.
- A cross-chain receive is paid by the provider straight to the wallet's Spark address.

No flow in the app routes funds through an account the project controls.

## 3. No spread on a swap or an exchange rate

The app adds nothing to a conversion, a swap or an exchange rate, and the cost it shows is the one the
SDK and the pool produce. What the app sells, such as a lightning address name or a custom domain, has
a fixed price.

## Vocabulary in the interface

Text shown in the app never uses the words that name custody or brokerage. That means no bank,
deposit, withdraw, trade, exchange or broker as financial acts, and none of their equivalents in any
locale. `__tests__/locales.test.ts` checks every locale against a list for its language, and a locale
without a list fails.

The app has its own words for the same actions. Money is received and sent, a voucher is redeemed,
an on-chain payment waiting to be credited is pending funds, one asset is converted into another,
and bitcoin is bought from a provider. Translation keys may keep a technical name (the pending funds
block is keyed `deposits`); the rule applies to the text a person reads.

A balance is never framed as an investment either. No invest, yield or profit, in any locale. A
stablecoin is protection against volatility, and token rewards appear as a fact about the token,
credited to whoever pays them. `__tests__/stableBalanceScreen.test.tsx` enforces this on the stable
balance screen.
