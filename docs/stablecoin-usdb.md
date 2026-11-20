# USDB and the stablecoins on Spark

How the app deals with Spark tokens (BTKN), USDB above all. Covers sending, invoicing, the stable
balance and the rewards, and records what is deliberately left out. DePix, the token pegged to the
Brazilian real, is a regular known token on Spark and not a stable balance.

## What exists on the network (measured, not assumed)

The only dollar stablecoin on Spark is **USDB**, issued by **Brale** (a licensed US entity, backed
1:1 by T-bills) and traded on **Flashnet**. The primary source is `flashnet.xyz/api/tokenlist`,
which returns a single token. The stable balance stays on USDB alone (`buildConfig` passes it by name, never the whole
registry, because the SDK refuses two tokens under one label).

**There is no USDT on Spark.** "Native USDT on Bitcoin" refers to **RGB**, a different protocol,
unrelated to Spark. USDC and USDT appear in the app only on **cross-chain routes**, as a
send destination or as a receive source converted on arrival, never as a balance.

The USDB identifier (the bech32m `btkn1...` form, which is what the SDK APIs expect, since the hex
does **not** work) lives in `src/wallet/tokens.ts`, a single source read from three places: the
converter, the SDK config and the rewards lookup.

## The units, which are bug source number one

| Context | Unit |
|---|---|
| `SparkSendQuote.amount` and `.fee` without `tokenIdentifier` | sats |
| `SparkSendQuote.amount` and `.fee` **with** `tokenIdentifier` | the token's base units (USDB has 6 decimals) |
| `sparkReceive(amount)` without a token | sats |
| `sparkReceive(amount)` with a token | the token's base units |
| `SparkCrossChainQuote.amountIn` | what **leaves**, in the unit `source` names: sats or USDB base units |
| `SparkCrossChainQuote.feeSat` | sats |
| `SparkCrossChainQuote.estimatedOut` and `.feeAmount` | base units of the destination asset, what **arrives** |

