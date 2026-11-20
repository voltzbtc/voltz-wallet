# The Breez SDK Spark binding

The app runs on `@breeztech/breez-sdk-spark-react-native`, a React Native binding generated with
UniFFI from the Rust SDK. Only `src/wallet/spark.ts` imports it. This page collects what the binding
does that its documentation and its install step do not make obvious.

## The types are the source of truth

The official documentation at <https://sdk-doc-spark.breez.technology/> describes the SDK for many
languages, and its examples do not always match the React Native binding. Read the documentation
for concepts, then check every signature in the generated declarations before writing code:

```
node_modules/@breeztech/breez-sdk-spark-react-native/lib/typescript/module/src/generated/breez_sdk_spark.d.ts
```

When the two disagree, the declarations win. The shapes that most often differ from the examples:

| The example suggests | The binding has |
|----------------------|-----------------|
| `getInfo()` as a module function | `connect()` resolves to a `BreezSdkInterface`, and `getInfo(request)` is a method on it |
| `balanceSats` as a number | a `bigint`, converted explicitly before any arithmetic or formatting with numbers |
| variants passed as strings | enums and tagged classes, such as `ReceivePaymentMethod.Bolt11Invoice`, `PaymentType.Receive` and `SdkEvent_Tags.PaymentSucceeded` |
| events as plain objects | `SdkEvent` is a tagged union, so code switches on `event.tag` and reads the payload from `event.inner`, as in `event.inner.payment` |

## The binding is asynchronous

The methods of the SDK interface return Promises and do not block the JavaScript thread. That is why
`spark.ts` calls the package directly, with no native wrapper module and no background offload of
its own.

## One connection at a time, and only the wanted one

