# Open risks

The risks to the wallet's keys and funds that are not closed, and the reason behind each choice, so
nobody spends time rediscovering them or "fixes" them blind. The controls that close the others are
in `docs/release-signing.md` and `docs/supply-chain.md`.

## 1. Spark is co-signing, and the emergency exit has not finished with real money

Funds on Spark are controlled by an aggregate key, `sk_agg = sk_user + sk_so`
(https://docs.spark.money/learn/frost-signing). The user's signature is required, so operators do
not move funds alone on the happy path, but they **can delay and censor**, and the guarantee that a
former operator does not spend rests on it having deleted its old share. Spark itself calls that "an
operational promise" rather than a cryptographic guarantee
(https://www.spark.money/research/statechains-bitcoin-scaling-deep-dive).

The way out is the unilateral exit. The installed binding (0.28.0) exposes it as `prepareRecoverFunds`,
`recoverFunds` and `checkRecoverFunds`, which replaced `prepareUnilateralExit`, and keeps
`exportUnilateralExitState`.

**What is missing is the end of the proof, not the flow.** The flow is in `docs/emergency-exit.md` and
ships on. On the real SDK (0.28.0), a connection and a quote with the operators down were measured on
leaves worth moving, and a real exit started: its first package was accepted by a host and
confirmed. Its sweep, `Done`, and `recoverFunds` with the operators down are not measured yet. It says
that the fees take **external** on-chain BTC, and it refuses what is too small to come out. No UX
invents funds to pay a fee.

**Not verified.** Whether Spark's `storageDir` holds the pre-signed exit transactions, that is,
whether the seed alone suffices to exit after the operators go dark, is answered by no primary
source from Spark or Breez. It is the most consequential question on the list.

## 2. Health of the system CSPRNG

This is the only vector with exactly the shape of the Coldcard seed-generation bug that no code in
the app can see. A badly seeded `SecureRandom` or a broken `SecRandomCopyBytes` produces a
predictable seed without ever calling `Math.random` and without leaving a tail of zeros, and it
passes every guard in `wallet/seed.ts` and `wallet/secureRandom.ts`.

**It cannot be mitigated in JS.** What actually resolves it is independent entropy supplied by the
user, which is what saved the Coldcard users who used dice
(https://blog.coinkite.com/coldcard-mk3-seed-generation-warning/). Their firmware mixed the device
seed with each roll; this app takes the dice alone, which reaches the same outcome for this risk by
a shorter route. See the decision below.

**Both user-side defences exist.** The BIP39 passphrase has a stage of its own during onboarding
(`PassphraseScreen`), is stored per wallet (`loadPassphraseFor`), enters
`Seed.Mnemonic.new({ mnemonic, passphrase })`, and is folded into the fingerprint, or a wallet with a
passphrase would land under the wrong id. Every screen reads that one fingerprint, the registry's
(`walletIdentityOf` in `wallet.ts`), so the drawer, Edit wallet, the recovery phrase screen and the
wallets list show one id and one name; a name, colour or image saved under the fingerprint of the
words alone is copied to it once, the first time the wallet's identity is read (`carryWalletMeta`). Onboarding writes it before the seed, since the seed is what
makes a wallet exist at boot: a kill between the two writes leaves no wallet rather than one that
opens without its passphrase. The PIN is written last, and a boot that finds a seed with no PIN
resumes at Create PIN, where back does nothing, so a kill before the PIN is set never opens the
wallet without one. Dice entropy (`DiceScreen`, `mnemonicFromDiceRolls`)
refuses a skewed roll by chi-square before generating anything.

**The two sources stay apart and are never mixed.** Dice produce a seed from the dice alone; the
automatic path produces one from the device's CSPRNG alone. Mixing looks like the safer default, and
it is refused for three reasons.

- **Somebody who reaches for dice is somebody who does not trust the handset.** Mixing reintroduces
  exactly the dependency they were avoiding, which makes the feature answer a different question
  from the one it was asked.
- **Dice alone stay checkable.** The same rolls reproduce the same seed in any BIP39 tool, so a user
  can verify the app did not substitute anything. Mixing removes that, because the result becomes
  unverifiable by anyone and trust returns to the code.
- **The gap mixing would close is already narrowed.** `mnemonicFromDiceRolls` refuses a skewed roll
  by chi-square before generating, so a loaded die does not get through. What remains uncovered is a
  user inventing a sequence that looks random, and somebody doing that has chosen not to use dice at
  all, which no mixing repairs.

The Coldcard precedent reads the other way at first. Their firmware mixed, and that is what saved
users whose device RNG was weak. Dice alone reach the same outcome for that case by a shorter route,
because the weak source is not consulted at all. Mixing buys protection against the *dice* being
bad, not against the *device* being bad.

Do not revisit this blind. Changing seed generation without a handset is the trap `AGENTS.md`
records under storage and entropy hardening.

## 3. `gradle/verification-metadata.xml`

See `docs/supply-chain.md`. The file pins the three modules the store bridge brought in and trusts
every other Maven dependency. Pinning every one by checksum breaks the build on every bump and can
only be validated with a full Android build, and hardening applied without that validation turns
into a regression (the `SECURE_HARDWARE` trap in `AGENTS.md`).

## Discarded as theatre

Recorded so it does not come back to the table.

- **A statistical test over the entropy output.** The Yasmarang PRNG passed Coldcard's own distinct
  bytes test. No chi-square detects that class of bug; only checking *which source was used* does.
  `__tests__/seed.test.ts` notes this above its entropy audit.
- **A per-byte sentinel on the entropy draw.** It would reject about 6.1% of honest 12-word seeds
  and 11.8% of 24-word ones (each of the 16 or 32 bytes hits the sentinel with p=1/256). Refusing at
  random to create a wallet is exactly the shape of the Keystore regression. The zero-tail check
  uses 4 bytes, which a healthy draw trips with probability 2^-32.
- **Comparing `globalThis.crypto.getRandomValues` against the polyfill's export.** It cannot be
  implemented, because `react-native-get-random-values@2.0.0` exports nothing and only assigns to
  `global.crypto`.
- **XOR with a second entropy source of the app's own.** XOR is only "never worse" for independent
  sources, and a second module in the app draws from the same kernel pool. It costs code and gains
  nothing against risk 2.
- **Moving seed generation into a native module of the app's own.** It trades npm's surface for
  CocoaPods and Gradle's, which is *less* verified, and does not touch risk 2.

## Currency symbol position (prefix or suffix), resolved

The side of the symbol belongs to the app language, as in CLDR, and not to the currency. The feed's
own placement (a `template` or a `position`) is its home country's habit, so `sparkListFiatCurrencies`
(`wallet/spark.ts`) does not carry it and `formatFiatGeneric` (`wallet/fiat.ts`) never sees it.
German writes `1.234,50 kr`, English `kr 1,234.50`, and both write the same krona. The currency
supplies the symbol and the number of decimals, and the language supplies the side, the spacing and
the separators (`docs/i18n.md`). `__tests__/fiat.test.ts` checks the placement against CLDR in every
shipped language.