There is no view in sats of a token send. The SDK denominates everything in base units, the fee
included. Confirmed in the `.d.ts` (`SendPaymentMethod.SparkAddress.inner.fee`: *"Denominated in
sats if token identifier is empty, otherwise in the token base units"*) and in the Breez docs.

This is why `sparkPaymentToHistory` reads `details.tag === 'Token'` and fills `asset`. Without it, a
send of 10 USDB would appear in history as **"10 sats"**.

A list row states a known pegged token as money through `rowAmountText` in `history.ts`, and the
detail keeps the exact figure with its ticker. Only the identifier decides, by `knownToken`, so a
token that calls itself USDB keeps its ticker. Under a cent the row stays exact, since `formatFiat`
would draw zero, and a send or receive that converted reads as money only once the conversion
finished on a figure the SDK reported, never on a quote. A conversion's own row keeps its units.
A token fee is `asset.fee`, in the token, and absent when the SDK recorded 0, which it writes on
every token payment without working one out.

A conversion reaches the history as a receive, the leg the AMM pays back, and reads as converted
rather than received. The two kinds carry it differently, as read from a device on 2026-09-28. The
stable balance sweep comes with `conversionDetails`, a step from sats to USDB. A conversion to the
wallet's own address, which is how Convert runs, has no `conversionDetails`, only AMM
`conversionInfo` on its details with the purpose `SelfTransfer`. The leg that paid into the pool is
linked to it by the SDK and hidden from `listPayments`, so the row shows what arrived. A refund from
the pool carries AMM info with no purpose and stays a receive. A conversion's amount carries no sign,
in the list and in the detail, since nothing left the wallet.

What each kind says (read from the SDK source at 0.26.0, `utils/payments.rs` and
`token_conversion/flashnet.rs`, not measured on a device):

| Row | `conversionDetails` | What the app can show |
|---|---|---|
| Dollar wallet on or off, the received leg | status and one AMM step | both sides, both amounts, the fee on its side, automatic |
| Convert (`SelfTransfer`), the received leg | none | what arrived. A token that arrived was bought with sats, in an amount the SDK does not expose; sats that arrived do not say which token paid. The fee is on the token's leg, so it shows only when the token is what arrived. The conversion note below fills the rest on the device that ran it |
| A real receive dollar mode took | `Pending` with no steps, then `Completed` with the step, or `Failed` | a receive, with the conversion's state and, once done, its two sides |
| A send funded by a conversion | status and the AMM step | a send, with the conversion's two sides |
| A conversion that did not land | none, on the sent leg | the leg that left, marked `RefundNeeded` or `Refunded`, read as not delivered, and later a refund receive |

The SDK links the two legs, but only a payment with a conversion status gets the step rebuilt, and
a self-transfer never receives one, so the leg that left a Convert is out of reach of `listPayments`
and `getPayment` alike. Each conversion is one row, the leg that arrived. Its fee is the one the SDK
gave: a side's `fee` is 0 both when nothing was charged there and when the swap's fee was never
learned, so a zero draws no line, and the leg's own `fees` is never shown as the conversion's cost.

So the Convert path keeps a note of what the SDK quoted (`src/wallet/conversionNotes.ts`). Once
`sendPayment` returns, it writes the estimate's `amountIn` and `fee` with the two assets, under the
wallet that ran the send, keyed by the returned payment's id. For a self conversion that payment is
the received leg, read back by its id (`complete_conversion_and_send`, `sdk/payments/conversion.rs`),
and the sent leg's parent is that same id, so the id is the listed row's, in full: a transfer id for
sats, `{hash}:{vout}` for a token. Nothing matches by time or amount.

- The SDK outranks the note field by field. The note fills what left and, only when the SDK reports
  no fee on either side, the fee. A row naming another asset than the note is not its conversion.
- Every figure from a note is a quote. A conversion by minimum output is priced again at send, so
  what left can differ from the note by the slippage allowed. The row draws it as approximate, the
  detail labels it, and a quoted fee is `quotedFee`, never a side's `fee`.
- The write is detached from the send and logs nothing but that it failed, with no amount or id.
- The file is one document per device, keyed by wallet, through `durableFile`, with the latest 200
  notes of each wallet. It is written over when torn, since a lost note costs only the display. With
  no note, as on a second install, after a restore or past the bound, the row shows what the SDK
  gives. `removeWallet` forgets a wallet's notes. Nothing syncs them.

The pool's delivery starts its claim before the swap's answer lets the SDK write the AMM info on it,
so `PaymentPending` reaches the app as a bare transfer, and the success is then held back as a
conversion child. A bare Spark or token transfer is therefore not announced while pending, or the
notice would stay up with nothing to take it down. Its success can land bare as well, before the
swap's answer, or on a second install before real-time sync brings the info. So a bare Spark or token
receive that settled waits `CONVERSION_INFO_WAIT_MS` and is read again through `getPayment`: conversion
info on it means nothing is announced, still bare means it is announced that much late, and a failed
read announces it, since History holds the record. A wallet moved or a connection changed during the
wait announces nothing. Lightning, deposits, invoiced transfers, HTLC and cross-chain name who paid, so
they announce at once. Each subscription announces a payment once, however many events arrive.

## Stable balance (the "dollar balance")

Two distinct pieces, and confusing them breaks the feature:

- **`Config.stableBalanceConfig`**, at `connect`, declares **which** tokens are eligible. The app
  always declares USDB, with `defaultActiveLabel: undefined`.
- **`updateUserSettings({ stableBalanceActiveLabel })`** is the **runtime switch**.

`defaultActiveLabel` stays **off deliberately**, because turning it on by itself would convert
somebody's balance without asking, and deciding what a user holds is not a non-custodial wallet's job. Turning
it off also moves funds, converting back to BTC, so both directions are the user's deliberate act.

On, the SDK converts sats received above a threshold and converts back at payment time. The
conversion is a swap on Flashnet's AMM, **signed on the device**.

**The switch belongs to one install, its effect to the whole seed.** The label lives in that install's
SDK storage (`stable_balance_active_label`). It is not on Spark and not in real-time sync, whatever
the doc page on user settings says about instances sharing them (read in the SDK 0.26.0 source). An
install with it on sweeps any sats the wallet holds, including sats another install made, and an
install with it off never converts unasked. No field reaches across installs, so the app cannot
prevent this. `stable.deviceOnly`, a line of its own under the switch, and `stable.confirmOnBody` say
so in every language.

## Converting one token into another (USDB to DePix)

The SDK converts only between bitcoin and a token (`ConversionType` is `FromBitcoin` or `ToBitcoin`),
so Convert runs a pair of tokens as two legs through bitcoin, each a send to the wallet's own Spark
address, as every conversion here is.

- **Quote.** The first leg spends the typed amount of the source token for bitcoin, and the second
  spends what the first gives for the destination token, both through `sparkPrepareConvertBySpend`.
  A token spent into sats is quoted by its exact input: with the token id and an amount in its base
  units the SDK quotes the sats for that input and converts exactly it at confirm (`AmountIn`), the
  shape Breez's own mainnet tests use. An exact output reaches the spend only to within one sat of
  token, which Max would leave behind. Bitcoin spent into a token keeps the search for the
  output that costs the spend. No exact output exists across two pools, so a pair typed on the
  receive side spends the source's estimate of it, then once more scaled by how far the first quote
  fell short. The review keeps its rows: what leaves is the first leg's input, what arrives is the
  second leg's output, the rate reads in the destination token, and the one fee row is the cost of
  both legs together, read against the spot rates of each peg.
- **Confirm.** Confirm first asks the SDK whether the stable balance is on, since the screen's context
  can lag it. The first leg runs through `sparkConfirmConvertLeg`, which returns the amount that
  arrived; a conversion to the wallet's own address returns once the converted side has landed (SDK
  0.26, read from its source). The second leg is quoted again on those sats rather than on the
  review's estimate, and it runs only if it spends no more than arrived and lands within 2% of what
  the review showed, since each leg allows 1% of slippage.