Every wallet shares one storage directory, and the SDK requires each running instance to have its
own ([Initializing the SDK](https://sdk-doc-spark.breez.technology/guide/initializing.html)). So
`connectSpark` and `connectActiveSpark` are served one at a time in `spark.ts`, in the order they were
asked for, and a connect opens an instance only after the live one is disconnected and the SDK has
answered that disconnect.

A request is cut loose when a newer one wants another wallet, or a disconnect. A cut request rejects
with `SparkConnectSuperseded` at once, whatever it was waiting on, and the next request is served. It
never publishes: a native connect already under way still lands, and its instance disconnects itself.
An instance whose landing check cannot read the registry disconnects itself too, and its request
fails with the registry's error rather than as superseded, since no newer request is behind it to
bring the screen's next load. A request for the active wallet reads the registry when its turn
comes and again when the connect lands. `sparkConnectedWalletId`, `connectedLnurlDomain` and the
live connection change together, and with nothing connected the domain is undefined, never the
closed wallet's.

One seed never runs twice. A request for a wallet whose earlier instance is still landing waits for it
to land and disconnect itself before opening another. The wait is bounded by `LANDING_WAIT_MS`, after
which the request fails with `SparkConnectBusy`, whose message classifies as offline, and nothing is
opened. `disconnectSpark` never waits for a connect: it cuts every request loose and disconnects the
live instance.

A connect of another wallet does not wait for a cut instance still landing, so a native connect that
never answers cannot stall the next wallet. Until the late instance lands and disconnects itself, two
wallets' instances then run at once on the same directory. `__tests__/connectTurn.test.ts` holds each
of these.

## Tokens are looked up by identifier only

Spark has no browsable token registry. `getTokensMetadata` takes a list of identifiers and returns a
`TokenMetadata` for each one it knows (identifier, issuer key, name, ticker, decimals, maximum supply,
whether it is freezable), in no guaranteed order. That is the only lookup, so a token is added by
pasting or scanning its `btkn1...` identifier, and `sparkResolveToken` in `spark.ts` matches the
answer by identifier. A name or ticker proves nothing, since anyone can issue a token under any name.

`TokenMetadata` has no icon field. A token's logo is bundled with the app and keyed by its
identifier in `components/AssetIcon.tsx`, and a token without one shows the first letter of its
ticker.

## `signMessage` refuses the `breez-lnurl:` namespace

The SDK reserves messages that start with `breez-lnurl:` and refuses to sign them, failing with
`InvalidInput` before anything reaches the network. A refusal there is not a server answer. Every
statement the app signs with the identity key (`sparkSignMessage`) starts with its own
`voltz-<purpose>:v<n>` prefix, such as `voltz-domain:v1`, `voltz-name:v1`, `voltz-onboard:v1` and
`voltz-push:v4`, which also keeps a signature made for the lightning address gateway from being
replayed against the LNURL server's routes. Each format mirrors, byte for byte, what the server
verifies, so changing it on the app side alone leaves the app's suite green while every request
fails signature verification.

`sparkSignMessage` also takes the pubkey the request sends, and signs only on a connection whose
identity is that pubkey, so a reconnect to another wallet between reading the identity and signing
ends as without a connection. `identitySigner` hands out the pubkey and a signer bound to it.

## A refusal from the LNURL server arrives as `NetworkError`

SDK 0.27.2 turns every answer of the LNURL server other than 2xx or 401 into `SdkError.NetworkError`
(a 401 becomes `InvalidInput`). On React Native the error's `message` is only the class name,
`SdkError.NetworkError`, so a check on `err.message` never sees why the server refused. The status
and the body travel in `inner[0]`:

```
network request failed with status 403: {"error":"change_limit_reached"}
```

The lightning address gateway answers its refusals as JSON with an `error` code, and
`gatewayRefusal` in `src/wallet/lnRefusal.ts` reads that code out of the body. It gives nothing for a
body that is not JSON, such as an edge error page, or for a `NetworkError` raised before any request
got an answer. Moving an address between wallets reads its refusal this way. Every method that talks
to the LNURL server fails in the same shape, `registerLightningAddress` included.

The wording comes from the SDK's `From<LnurlServerError> for SdkError`
(`crates/breez-sdk/core/src/error.rs` at 0.27.2), not from the binding's types, so an SDK upgrade can
change it without any compile error. The move then falls back to its generic message. The fixtures
in `__tests__/lnRefusal.test.ts` and `__tests__/lnAddressScreen.test.tsx` copy the 0.27.2 wording,
so the suite stays green through that change, and an SDK upgrade rereads that function.

## A lightning address call ends only at the SDK's 60 s timeout

Every call to the LNURL server (`getLightningAddress`, `checkLightningAddressAvailable`,
`registerLightningAddress` and the rest) goes through the SDK's own HTTP client, whose requests time
out after 60 s (`REQUEST_TIMEOUT` in `crates/platform-utils/src/http/mod.rs` at 0.27.2, applied per
request in `http/client.rs`). A server that stops answering therefore holds each call for a minute,
and the generated-name loop makes up to 15 of them. `spark.ts` runs every address change in one
turn, so an automatic work stops starting calls `ADDRESS_TURN_LIMIT_MS` after its turn began and ends
with nothing, while the call in flight is left to settle, never abandoned, so two registers never
run at once. The customer's own register is one call and is never cut.
`__tests__/addressTurnLimit.test.ts` holds this.

## A register or a claim names its own description

Up to 0.27 the SDK wrote `Pay to name@domain` when `description` came undefined (`default_description`
in `sdk/lightning_address.rs` at 0.26.0). At 0.28 it sends null and signs an empty field
(`description_field` in `lnurl-models/src/signed_message.rs`), and each route refuses that in its own
way. The gateway checks a register's signature with an absent description hashed as an empty string
rather than as an empty field, so a register without one answers 401. A transfer claim crosses the
gateway with no signature checked and reaches the LNURL server, which refuses it while it reads the
body, before any signature, when its request model takes `description` as a required string
(`String` in `lnurl-models` at 0.26.0 and 0.27.2, `Option<String>` only from 0.28). Either way
`spark.ts` writes that text itself on
every register and transfer claim, through `defaultAddressDescription`, and the mock refuses a call
without one.

## Only the first `Synced` says the wallet itself synced

At 0.28.0 the SDK holds back its first `SdkEvent::Synced` until the wallet part of a sync has
succeeded and, when real-time sync is on, until an incoming real-time sync has reported or failed
(`crates/breez-sdk/core/src/events.rs`, lines 442 to 456, the condition at 447 to 451). Every later
one is sent when any part of a sync succeeded, the wallet, the wallet state, the deposits or the
LNURL metadata, or when a real-time sync brought changes in (`any_non_zero`, checked at line 466).
`sync_wallet_internal` logs a failed `spark_wallet.sync()` and still emits the event and returns `Ok`
(`crates/breez-sdk/core/src/sdk/sync.rs`, lines 170 to 190 and 306 to 308). The binding's `Synced`
carries no payload.

Since 0.28 the failure reaches the app another way. `last_sync_error` is set from the wallet part
alone, after the join and before the event (`sync.rs`, lines 294 to 296), and comes back in both
`getInfo` and the answer of `syncWallet`. It lives in memory (`sdk/init.rs`, line 39), so each connect
clears it and unset says nothing until a sync has ended. A first sync that fails outright sends no
`Synced` at all, so a read is the only place it shows. Its message is for logs and never reaches a
screen. `last_synced_at` is written only when the wallet part succeeded, from a clock read before the
sync began (`sync.rs`, lines 146 and 291), and it lives in storage (`persist/mod.rs`, lines 1184 to
1197), so it survives every connect and dates the figure without saying anything of this connection.
The app reads none of it as proof of a sync.

`spark.ts` counts a connection as synced after its first `Synced`, and again after the first one
heard since each return from the background (`sparkNoteResumed`), each time reading `lastSyncError`
first, and a set one marks nothing. Any read or `syncWallet` answer reporting a failure moves the
connection to `stale` at once, and the next `Synced` with no failure behind it marks it again. A
`Synced` on a connection already marked reads it too, and a pull reads it once more as it ends, since
a `Synced` can end the pull while the answer waits on `collect_exit_chains` (`sync.rs`, line 878). The
second mark is still weaker than the first: a `Synced` from a real-time sync can land while the
wallet's own sync is running, with nothing reported yet, and the balance read then can be the figure
stored before the suspension. An SDK upgrade rereads these lines.

A pull's `syncWallet` answer can land long after the pull ended, since it reads `last_sync_error`
before `collect_exit_chains` and returns only after it (`sync.rs`, lines 868 and 878). Its failure
still moves the connection to `stale` (`refreshOnce` in `spark.ts`), even when a later sync succeeded
in the meantime and marked it again, so a good connection can read `not updated` until the next
`Synced`. That is a known limit, kept on purpose, because it only ever errs stale. The one proof that
a later sync succeeded is a fresh `getInfo` whose `last_sync_error` came back unset, and acting on it
would keep the mark standing while that read is in flight, the unsafe direction, and would rest on the
SDK writing the error only when a wallet sync ends, never clearing it as one starts (`sync.rs`,
line 295).

A periodic sync skipped because the last one was recent also sends `Synced`, with no network at all
(`sync.rs`, lines 150 to 159). `syncWallet` forces the sync and never takes that path, but a pull can
end on a `Synced` from that path, so it is no stronger than the mark after a resume. That path leaves
`last_sync_error` as it was, so it never clears a failure.

## A silent payment address is a withdrawal with its own kind

`parse` answers `InputType.SilentPaymentAddress` for an `sp1` address, or a `SilentPaymentAddress` leg
inside a BIP21 with an `sp` parameter, and the details are the same `BitcoinAddressDetails` a Bitcoin
address gets (`crates/breez-sdk/common/src/input/parser/mod.rs`, lines 685 and 806). `prepareSendPayment`
then answers `SendPaymentMethod.BitcoinAddress` with the usual three fee quotes (`payments/prepare/mod.rs`,
line 44), and the payment lands as a `Withdraw`, which at 0.28 carries `destinationAddress` and `vout`.
So the send and its history row are the on-chain ones, and only the review names the rail differently.

It has a kind of its own, `silentPaymentAddress`, because the two other callers of an address must not
take it: `refund_deposit` and `prepare_recover_funds` both refuse it (`spark-wallet/src/wallet.rs`, line
3526, and `sdk/recover_funds.rs`, line 1216). `isOnchainKind` in `sendAll.ts` is what the Send screen
reads. The parser takes any network's prefix and only prepare refuses it, so `spark.ts` answers
`wrongNetwork` for one that is not mainnet, which unlike `other` says nothing of the connection. A URI
that also names a plain address pays the silent payment, since the plain one is there for wallets that
cannot. The dust limit is taproot's, 330 sats (`utils/bitcoin_dust.rs`). Receiving is not in this
version, and Jest mocks `parse`, so no real `sp1` address has gone through the binding or the chain.

## A confirmed send is not a finished send

`sendPayment` answers `Pending` at once for a bolt11 invoice, since `completionTimeoutSecs` defaults to
0 (`payments/send/bolt11.rs`), and `lnurlPay` has no such option. The SDK then polls the provider for
about 185 s and reports the end only as `PaymentSucceeded` or `PaymentFailed`; after that the sync's
reconciliation moves a row older than 60 s. A Spark transfer comes back `Completed` at
`SenderKeyTweaked`, so it rarely waits at all.

`sparkFollowSend` is the one wait for all of them, instead of passing the timeout on one path. It
subscribes first and reads `getPayment` once after, so a word that came between the send's return and
the listener is read and any later one is heard. `SendSpark` says "Sent" only on `complete`, shows "On
the way" past 10 s, and a failure after that raises a notice, on the same wallet and connection only.
A notice cannot survive the process, and the row in History is what remains. No text says the balance
came back, because the failure event does not say so.

The status of a cross-chain send is the Spark side alone (`guide/cross_chain.html`, Status lifecycle).
`HistoryItem.delivery` is the provider's leg, read from `conversionInfo` or from the non-AMM step, never
from `conversionDetails.status`, which on a send funded by a stable balance conversion is that
conversion's.

## A deposit's claim error is the last pass's, not a verdict

The SDK claims every listed deposit again on each sync and overwrites `claimError` with that pass's
outcome (`sdk/sync.rs`, 0.28). Only a quote the operators refuse as below dust becomes `DepositTooSmall`;
a quote or fee read that failed on the network becomes `Generic` (`mature_quote_error`,
`sdk/deposits.rs`). A pass can skip a deposit, or fail before reaching any, with nothing reported, so a
sync that resolved says nothing about a given deposit. `claimDeposit` is no verdict either: it can throw
`Generic("transfer not found after claim")` after the provider accepted the claim, when the operators
had not listed the transfer within the SDK's three lookups (`sdk/deposits.rs`, 0.28), and it leaves the
old `Generic` stored until the next pass marks the deposit claimed.

So Home's card reads `Generic` and `MissingUtxo` as still being received. Try again reads the list, calls
`claimDeposit` with no `maxFee` (the configured ceiling, as the automatic claim; this clears a ceiling of
the deposit's own, which a later fee refusal asks for again) for each such deposit, says nothing of the
answer, and draws the read after. Since no answer is a verdict, the card never offers to send a deposit
back; its one way back is the retry of a return the person already started and the network refused. The
list is read from the device's storage, so it answers offline as well.

## A refund throws after it is signed, and leaves no payment

`refundDeposit` stores the signed refund before it broadcasts and throws when the network refuses, so a
throw does not mean nothing happened. `RefundDepositScreen` reads the list after any error and lets the
deposit's `refundTxId` decide what it says, and a throw with no list to read offers nothing. A new
`refundTxId` with `lastError` means the network refused it, and a rebroadcast at that fee will not cure
that, so the screen, Home and History all say so and offer a higher fee; only a `BroadcastPending` with
`lastError` can go again. Once a refund confirms the SDK deletes
the deposit and creates no payment, so the transaction id on the result screen is the only record.

The fee is `Fee.Fixed`, because with a rate the amount that arrives depends on the vbytes of an address
the app has not measured. `claimDeposit` does not refuse a deposit being refunded, which is why
`claimable` reads `refundTxId`. A refund and the automatic claim on the same deposit in the same instant
depend on the operators signing only one; that race is not measured.

## With `FeesIncluded`, `amount` is what leaves

The prepare response keeps the gross figure, so the fee is inside `amount` and adding it again would
refuse a balance equal to it. `sendTotal` and `sendReceives` (`src/wallet/sendAll.ts`) hold the rule. What
arrives is `amount - fee` on Lightning and Spark, `amount` less the tier on-chain, and the second
invoice's amount on LNURL, whose prepare asks the endpoint twice and fails with "Fee increased" when the
second fee is higher. The SDK refuses `FeesIncluded` on an invoice with a fixed amount.

## A JS reload while connected crashes a dev build

In a dev build `spark.ts` forwards the SDK's own log to the console through `initLogging`, once per
JS context (`initSdkLogging` and its `sdkLoggingStarted` latch). The native side keeps the first
logger it was handed for the life of the process. A reload of the bundle (the dev menu, a full
Fast Refresh reload, `curl -X POST localhost:8081/reload`) throws away the JS context that logger
calls into, while the latch starts at false again, so the second `initLogging` throws and is
swallowed. The next line the SDK logs aborts the process on a tokio thread, a `SIGABRT` in
`UniFFICallbackHandlerLogger::log` through `handle_callback_unexpected_error`. It was seen three
times on SDK 0.25.0 and not run again on 0.26.0 or 0.27.2, whose bumps left the logging path in
`spark.ts` as it was. A release build registers no logger and never meets it.

- After any reload with a wallet connected, kill the process and launch it again before trusting
  anything it shows or logs. A crash a few seconds after a reload is this, not the change under test.
- Typing into a screen with no focused field hands the keys to the app, and a dev build reads them as
  React Native's keyboard shortcuts, reload among them. A driver such as `idb ui text` types only once
  the field it means is in the accessibility tree and focused.
- A reload shows in the system log as the app fetching the bundle with
  `modulesOnly=false&runModule=true` (`log show --predicate 'process == "VoltzWallet"'`), which tells
  it apart from a lazily loaded module.

## Type checking goes through `./scripts/typecheck.sh`

The binding depends on `uniffi-bindgen-react-native`, whose runtime is published as TypeScript
sources (`typescript/src/*.ts`) rather than compiled declarations. `tsc` compiles every `.ts` file it
reaches through an import, `skipLibCheck` covers only `.d.ts` files, and `exclude` does not stop a
file that something imports. A type error in those sources, for example after a stricter TypeScript
release, therefore fails a plain `tsc --noEmit`, and no compiler option silences it.

`./scripts/typecheck.sh` runs `tsc --noEmit` and fails only on errors reported for this project's own
paths (`App.tsx`, `src/`, `__tests__/`, `__mocks__/`, `types/`). CI runs the same script, so run it
rather than `tsc` directly.

## Install with `npm run setup`, never `npm install`

`.npmrc` sets `ignore-scripts=true`, which keeps dependency lifecycle hooks from running at install
time, and `min-release-age=7`, which refuses versions published less than seven days earlier. The
binding downloads its prebuilt native libraries from a `postinstall` hook, so with scripts off that
hook runs only when asked for by name:

```bash
npm run setup          # npm ci --ignore-scripts && npm run native:fetch
npm run native:fetch   # after any other npm ci
```

Without the native artifacts the iOS and Android builds fail while the JavaScript tests still pass,
because Jest uses the mock in `__mocks__/`.

`npm ci` installs exactly what `package-lock.json` pins and does not consult `min-release-age`. The
quarantine protects the moment a version enters or moves through `npm install`, and the lockfile
protects every install after that, which makes reading the lockfile diff of a dependency change part
of the review. The npm lockfile also covers nothing that CocoaPods or Gradle download. The full
procedure is in [supply-chain.md](supply-chain.md).

## The native artifacts are not checked against the package version

`npm run native:fetch` runs the package's own `scripts/postinstall.sh`, which starts with:

```sh
if [ -d "android/src/main/jniLibs" ] && [ -d "build/RnBreezSdkSpark.xcframework" ]; then
  exit 0
fi
```

When both directories exist the script exits before downloading anything, and nothing records which
version produced them. Any path that changes the package version while those directories survive
leaves the previous native libraries in place, and running `native:fetch` again does not help,
because it reaches the same early exit. Delete both directories inside
`node_modules/@breeztech/breez-sdk-spark-react-native/` and run `npm run native:fetch` again. When the
script does download, it verifies each archive against the SHA-256 checksums in the package's
`package.json` and stops on a mismatch.

## Diagnosing `checksum mismatch` at startup

The generated JavaScript holds a checksum for every function of the interface and, at
initialisation, compares each one with the value the native library reports, in a fixed order. The
first difference throws `ApiChecksumMismatch` naming that function, which on Android surfaces as a
crash at boot:

```
FFI function ..._check_lightning_address_available has a checksum mismatch
```

A mismatch means the JavaScript and the native library were generated from different revisions of
the interface. Three observations separate a local problem from a defective published package:

- **Where it stops.** A failure on the first function points at the installation, such as a missing
  or stale native library. A failure partway through the list means the two halves agree on
  everything before that function and diverge at it, which points at the package.
- **The neighbouring versions.** If the next release ships the same JavaScript with a different
  native library, that release is fixing the artifact. The same native library with different
  JavaScript would point the other way.
- **Each platform ships its own native artifact.** An iOS build that runs cleanly with the same
  `node_modules` does not rule out a mismatch on Android.

Before changing anything locally, compare the artifact hashes with the checksums the package
declares. If they match, the defect is upstream, and the fix is a different SDK version.

## The Spark route of an invoice

`SendPaymentMethod.Bolt11Invoice` carries two alternative fees, not two parts of one. The SDK pays one
route (`send/bolt11.rs`), so `sendFeeSat` reads the Lightning fee alone and the Spark fee reaches the
quote as `sparkRouteFeeSat`. `sparkTransferFeeSats` is `Some(0)` when the invoice names a Spark address
and `None` otherwise (`prepare/bolt11.rs`), and the route runs only with
`SendPaymentOptions.Bolt11Invoice { preferSpark: true }`.

`PREFER_SPARK_ROUTE` in `sendAll.ts` holds it off, because it is unknown whether a third party's
invoice paid this way shows as paid to whoever charged. Turning it on is that one line, and the review
and the confirm follow it together. `purchase.ts` and `UseMyDomainScreen` never ask for the route
whatever the constant says: the gateway delivers when its invoice settles. An LNURL pay has no
options, so it never takes it either.

## A cross-chain quote's `expiresAt` has two formats

The binding's comment says ISO8601, which holds only for Orchestra (RFC3339). Boltz answers unix
seconds as text (`cross_chain/boltz.rs`). `quoteExpiryMs` reads both and answers null for anything
else, which sets no timer and leaves the SDK's own check. That check runs when the provider's send
starts and refuses with `SdkError.InvalidInput`, whose message is only the class name and whose
`inner[0]` says "Cross-chain quote has expired. Please re-prepare." `classifyWalletError` reads that
sentence as `quoteExpired`, so the send is known not to have left and Send asks for another quote
rather than marking it in doubt. A send the SDK funds with a conversion runs the conversion before
that check (`send/mod.rs`), so a refused send can leave its token already turned into sats, and the
next quote is priced from that balance; this is read from the source, not measured. A retry of the
send itself is safe only without a token leg (`cross_chain.md`), so nothing here retries it.

## A fee refused at send left nothing behind

With fees included the SDK prices the fee again right before it pays and refuses a higher one, in a
Generic saying "Fee increased" (`utils/fees.rs` from `payments/send/bolt11.rs` line 193 and
`cross_chain/boltz.rs` line 699, and `lnurl/pay.rs` line 201). Each comes ahead of the payment, so
`SendSpark` shows the refusal with no word about checking the history. A send funded with a conversion
stays in doubt, since the conversion runs first; this is read from the source, not measured.

## A send in doubt is asked for by its key before it goes again

A send that takes a key goes out under one, and Try again on it asks the SDK's storage for the payment
under that key before anything is signed. The SDK paths below are read at tag 0.28.0, not measured.

Which sends take one is `sparkSendTakesKey` (`spark.ts`): a prepared send with no token leg, no
conversion ahead of it and no cross-chain route, and an LNURL pay with no conversion. The SDK refuses
a key with `InvalidInput` on any send with a token transfer leg, a token sent directly or a
conversion (`payments/send/mod.rs`, `orchestrate_send`). A cross-chain send goes without one because
the SDK names the transfer of its bitcoin leg after the key (`cross_chain/mod.rs`,
`derive_btc_leg_transfer_id`), and Try again is not offered for it.

Each prepared request gets its own key, a v4 UUID drawn at the confirm (`mintSendKey`, `sendKey.ts`),
and only a retry of that same request reuses it. `spark.ts` refuses a key that is not a lower-case
UUID rather than pass it on. A keyed confirm that throws stays held in `spark.ts` under its handle,
with the very request and key it sent (`sendHeld`), and Send drops it when it lets the quote go or when
the throw shows the send never left (a fee that moved, an invoice that ran out, an emergency exit). A
keyed send that throws after Send has unmounted stays held until the process ends.

Try again (`sparkRetryHeldSend`) first reads `getPayment` with `paymentId` set to the key. A payment
found is answered as the confirm would have answered it, with an LNURL pay's success action, and
nothing is signed. Only the storage's own word that it holds no row sends the same request again under
the same key: SQLite's no-row answer surfaces as `StorageError` reading "Underlying implementation
error: Query returned no rows" (`persist/sqlite.rs`, `get_payment_by_id` and `map_sqlite_error`;
`isUnknownPayment` in `spark.ts`). Any other failure, no answer within `KEY_READ_MS` (5 s), another
wallet connected, or the send dropped while a read was out answers `unknown` and signs nothing. An
exit hold found once the storage held no row throws `SpendHeldByExit` before anything is signed, and
Send shows it as the exit's hold.

What a re-send under the same key does is the SDK's. `orchestrate_send` returns the payment it already
stores under the key and sends nothing. Otherwise the key becomes the transfer id on each sats rail: a
Spark address (`payments/send/spark_address.rs`), a bolt11 invoice (`payments/send/bolt11.rs`), a
withdrawal to a Bitcoin address (`payments/send/bitcoin_address.rs`), and an LNURL pay, which goes
through the same send (`lnurl/pay.rs`). When a submission under that id fails, the Spark crate asks
the operators for a transfer it sent under that id and returns that one (`recover_committed_transfer`,
called from `services/transfer.rs`, `services/lightning.rs` and `services/coop_exit.rs`). That the
operators turn away a second transfer under an id they already hold, so a re-send lands in that
recovery rather than moving funds again, is the premise Try again rests on. The SDK states it as
Spark's protocol-level dedup (`cross_chain/mod.rs`, above `derive_btc_leg_transfer_id`); here it is
read from the source, not measured.

One residual follows from it, inferred and not measured. When the first attempt committed and only its
storage write failed, the re-send reserves new leaves, the recovery returns the first transfer as a
success, and `with_reserved_leaves` finalizes the new reservation (`spark/src/tree/select_helper.rs`).
Those leaves then read as spent on the device though the operators never moved them, so the balance
shown can read low; how long that lasts is not measured.

## An SDK error's words are in `inner`, not in its message

Every string variant of `SdkError` behaves as the LNURL refusal above: `String(err)` is
`Error: SdkError.<Variant>` and the text is in `inner[0]`. `classifyWalletError` reads the SDK's exact
sentences from there (`Fee increased`, `Self payment not allowed`, `Cross-chain quote has expired`,
`Invoice has expired`), and its keyword rules stay on the variant's name, because `inner[0]` can be a
server's body or an internal detail that names no cause the person can act on.

Three refusals have no variant of their own in 0.28 and are read from those words, each with its tag
checked first:

- An `LnurlError` opening with `endpoint error:` is the LNURL server's own LUD-06 refusal
  (`common/src/lnurl/error.rs`), raised at prepare and on a withdraw claim. It is matched before every
  other rule, since the rest is the server's text, and Send names the recipient's service without it.
- A `SparkError` with `Failed to select leaves` is the SDK giving up on reserving leaves while the
  balance covers the amount (`spark-wallet` `wallet.rs`, `select_leaves_with_retry`), before any
  transfer. It reads as a balance still updating.
- A `SparkError` with `status: AlreadyExists` is the operators' gRPC status as tonic 0.12 displays it.
  Glow and Cake read it on a Lightning send as an invoice already paid; nothing here measured the
  operators' message. AlreadyExists also answers operations that are not an invoice, so it is no code
  of `classifyWalletError`: `isUsedInvoiceRefusal` is read by Send on an invoice's send only. It never
  clears the send of doubt and never advises a new invoice, because the payment it names may be this
  wallet's own. When the probe for a committed transfer fails, `recover_committed_transfer`
  (`spark/src/services/transfer.rs`) returns the original error, a leaf retry sends the same invoice
  again (`with_leafs_spent_retry`), and the SDK's record of the send outlives any error until a later
  sync finishes it (`lightning_sender.rs`, `resume_pending_sends`), so the payment can land after the
  screen named the invoice used.

## `lnurlPay` hands back the server's words before the payment ends

`LnurlPayResponse.successAction` is filled for a Message or a Url even while the payment is pending
(`helpers.rs`), so Send shows it only once the outcome is `complete`. It is the server's text. The
overlay draws the words and never the link, which stays in the transaction's sheet.