- **A throw is read against the balance.** The SDK can raise its 30 second wait after a swap already
  ran. A first leg that throws with the source balance lower stops in bitcoin; one that throws with
  the balance untouched is an ordinary failure. An ordinary failure, thrown or answered as `failed`,
  keeps the amounts, says "Could not convert" and quotes them again, so Convert is offered once more
  on a fresh handle (the old one is spent). A second leg that throws after its sats left waits
  for the destination token like a success. When the wallet cannot be read at all, the screen asks the
  user to check the balance instead of saying where the value is.
- **Stopping in bitcoin.** When the second leg cannot run, the value is bitcoin in the wallet and the
  screen says so, instead of "Could not convert", which would read as if nothing had moved. The form
  then offers bitcoin to the destination token, the leg that is left.
- **A single leg into bitcoin asks too.** A token into bitcoin leaves the sats the mode sweeps, so it
  runs only on the SDK's own off. The mode on is refused with the same message as a pair, and an
  unknown mode fails as any confirm does, with nothing spent. Bitcoin into a token leaves nothing
  loose and asks nothing.
- **The switch has one writer and one sheet.** `useStableSwitch` is the only caller of
  `sparkSetStableBalance`, and moves only with the SDK connected to the active wallet.
  `StableConfirmSheet` stands in front of both directions from the dollar screen and from Home, and
  quotes the whole balance on open through `estimateSwitchCost`. The quote is dropped on arrival, and
  the cost comes from `effectiveConvertCostPct`, never from the quote's fee. No figure on a balance
  that is not synced, on a failed quote or past 10 s, and Confirm stands in all three, since leaving
  the mode cannot depend on a provider.
- **A dollar wallet asks, reads and sends in dollars, and the invoice stays in sats.** Send and Receive
  open the amount sheet in US$ when the dollar wallet has a rate, and the SDK is always asked in sats.
  The unit is decided as the sheet opens, so a rate landing later changes neither the unit nor the
  digits. Any figure in dollars made from sats carries `≈`, a figure of USDB is exact, and under a cent
  the sats lead. Arrivals say `≈ US$ 12,30` over the sats and nothing about a conversion, which comes
  after the announcement and under the minimum never comes. What leaves on a converted send is
  `conversion.amountIn` alone: the SDK covers the leg with it (`ensure_token_balance_covers`), and the
  cost is a separate line from the amounts at spot, never added.
- **Use all on a dollar wallet** is the recipe in the SDK's Stable balance page: the full USDB balance
  in, `FeesIncluded`, `ToBitcoin`. The chip shows only on a synced figure, with the SDK saying the mode
  is on, for Lightning and LNURL. `sparkPrepareSend` and `sparkPrepareLnurlPay` take `dollarBalance`
  for it and answer in sats. The SDK sweeps the sats too only when the amount still equals the balance
  at prepare, so the review states what the SDK says arrives, not what the person pressed for.
- **In dollar mode, only into dollars.** The stable balance converts loose sats into USDB once the
  balance passes its threshold, and between the legs the sats are loose. A pair into USDB therefore
  runs its first leg alone and lets the mode do the second: the second leg's quote only sizes the
  review, which shows what arrives as an estimate, and is discarded at confirm. Any other pair would
  find its sats gone into USDB after two spreads were paid, so Convert does not offer it. The screen
  opens on a held token into USDB, the send side lists held tokens other than USDB, and the receive
  side is USDB. With no token to turn into dollars (the mode turning on while the screen is open) the
  form is bitcoin into USDB, which the mode does anyway. The context can lag the SDK, so confirm asks
  the SDK: on with a pair into USDB takes the dollar path, on with any other pair is refused with a
  message that does not suggest turning the mode off, because that converts the whole balance. A run
  of the loading effect that moves the sides drops what was typed and any review, except while a
  confirm runs, since the confirm's own leg can be what brings the context up to date. Home shows
  Convert in dollar mode only while the wallet holds a token other than USDB, and a pegged remainder
  under a cent, which is what a conversion leaves behind, does not count.
- **What the dollar success shows.** The sweep lands tens of seconds after the first leg, so the
  screen waits on the balances for up to a minute, from a read taken at confirm, since the sweep lands
  30 to 50 seconds after the leg and the 28 second wait of other conversions mostly ended on the sats.
  The mode sweeps every loose sat at once, at one price. A rise in USDB while this leg's sats are still
  loose comes from elsewhere, a sweep of sats that were already loose or an incoming payment, and moves
  the baseline. Once fewer sats remain than the leg brought, the rise from the baseline is the sweep
  that took them, and this leg's part of it is its part of the sats swept, so sats that were waiting
  and went in the same sweep are not counted. When the wait runs out first the success shows the sats
  that arrived, which the Home line then counts as waiting to become dollars. After a first leg that
  threw once the token had left, the leg's sats are unknown, so they count as gone once the sats are
  back where they were at confirm, and the sats shown are read from the balance. When neither balance
  moved the screen asks the user to check it. Cancel does nothing while a confirm runs.
- **Minimum and range.** The range and the Min chip take the larger of the two legs' minimums, the
  second leg's sats priced in the source token. This holds for every conversion: the range line reads
  a token at two places, the minimum rounded up and the balance rounded down, with more places only
  when two would put them out of order (`rangeBounds`), so the figure shown as the minimum always
  passes and the maximum never promises more than is held. Min fills that rounded-up figure, up to a
  cent above the real minimum, and Max fills the exact balance.
- **A single choice is a fact.** In either mode, a side whose list holds nothing but the asset it
  shows is drawn without a chevron and opens no list, per the design system.

Measured in the iOS simulator against mainnet, DePix into USDB with the dollar wallet on, three runs
of 4 to 5 DePix each. The USDB that arrived matched the review to within 0.0003 USDB, apart from one
run where the sweep also took a few sats already waiting and arrived at the review's figure plus
exactly those sats. The success showed 43 seconds after confirm, and in the three runs the sweep
landed within the same minute as the first leg.

Measured with the exact input: Max, and a typed amount of two decimals, each left 0 DePix in the
wallet, where the exact output had left between 0.00016 and 0.0044 DePix. With the minute's wait the
success showed 48 seconds after confirm, past where the old wait would have shown sats.

**Timing the wait needs healthy JS timers.** With screen freezing on, React 19 loops on the hidden
screens, as the Traps in `AGENTS.md` explain, and every JS timer stands still while it does. In a dev
build and in a release build, 1 in 5 to 7 conversions after a visit to the
dollar wallet held the success up for 14 to 54 seconds, against none of 22 before the visit. With
freezing off, none of 18 did in the dev build and none of 18 in the release build, where 4 of 21 had
before. Why the visit matters was not measured. Before timing anything in this path, record a 500 ms
interval and check that it fires on time.

Measured in the iOS simulator against mainnet, with a wallet not in dollar mode: about 1.5 USDB
became the DePix amount the review showed, with the bitcoin balance unchanged before
and after, so the second leg spent the first leg's sats whole. Not measured: a failure between the
legs, which a device cannot be made to produce on demand.

## USDB rewards

Flashnet pays **3.5% to 6% a year** in sats, daily at 00:00 UTC, **straight to the holder's wallet**.
Minimum 10 USDB, cap 500,000, calculated by TWAB. The rate comes from the protocol's 24h volume, not
from the user's balance. Flashnet pays it out of protocol fees, not out of the backing, and Brale's
1:1 redemption stands even if the rewards stop.

`src/wallet/rewards.ts` only **reads** (`rewards.flashnet.xyz/v1`). The pubkey is validated before it
becomes a URL. The app implements neither the endorsement or delegation call
(`POST /v1/rewards/:pubkey/endorsements`) nor any host fee or volume bonus on Flashnet swaps.

The UI presents USDB as **protection against volatility**, never as an investment. No "yields",
"invest", "deposit into", "profit". The rewards appear as a fact about the token, with explicit
credit to Flashnet.

## Cross-chain (sending USDC or USDT to Solana, Tron, EVM)

`Config.crossChainConfig` is **opt-in**, since the SDK default is `None`, off, because the providers
run background work. In the flow, `parse` recognises the address, `getCrossChainRoutes` lists the
routes, the user picks **which chain and asset arrives** (an EVM address resolves several chains, so
guessing is unacceptable), `PaymentRequest.CrossChain` prepares, and the device signs. An address with
one chain and asset to speak of skips the list (`groupRoutes`), on a first look only: after a refusal
the list stays, since choosing alone would pay on a network nobody saw. The review always names the
chain and the asset, with the token's contract one press away.

**Two providers on one chain and asset are one line on the list.** Both quote once the amount is in,
waiting up to the 15 s of a quote refresh, and the review marks who delivers more, compared only on
equal decimals. One that fails goes quietly. Whatever was quoted and not chosen leaves `preparedSends`
through `sparkDiscardSendQuote`, a late answer included. Boltz is not registered at SDK 0.26.0, so
today this path runs only in tests.

The providers are **Orchestra** (Flashnet, accepting sats or USDB as the source) and **Boltz** (sats
only, through a reverse swap), on mainnet only.

**If a provider goes down**, `getCrossChainRoutes` returns fewer routes and the other provider's
still work. With both down the list comes back empty and the screen says no network is available
rather than breaking, and there is a test for that. **Nothing else in the app depends on Boltz.** On
Spark, Lightning, on-chain, Spark transfers and the BTC to USDB conversion do not pass through it
(Lightning uses Spark's own interop, and the conversion uses Flashnet's AMM).

A conversion that fails midway **needs no button**, because the SDK runs a periodic refunder
(`refundPendingConversions`) on its own while `backgroundTasksEnabled` is `true`, which it is in the
app's config (the SDK refuses a stable balance config otherwise).

The route id **includes the address**. Without that, a stored id from an earlier destination would
resolve to the right route with the **wrong address**, sending money to the wrong place with no
visible error.

**The source decides the unit of `amount`** (`crossChainSource`, `crossChain.ts`). A dollar wallet on
a route that lists USDB pays in USDB: `amount` is USDB base units, `tokenIdentifier` is USDB, the quote
comes back with `source: 'usdb'` and its `amountIn` in USDB. Everywhere else `amount` is sats and no
token goes in. A dollar wallet short of sats on a sats-only route still gets a quote, because the SDK
adds the conversion on its own, and `conversion.amountIn` is what the balance is weighed against.

**A token never goes in on a route that takes only sats.** With the stable token active the SDK falls
into `prepare_token_denominated_fees_excluded`, which reads `amount` in the route's decimals, 12 orders
of magnitude off on an 18-decimal route. `sparkPrepareCrossChainSend` refuses that before the SDK, by
identifier, and a token merely named USDB does not count. The source travels with the typed amount and
is held in `crossChainAsked`, so a retry, a refresh or the mode changing with the sheet open never
reads the digits in another unit.

**A send with a token leg is never repeated after an error.** Both USDB sources, the direct one and
the conversion, have no idempotency at the Spark protocol layer (`guide/cross_chain.html`, Retry
safety), so a second send could pay twice. The only way back is a new quote after `quoteExpired`,
which moves nothing.

The Breez docs do **not** document exact-out, so "send exactly 50 USDC" is left out. **What the USDB
source does on a real route, and which routes take it, is pending validation on a device.**

**Route bounds (SDK 0.26).** Each route lists the Spark assets it accepts, each with its own bounds
(`CrossChainAcceptedAsset.limits`), because the same endpoint has a sats floor when funded with BTC
and none when funded with USDB. For sats the app reads the `Bitcoin` entry: `minAmount`/`maxAmount`
are **sats**, and `minUsdCents`/`maxUsdCents` bound the order value in US cents. The keypad applies the
tighter of each pair (`crossChainBoundsSat`), converting the dollar band at the SDK's own USD rate, and
skips the dollar band when no rate is available. The floor rounds up and the ceiling down. For USDB it
reads USDB's own entry, already in dollars (`usdbMin`, `usdbMax`), which needs no rate. A route can still enforce tighter bounds than it publishes, and the SDK caches
them for an hour, so the refusal path stays: `SdkError.CrossChainAmountOutOfRange` (`tooSmall`) and
`SdkError.CrossChainRouteUnavailable` (`temporary` means busy, retry; otherwise pick another network,
and the screen drops that one from the choice). Both are read by `tag`, since the RN error message is
only the class name.

**18-decimal assets.** USDC on BSC has 18 decimals, past what a double holds exactly, so the review
caps the places it shows at 6. The cap is display only, because rounding an amount the user will
spend could round it above the balance.

## Receiving USDT/USDC from another chain (SDK 0.26)

USDT and USDC sit on the Stablecoins side of Receive. SDK 0.26 has the pieces that make it usable:
route bounds, a second quote when gas eats the amount, a typed error for a busy or refused route, and
`PaymentMetadataUpdated` announcing where an arrival came from. The quote is measured on the
simulator against mainnet; an actual arrival is not (see the pending list below).

**Who holds the money at each step** (checked against the three conditions in `docs/principles.md`):

1. The app asks for a quote. The SDK, on the device, asks the provider (Orchestra, run by Flashnet)
   with this wallet's own Spark address as the recipient. Nothing is held; no Voltz server takes
   part.
2. The payer sends USDT/USDC to a **deposit address that belongs to the provider**. From here the
   provider holds it.
3. The provider converts and pays this wallet's Spark address, as sats or USDB. The device claims
   the transfer with its own key.

Voltz is in no leg and adds no fee, and the SDK leaves no room for an app fee on this path.

**What the person does.** Receive, the `Stablecoins` segment. The coin comes first, from the Asset
picker row (the wallet's pegged tokens, such as USDB and DePix, plus USDT and USDC), and for USDT or
USDC its network follows, each with its official mark, the way an exchange withdrawal form asks. The
network opens on the last one received on, else on the network the previous coin was on, else on the
first route. The keypad opens on a tap of the amount link, never by itself, and nothing is quoted
until an amount is typed, because the SDK mints no address without one. The typed amount is what
lands (`FeesExcluded`, the SDK default). The screen then draws the receive card (QR, address, and
here tap to copy, since this panel copies two values), the figures in label and value rows as on the cross-chain
send review (amount to send, which copies; what lands; how long the price holds), and the
single-network warning in the app's warning box. The marks are web3icons (MIT), except Base, drawn
from its official square because the package's round variant reads as a white box.

**What lands follows the dollar wallet.** It is USDB when the dollar wallet is on and the route
accepts it, and bitcoin otherwise; a route that delivers only one of them decides alone
(`pickReceiveLanding`). The landing
is always passed explicitly, because the bounds are per landing asset.

**Units, and why bigint.** The amount is in the paid asset's base units (`route.decimals`). USDC on
BSC has 18 decimals, and a double gets short amounts wrong there (`1.1` by 128 base units, while
`50.12` happens to survive), so the amount and the deposit amount travel as strings and bigint
(`toBaseUnitsExact`, `formatBaseUnitsExact`), never through a Number.

**QR versus copy.** On EVM routes the SDK returns an EIP-681 URI, which a wallet like MetaMask
fills in from the QR. Copying gives the bare deposit address, because an exchange withdrawal form
does not take a URI. The "send exactly" line copies the amount.

**Every quote is single use.** The address is minted per quote and the price holds for about two
minutes, so nothing is cached. After expiry the SDK still watches the old address for 24 hours, and
the provider may reprice a late payment or refuse it; that is its call, not a promise the app can
make. So once the price expires the screen hides the QR, the address and the amount, stops sharing
them, and offers Update, which quotes afresh.

**Bounds on the keypad.** The route bounds what the payer sends, and under `FeesExcluded` that is the
typed amount plus the provider's fees. Its floor is therefore safe to apply to the typed amount (it
only ever refuses too early) and its ceiling is not, so the keypad carries the floor alone and the
SDK's `CrossChainAmountOutOfRange` answers past the ceiling. The keypad also stops taking digits past
the asset's places. The floor travels in base units as well (`receiveBounds`, the sheet's
`tokenBounds`): the keypad compares the typed figure in base units and draws the floor rounded up
to the cent, so at 18 places a floor one base unit past five dollars reads 5.01, and 5 is refused
before any address is minted.

**Fees are the payer's, and they vary a lot by chain.** A measured quote for a 5-dollar receive
landing as USDB asked the payer for 8.459026 USDT on Tron to land 5.03 (3.43 in fees, 68%), and for
5.065454 USDC on Base to land 4.99 (0.075, 1.5%). The screen shows both numbers side by side.

**The warning is not decoration.** One `0x` address exists on every EVM chain. A coin sent on the
wrong chain goes to a provider address nobody watches there, and whether it can be recovered is
not measured.

**What the app cannot see.** There is no "payment seen on Tron" state, since the first event is the
Spark transfer arriving. A provider refusal or refund closes the order inside the SDK with no
payment and no event, so the app has nothing to show. A refund goes to the source address only when that is
safe, never to an exchange's address, so a failed exchange withdrawal becomes a manual case with the
provider. Nothing in the UI promises otherwise.

**On arrival** the received overlay shows the landed asset in its own unit, never its base units as
sats, and the history detail shows a "From" row reading "USDT on Tron" and the funding transaction
on that chain, both read from `conversionInfo` (`Orchestra`).

## Not measured on the real SDK

- sending and invoicing in USDB, including the format of a Spark token invoice;
- the real unit of the fee on a token send, read from the types rather than observed;
- turning the stable balance on and off, and the whole-balance conversion the switch triggers (the
  sweep of loose sats is measured, see the token conversion above);
- whether `getCrossChainRoutes` answers without `crossChainConfig` having been used before, how long
  a cross-chain quote (`expiresAt`) really lasts, and whether its `amount` is in fact sats at the
  source;
- whether the wallet's `identityPubkey` is the pubkey Flashnet indexes for rewards;
- a real cross-chain receive, with its arrival time, the real fee against the quote, and whether the
  overlay and the history source line show as tested. Two open questions ride on it, because the
  provider's docs say a payer on Tron or BNB Chain needs a refund address, which the SDK does not
  send, and that a route may return a deposit memo, which the SDK does not model.

The cross-chain send bounds are measured on the simulator against mainnet with SDK 0.26.0. They read
live as "Between 1,200 sats and 190,176,396 sats" for USDC on Base, and an amount under the floor is
refused inside the keypad without a quote.
