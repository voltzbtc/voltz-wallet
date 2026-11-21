# Store bridge

Names and domain years are sold through the App Store and Google Play. The app talks to each store
through its own thin native module, and the gateway verifies every purchase with the store before it
delivers anything.

## Layout

| Piece | Where |
|---|---|
| Codegen spec and its Jest double | `specs/NativeVoltzStore.ts`, `specs/__mocks__/NativeVoltzStore.ts` |
| The one reader of the bridge | `src/wallet/store.ts` (codes, reference case, which Play callback answers a purchase) |
| Confirmation and finishing | `src/wallet/storePurchase.ts` |
| iOS, StoreKit 2 | `ios/VoltzWallet/Store/VoltzStoreCore.swift`, adapted by `RCTNativeVoltzStore.h` and `.mm` |
| Android, Play Billing 9 | `android/app/src/main/java/app/usevoltz/store/` (`StoreBilling.kt`, the module, the package) |

## Rules the native side keeps

- **It relays, raw.** Errors leave as the store's own code (StoreKit case names, Play
  `BillingResponseCode` integers), and `store.ts` maps them, where Jest and Stryker reach the map.
- **Apple finishes only by id, and only when asked.** `VoltzStoreCore.finish` looks the id up in
  `Transaction.unfinished`, and is the one place that calls `finish()`.
- **Google never consumes nor acknowledges on the device.** The gateway consumes after it delivers.
  `__tests__/storeAndroid.test.ts` fails if either call appears in the Android sources.
- **Updates queue until the JS side drains them.** `takeQueued` hands the queue back and switches to
  direct emission under one lock; a JS reload calls `invalidate`, which puts the native side back to
  queueing. The queue keeps the newest 100, since the store's list of open purchases is the source.
- **The iOS listener starts in `AppDelegate`, before React Native.** Apple hands transactions left
  unfinished to `Transaction.updates` right after launch.
- **The Play client starts on the first call from JS**, waits only for its first connection, and
  relies on `enableAutoServiceReconnection()` afterwards.

## Rules the purchase flow keeps

- **The store opens once per order.** Within its ten minute hold the gateway hands back the order it
  already opened for the same thing and wallet. `buyInStore` then settles the open purchase that
  carries the reference, and opens the store again only when the last tap for that reference was
  cancelled or failed. After a pending or a paid answer it shows the wait or `paidElsewhere`, so a
  missed confirmation or an Ask to Buy never turns into a second charge. An open list that cannot be
  read stops the purchase rather than reading as empty. The root's sync can deliver or refuse the
  order between the gateway handing it back and the store opening, after which the store no longer
  lists its purchase, so `buyInStore` keeps the references the gateway settled for good in the session
  and opens the store for none of them (`settledMeanwhile`). It answers once that settle has written
  the book and told the screens, and the press shows what the sync settled before it gives the
  purchase press back, the sheet by reading the book and the credits, the domain screen by reading
  the book for the order, so a Pay pressed in between never opens a second order.
- **A screen opened again shows what the order's answer showed.** See the invariant below.
- **Only the wallet that opened an order confirms it, while that wallet is on the device.**
  `store-orders.json` keeps the wallet id, and ids are new on every add, so a removed wallet's note
  is read as no note and the connected wallet asks. The gateway delivers to whichever wallet holds
  the order's key.
- **A Play OK answers the tap only when it is the flow's answer.** Google answers a purchase flow
  through the listener that also reports every other purchase of the app. An OK call with the tap's
  own purchase, the product asked for with the order's reference, answers as it always did. One with
  the product asked for and no reference to read is the flow's answer all the same, and one with no
  purchase at all ends the flow, so each answers `pending` with no purchase at once, as Ask to Buy
  does, and `buyInStore` notes the order as pending, the screen shows the wait, and the store is not
  opened again for that order until Stop waiting. A call with only other purchases, of other
  products or of this product with another order's reference, is not the flow's answer, and the tap
  stays open for the next call, so a cancel or any other error after it answers the tap as before.
  No timer decides any of this. Every purchase in a call goes to the listeners and the sync once,
  except the tap's own, which the tap's answer carries.
- **A signature is made only as the pubkey its request sends.** A request carries the pubkey read
  when its deps were built and is signed later, while a reconnect can replace the connection in
  between. Callers take both from one pair, `identitySigner`, and `sparkSignMessage` takes the pubkey
  being sent. It takes the live connection once, reads that connection's identity when it is not yet
  known, kept for that connection alone, and signs on that same connection. After a reconnect to the
  same wallet that costs one identity read and the request goes out; after a switch to another wallet
  the signature is refused as without a connection, and the order, the confirmation, the credits and
  the spend end as a lost connection does, before any request. The settle and the press also check
  the book against the connected wallet, so each stops the same way, with the book untouched, when
  the wallet connected after the identity read is not the one checked.

## What a purchase screen shows again

**The invariant.** What a purchase screen shows after a close, a reopen or an app restart is what it
showed when the outcome first arrived, for every outcome an order can reach. Each outcome is kept
where the screen reads it back on opening. The book (`store-orders.json`) keeps what the store and
the gateway answered, beside the order and what it sells, and the gateway's own lists keep what it
delivered. When a screen finds several orders, `storeOrderViews` puts one that needs support first,
then a wait, a refusal and a delivered year.

**The rules.** Every row of the table follows from these, and a case that fits none of them is a
missing rule, not a missing patch.

1. **A read that has not answered, in flight or failed, is an unknown.** What the book on the device
   keeps shows at once, without waiting on the store or any network read (I1 below), and with nothing
   kept the screen opens on a Skeleton while the read is in flight. Never the offer, never a price,
   never an enabled Buy before the read answers. After the store charged or a register went out, a
   read that fails (credits, orders, address) shows the checking view with Check again, and it never
   says the purchase did not go through. A credits list that cannot be read is an unknown before any
   purchase too, so the name sheet sells nothing until it answers, except on a domain whose names
   are free.
   No line claims more than the code verified. A failure names what failed and never a cause it did
   not see, and no line on a store build says nothing was charged.
2. **Checking survives a reopen.** A register whose answer was lost is an outcome like the others,
   kept in the book until a read settles it, and shown again on open and after a restart.
3. **A kept outcome is keyed as the gateway keys its order.** A year's order is keyed by its host
   alone, whichever screen opened it. A wait, a support case or a refusal for a host shows on, and
   blocks, the renewal of that host whichever screen opened the order. The first-year form restores
   its own flow, so on open it shows only what a first year left, for any host, and puts that host
   back in the form. A wait, a refusal or a support case on the domain screen names the host its
   order is for, since the form behind it may have named another. A renewal's wait, support case or refusal reaches the first-year form only once
   the form names that order's host, which Continue checks before it sends the claim; it never shows
   on open, and it never blocks a first year for another host. A delivered year blocks nothing and
   keeps its place by the screen that opened its order, the DNS steps on the first-year form and the
   new end date on the renewal. When the gateway hands an order back, the book keeps what it already
   holds for it, the kind and the renewal flag included. A name's order is keyed by the name and its
   domain, and the sheet shows every kept outcome of its domain.
4. **Support blocks new charges, never a credit already paid.** A support case keeps its line and
   Send to support and offers no Buy, while a credit the wallet holds that covers the typed name is
   still offered with Use this name. A press there answered by a hold, a taken name, a name pending
   for somebody else or a register that never took leaves the support case on screen, with the
   press's line beside it and the credit still offered.
5. **A store that cannot price blocks only buying.** The first-year Continue sends the claim as
   always, so a domain already paid elsewhere reaches its DNS steps. Only the step that would open an
   order and call the store is closed, by the guard inside `buyYear`, under the "not available" line,
   and while the store is still pricing that guard says so (`store.stillPricing`).
6. **Every guard has a test that goes red under its mutation.**
7. **A read that sells nothing stops nothing.** The renewal's claim only tells a lapsed year from a
   live one, which picks the early or the late line, and a renewal is for sale on a domain the owner
   holds either way. Pay waits while the claim is in flight, and a claim that fails leaves the line
   unsaid and the year for sale.

| Outcome, as the code names it | Shown again | Until |
|---|---|---|
| `delivered`, a name | the credit it bought, from the gateway's credit list | the credit is spent |
| `delivered`, a year | on the screen that opened the order, the renewal's line with the year's new end date or the first-year form's DNS steps | the year is in its last 30 days, or a first year's domain answers |
| `refused`, each code in `FINAL_REFUSALS` | the refusal, with its line from `storeRefusedKey` | the person closes it |
| `support`, each code in `DEFECT_REFUSALS`, and `noReference` | the support line, Send to support with the purchase reference, and no Buy; on the name sheet, a credit the wallet holds is still offered beside it | the store no longer lists the purchase, which takes the case out of the book, or a later answer settles it |
| `unknownOrder` | the support line, as above | as above |
| a name's credit `reserved` for it, finishing | the name being finished | the gateway resolves the reservation |
| a name checked (`NameCheck`), after a lost register, a `name_pending` or a delivered credit the credits list could not show, or a wait the store let go | the check, with Check again (`store.checkingPaid` when the credit was delivered) | a read of the credits answers, which ends every check on the domain |
| the credits list unreadable on open or on Buy, with nothing kept | `store.unread`, with Check again, and nothing sold | the list answers |
| `pending` (Ask to Buy, a slow payment), `notVerified` and `waiting` | the wait, with Check again and Stop waiting | the store settles it, or Stop waiting |
| `retry` and `later` after paying, with the gateway out of reach | the wait | as above |
| `failed`, with the store out of reach before paying | the offer, since nothing was paid or held | |

- **Stop waiting leaves nothing held.** `dropStoreWait` takes the order off the wait whatever the
  store last answered, so the next Buy opens the store. A purchase the store still lists for the
  same order is settled rather than bought again, and kept as the order's wait again, the sync still
  confirms a paid one, and an Ask to Buy approved later is a second purchase, which the person chose.
- **A paid wait the store lets go ends as Stop waiting ends it.** A read of the store's list that
  answers without a purchase the book notes as paid drops that note in `storeOrderViews`, since the
  store lists a paid purchase until the gateway finished or the store refunded it. The screen that
  stops showing the wait therefore sells again, and the next press asks the store, rather than a
  press showing a wait that nothing holds. That costs no second charge. On Apple a transaction is
  unfinished until `finish()` is called (StoreKit's `Transaction.unfinished`), and the only call is
  `VoltzStoreCore.finish`, which `settleStorePurchase` reaches after a delivery or a final refusal,
  each of which keeps the year's outcome or ends the name's order. A refund or a revocation gives the
  money back, and Family Sharing does not reach a consumable (every product in `VoltzStore.storekit`
  is a consumable with `familyShareable` false). On Google an unconsumed purchase stays listed, and
  buying it again answers `alreadyOwned`. Whatever the note says, `buyInStore` asks the gateway for
  the order first, which answers `paid` for a purchase it saw paid and hands back an order whose
  listed purchase is settled instead of bought again.
- **The root's sync speaks while a screen is open.** Its answer about the wait on screen takes the
  wait's place. A refusal or a support case for another order the screen shows on open takes the
  offer, the price or the form, since it blocks a new charge whether or not the screen was waiting on
  it; on the renewal a delivered year does too. A delivery that lands on the name sheet while a press
  runs is checked once the press is done. On the domain screen an answer about another order that
  lands while a press holds the screen is taken once the press is done (`heard`), and only if the
  screen still shows the price or the form, so the press's own outcome never lands after it and no
  way out shows beside a purchase still running. Taking the screen clears the line the press left,
  which is about that press. On the name sheet the sync can put up a support case or a refusal while
  a press runs. When that press then answers with a hold, a taken name, a name pending for somebody
  else or a register that never took, the sync's view stays up (`backToOffer`) and the press's line
  shows beside it. A taken name is the exception, since its line is the sheet's availability line and
  a refusal fills the sheet in its place.
- **A refusal or a delivered year ends by its own rule, never by being seen once.** Closing the
  refusal calls `dismissStoreOutcome`, which also keeps a later answer about that order from being
  written back, since Google is asked again until it refunds. A year delivered without an end date,
  which the gateway never sends, is not kept. A delivered year shows only on the screen that opened
  its order (rule 3), on open and after a wait, so a renewal's stays out of the first-year form,
  which is for buying another, and a first year's stays out of the renewal, which it did not renew.
- **Apple never reports a declined or lapsed Ask to Buy,** so the wait has a way out. A final
  refusal on Google is no wait, since Google refunds it on its own, and it is still the refusal.
- `storeNameOffer.test.tsx` and `useMyDomainStore.test.tsx` each hold a table built from
  `FINAL_REFUSALS` and `DEFECT_REFUSALS` plus a row for every other outcome, and fail when the table
  is empty or lacks a class, so a code added to either set is covered without editing the test.

### Reads and invariants

Every screen makes several reads, and what it may show or sell at any moment depends on which of
them have answered. Rules 1 to 7 say what each outcome shows; the invariants below say how the reads
may interleave with each other, with a press and with the root's sync, and each is kept by a guard in
the code.

#### The reads of each screen

**Name sheet** (`src/components/StoreNameOffer.tsx`).

| Read | Runs | Decides |
|---|---|---|
| The book, `keptOrderViews` and `nameChecks` | on open, after Stop waiting, on Check again of `store.unread`, and on an answer of the root's sync about an order not on screen | the check or the kept order, shown at once |
| The store's open list, through `storeOrderViews` | on open when the book keeps an order without an outcome or a support case, on Buy, and twice on Check again of a wait (the sync, then the views) | whether a kept wait or support case is still held |
| The identity, `currentDeps` (the SDK's `getInfo`) | after the book on open, and in every press but Close | the credits, the purchase and the support mail, none of which can be signed or addressed without it |
| The credits, `storeCredits` | on open after the identity, and in every press (`reread`), Check again of a support case included | the credit offered, a reservation, the end of every check |
| The price, `loadProducts` | on open | the price line |
| The order, the store's sheet and the confirmation | on Buy, once nothing covers or keeps the name | the purchase and its outcome |
| The confirmation inside Check again, through `syncStorePurchases` | on Check again of a wait | what the store and the gateway now say about the waited order |
| The root's sync (`startStoreSync`), heard through `onStoreSettled` | on the app's foreground, a wallet's connect and a store update, with no press | the waited order's outcome, or a refusal or support case of another order of the domain |
| The spend intent, then the register | after a credit is chosen, on Use this name, Check again or a delivery | the name |
| The address, `sparkGetLnAddress` | after a register whose answer was lost, and on Check again of a finishing name | whether the name is already the wallet's |
| The name's availability, `sparkCheckLnAddress` | after a register that never took | whether somebody else has the name |

**First-year form** (`src/screens/UseMyDomainScreen.tsx` without a host to renew).

| Read | Runs | Decides |
|---|---|---|
| A sats payment owed, `loadPendingPurchase`, and its confirmation | on open, first in Continue, and again before a failure says nothing was charged | a payment still landing, which takes the screen |
| The book, `keptOrderViews('tier', null)` | on open, after Stop waiting, after Close | what a first year left for any host, shown at once, with its host put back in the form |
| The store's open list, through `storeOrderViews` | on open only when the book keeps a wait or a support case a first year left, in Continue for the host the form names, inside `buyInStore`, and twice on Check again of a wait | whether a kept wait or support case is still held |
| The price, `loadProducts` | on open | the price line, and whether `buyYear` may open an order (rule 5) |
| The identity, `deps()` | in Continue, in each poll, and in the support mail | the claim and the order |
| The claim, `claimDomain` | on Continue, once the book and the list keep nothing for the host named | the DNS steps for a paid domain, the store for `domain_tier_not_paid`, a refusal otherwise |
| The order, the store's sheet and the confirmation | on Continue after the claim | the purchase and its outcome |
| The confirmation inside Check again, and the root's sync | as on the sheet | the waited order's outcome, or a first year's settled while the form is up |
| The DNS poll, `claimDomain` | on a timer every 10 s on the DNS steps, and on Check again of the poll's note | the status line, or the refusal's own line |
| The wallet's reconnect, `setDomainFor` then `reconnectActiveWallet` | once the domain answers active, and on Try again | whether the steps may say the address works, and whether the first year's steps leave the book |

**Renewal** (`UseMyDomainScreen` with a host to renew).

| Read | Runs | Decides |
|---|---|---|
| A sats payment owed | on open, first in Pay, and again before a failure says nothing was charged | as on the form |
| The book, `keptOrderViews('tier', host)` | on open, after Stop waiting, after Close | the host's kept outcome from either screen, and a renewal's delivered year, shown at once |
| The store's open list, through `storeOrderViews` | as on the form, Pay standing for Continue | as on the form |
| The price, `loadProducts` | on open | the price line |
| The identity, `deps()` | before the claim, and in the support mail | the claim |
| The claim, `claimDomain` | once the book and the list keep nothing, on open, after Stop waiting, after Close and after a Check again that clears the wait | the early or the late line (rule 7) |
| The order, the store's sheet and the confirmation | on Pay | the purchase and its outcome |
| The confirmation inside Check again, and the root's sync | as on the sheet | the waited order's outcome, or the host's order settled while the price is up |
| The DNS poll | on a timer under the new end date | the status of a domain that was off the edge, the only one that shows it |

**What gates a sale.** A purchase press is enabled only once every read in its set has answered and
none of them shows a kept outcome, a pending store purchase or a covering credit for its subject.

- Buy on the name sheet needs the book and the store's list to keep nothing for the domain, the
  credits read since the last press to have answered with no credit covering the typed name, and the
  price. Use this name needs the same credits read to show a credit covering the name, and never
  opens the store.
- Continue on the first-year form needs the book and the store's list to keep nothing a first year
  left. It is the form's purchase press, under the price, and it sends the claim without a price
  (rule 5). It first reads the book and the store's list for the host the form names, and an
  unsettled order of that host from either screen takes the screen instead of the claim. Continue
  keeps opening the store directly once the claim answered `domain_tier_not_paid`, since the price is
  on screen and the store's own sheet asks to confirm.
- Pay on the renewal needs the book and the store's list to keep nothing for the host, the price,
  and the claim no longer in flight (rule 7 lets a failed claim sell).
- A Check again that finds the store let go of the wait has read the book and the list for the host,
  which is what the open waits on, so it gives the purchase press back itself.

#### The inventory

A base count over the code, comments left out, by occurrence. The name sheet has 48 `await`,
4 `.then`, 16 `.catch` and one `onStoreSettled`, 69 sites in all; the domain screen has 55, 10, 21
and one, 87 in all. The functions of `storePurchase.ts` they reach hold 48 `await`, 1 `.then`, 10
`.catch` and 3 listeners, and those of `store.ts` 7, 1, 1 and 1. Of the 156 sites on the two screens,
38 are calls between the screen's own functions and the other 118 reach one of the sources below. A
function of `storePurchase.ts` or `store.ts` is how a source answers, so its sites are counted under
that source.

These changes came after the base count, and are counted the same way.

- When the sync settles the order a Buy was opening, the sheet reads the store's list, the credits
  and a spend, three `await`.
- On `settledMeanwhile` the domain screen reads the book and shows the order it finds, two `await`,
  and `buyInStore` waits for the sync's settle, one `await` in `storePurchase.ts`. An answer of the
  sync heard during a press adds none, since it runs the same book read once the press is done.
- The sheet's two free registers go through `registerFree`, which holds the one register and its
  `.catch`, so the sheet has one `await` more and one `.catch` fewer.
- The domain screen's `askAbout` puts a payment on screen before `settle` asks the gateway about it,
  one `await` between the screen's own functions.
- The domain screen's `settle` keeps a paid refusal on the proof it is about, one `await` that
  reaches the slot.
- The domain screen's `settle` reads the slot before it asks, one `await` and one `.catch`; `askAbout`
  and `owed` hand its answer back rather than awaiting it, two `await` fewer; the mount goes on to a
  kept line when the proof left meanwhile, a `.then` where a `.catch` was; a dropped wait reads the
  store's book, one `.catch`; and the screen hears the record's listener, `onPendingPurchaseGone`.

After these the sheet has 52 `await`, 4 `.then`, 15 `.catch` and one `onStoreSettled`, 72 sites in all,
and the domain screen 58, 11, 22, one `onStoreSettled` and one `onPendingPurchaseGone`, 93 in all.
The site counts in the rows below are the base count, and the rows name the outcomes added since.

| Source | Sites on the sheet, the domain screen | Outcomes the code tells apart | In the harness |
|---|---|---|---|
| Identity, `getInfo` through `currentDeps` and `deps()` | 7, 7 | answers; fails | both, held and at once, failing on the open and from the first press on |
| The book, read | 9, 11 | a book; a file that cannot be read (cut mid write, or not a map), which `readBook` reads as empty; a torn copy with no book, which is a first write that was cut and reads as no book; a file whose fields this build cannot read, as a later build may write, which fails the views read. Every read waits in the book's queue, behind any write | every starting book; the unreadable file plays as the empty book (storeBookTorn.test.ts). The unreadable fields fail a domain Check again, whose `store.retry` shows only while its sequence is current (useMyDomainStore.test.tsx). Support reads a book that cannot be read, or one set aside, as unread (`storeBookEvidence`). A purchase press reads the book strictly before the store's sheet (`buyInStore`), and a read the platform refuses answers `orderRetry` rather than an empty book, so an order only the book noted (an Ask to Buy waiting for approval) is not bought again (storePurchase.test.ts). A torn book is already set aside by the note written just before that read, so a note only it held is still lost |
| The book, written | (in the sites above) | lands; fails | lands. Written whole to `store-orders.json.tmp`, read back and moved in (`durableFile.ts`), so a cut leaves the book from before or after. The first write over a book that cannot be read sets it aside as `store-orders.json.unreadable` (a stamped name when that is taken), never over it nor deleted, and writes the change to an empty book; a change that changes nothing sets nothing aside. A first write cut mid copy leaves a torn copy with no book, whose last finished state is no book: it reads as none, Support reads nothing unread from it, and the next write removes it (`FirstWriteCut` in `durableFile.ts`). What a change adds to an empty book is acted on only once its write settled, landed or failed (the opener note, whose write settles before the store's sheet opens) or is kept by the store or the gateway, apart from an Ask to Buy note whose write was the first because the opener note failed to write, which the screens lose as they lose it from a book that cannot be read. Residue: an Ask to Buy still pending on Apple that only the set-aside book noted is lost, and the store's sheet can open again for that order. A failed write leaves the book as it was; a settle whose note of the gateway's answer fails still answers that answer, never a retry (`noteVerdict`), and the screens catch every one but the sheet's `dropStoreWait`, whose `store.retry` is driven by `storeNameOffer.test.tsx` |
| The store's open list | 7, 4 | holds the purchase; does not; never answers; fails | the first three. A list that fails reads as held in `storeOrderViews` and as empty in the sync, which `listed` and `empty` show |
| The credits, `storeCredits` | 12, 0 | a list covering the name; a list not covering it; no list (a 500, an answer not the gateway's, the connection, a row this build cannot read); never | all four |
| The price, `loadProducts` (and `fetchPrices` in sats) | 2, 5 | prices; a product missing; fails; never | prices, held in every order. The other three keep the purchase press off by the price check itself, which the hand-written tests drive |
| The purchase, `buyInStore`, which holds the three rows after it | 1, 1 | as those rows; the order settled by the sync while it was out (`settledMeanwhile`); the screen no longer wanting it | as those rows; `settledMeanwhile` in both files' sync another group, and a sheet closed behind Buy in the name file's closing group |
| The order route, `openStoreOrder` | inside `buyInStore` | an order held, handed back or new; an order paid; a refusal; a refusal with `retry_at`; no answer | the order handed back or new. A paid order shows the wait `paidElsewhere` shows; a refusal and no answer each set one line and open nothing, and a refusal with `retry_at` says when (hand-written tests) |
| The store's sheet, `buy` | inside `buyInStore` | purchased; pending; pending from an OK with the product and no reference, or with no purchase; cancelled; already owned; any other failure | pending. The others each set one line, open no order again, or settle through the sync the harness drives (hand-written tests) |
| The confirmation, `confirmStorePurchase` | inside `buyInStore`, and 1, 1 through the sync in Check again | delivered; refused for good; support; unknown order; pending; not verified; later; retry | all eight, in Check again and in the root's sync. Retry is a 503 whose retries inside `sendSigned` answer at once |
| `finish` on Apple | inside the confirmation | lands; fails | lands. A failed finish is only logged, and the next open asks the gateway again, which answers the same |
| The root's sync, through `onStoreSettled` | 1, 1 | every verdict above; `noReference`; the waits `inFlight`, `otherWallet`, `noWallet`, `backoff` | every verdict, `inFlight` (a sync beside a Check again) and `backoff` (a second confirmation after a postponed one). `noReference` is answered before any listener hears it; the wallet is always the opener here, and storePurchase.test.ts drives the other two |
| The spend intent | 1, 0 | recorded; too many requests; another refusal; no answer | recorded. The others each set one line (hand-written tests) |
| The register | 5, 0 | lands; taken; `name_pending`; a known refusal; a refusal with `retry_at`; anything else | lands. Each other answer of a spend runs through `spendFailed` and `verify`, and a free name's through `registerFree`, driven one by one by the hand-written tests, the refusal with `retry_at` among them |
| The address, `sparkGetLnAddress` | 4, 0 | the name; another name; none; fails | none, which is what decides the reads after it |
| The availability, `sparkCheckLnAddress` | 2, 0 | free; taken; unknown | free |
| The support mail, `Linking.openURL` | 1, 1 | opens; fails | opens, from Send to support on the sheet. Whether the mail opens or not, the press leaves the support address, the mail's text and Copy under it on both screens (`components/SupportMail.tsx`), since a mail app can open and send nothing, and every other support mail in the app shares that card; the domain screen's identity read is counted above |
| The claim, `claimDomain` | 0, 7 | awaiting the record; active; wrong target; awaiting the certificate; root not supported; `domain_tier_not_paid`; `domain_belongs_to_another_wallet`; `not_a_domain`, `custom_domains_not_configured`, a bad signature, too many requests; the connection; never | awaiting the record, active, the two refusals and the connection, and never. The other states each pick one status line in `statusLine`, and the other refusals one line in `reason`, which useMyDomainScreen.test.tsx drives |
| A sats payment owed, its slot and `confirmDomain` | 0, 14 | no record; a record; a record keeping a refusal for good; granted; not yet (402); refused while a later confirmation may still grant it (`final: false`); refused for good, or with no `final`; given back (`repaid: true`); a year bought before (`bought_before`); fails | the five other than the refusals, with a record filed by the recovery at any step. The refusals, read in `settle`, and a record keeping one with the final answer it names (`finalAnswer`), read wherever a payment goes on screen with no fresh answer, are driven by useMyDomainScreen.test.tsx. Only this charge's `repaid: true` says the sats came back, and a year bought before says so and asks nothing. An answer that owes nothing clears the record, and the next mount reads none; one heard after the screen unmounted is kept as a line (`releasedLines.ts`), which the next mount with no record takes, says once and asks nothing about, before it resumes as it would with nothing kept |
| The sats quote, `quoteDomain` | 0, 2 | a quote; fails | both |
| The sats send, `sparkPrepareSend`, `sparkSyncedBalanceSat`, `sparkConfirmSend` | 0, 4 | prepared; refused for too little; another failure; balance enough; too little; no synced figure; sent; pending; failed; throws | prepared, refused for too little, balance enough, sent and failed. Too little and no synced figure clear the record before any send, which useMyDomainScreen.test.tsx drives; the balance is only ever the synced one, which syncedBalance.test.ts holds. Another failure, pending and a throw are decided by the record on disk, which useMyDomainRenew.test.tsx drives |
| The wallet's reconnect | 0, 5 | answers; fails | both |
| Share | 0, 2 | done; fails | neither; its failure is caught and changes nothing a purchase reads |

Of the 101 outcomes found, the harness plays 52 and leaves out 49, each for the reason in its row.
Beside the outcomes, the harness inserts the events the screens can meet, which are the root's sync
with no press, a second press at every position after the first (its reads out or answered), typing
another name or another domain, the place toggle, Close and Send to support on both screens, the
sheet's own back control, Try again on the reconnect, and the recovery filing a payment owed.

#### The invariants

- **I1 Book first.** What the book keeps for the subject renders from the book alone, before the
  identity, the store's list, the credits or the claim answer. The store's list only takes away
  afterwards what the store let go. The guard is the view `keptOrderViews` gives, applied before
  anything else is awaited, in `opening` on the sheet, which reads the domain from `currentDomain`
  and needs no identity for it, and in `resume` on the domain screen.
- **I2 Last writer.** Each screen has one sequence, `seq`, which every open, every press and every
  answer the root's sync brings moves on; on the sheet an open is an instance of its own, whose
  sequence starts anew. What a read sent on opening shows applies only while its
  sequence is current, and a press reads again what it needs. A press still running when a later
  one lands applies nothing more. On the domain screen Stop waiting and Close take the screen from a
  running press (`leave`), so the way out never waits on a read that may not answer and the open
  that follows reads the renewal's line under a press of its own; the lock is held by a token, so
  the press left behind never gives back a lock it no longer holds (`release`), and what a Check
  again read applies only while its sequence is current. A purchase the press left behind made still
  shows, being what the store holds. On the sheet presses run one at a time (`guarded`), and every
  opening is an instance of its own (`StoreNameOffer` keys `Offer` by opening, since iOS keeps the
  modal's content mounted while it slides away), so a press left running behind a close opens no
  order, no store sheet and no confirmation of a purchase the store lists (`wanted` in `buyInStore`,
  read before each of them and before the store's list), spends no
  credit, keeps or ends no check and says nothing (`closed`); a register it already
  sent still finishes the sheet, and a name lost to somebody else is still taken. The sheet's credits
  keep a sequence of their own, `reads`, which only a press moves on within an opening, since an
  answer of the sync settles an order and never the credits. The DNS poll keeps its own count, so an earlier
  tick never overwrites a newer read. The price is the product's, no press changes it, and it applies
  whenever it answers. The guards are `current()` and `reads` in `opening`, `seq.current !== at` in
  `resume`, `checkStoreWait` and the sheet's `checkWaiting`, `leave` with `release`, the opening key
  with `closed`, and `polls` in `poll`.
- **I3 A press does what its label says.** A store purchase opens only from Buy, Pay or the
  first-year Continue, with the price on screen at that press. Use this name never opens the store.
  When the credit is gone by the press, the sheet says so (`store.creditGone`) and shows the price,
  and opening the store takes a press on Buy. Buy, Pay and Continue are enabled only under the gating
  set above, and once that set has answered with nothing to block, they are enabled, whichever press
  or answer read it last. The guards are `using` in `act` on the sheet, and `resumed` in the
  `disabled` of Pay and Continue, which `resume` and a Check again that clears the wait both give back.
- **I4 A copy claims only what was verified.** Once a year was delivered or a name is done or paid
  for, no line says the purchase failed or may not have gone through. On a store build no line says
  nothing was charged, and on the sats build only where no payment is on record and every send that
  left answered failed, which `sayUnlessOwed` reads again before it says so. The DNS steps follow a
  paid year, so a poll that does not answer says `useDomain.statusUnread` with Check again in place of
  the status an earlier poll read, a poll the gateway refuses as another wallet's says
  `useDomain.domainTaken`, and before any poll answers the status is a Skeleton. An active domain
  says the address works only once the wallet's reconnect onto it answered, says it is being set up
  while the reconnect is out, and says it is not set up yet, with Try again, once it failed, on the
  first year's steps and under a renewal that was off the edge alike; the first year's steps stay in
  the book until it answered, so the next open tries again too. A renewal that was off the edge says
  its addresses come back on their own until then, and gives the new end date only after. No line names a
  cause the code did not see, so `store.checking` and `store.checkingPaid` name none, and only a
  failure classified as the network may mention the connection. The guards are `statusNote` and
  `adoption` in `StatusLine`, and `owes` in `startRenewal`, `startPurchase` and `buyRenewal`.
- **I5 Subject key.** Rule 3, kept by `shownHere`, which matches an unsettled outcome on the renewal
  of its host from either screen, on the first-year form a first year's and a renewal's only when the
  form names its host (`named`), and a delivered year by its renewal flag; by `resume`, which reads
  the store's list on open only for a wait or a support case the screen shows, so a renewal's order
  never holds the first-year form's open; and by `buyInStore`, which never rewrites the record of an
  order handed back.

#### The schedule harness

`__tests__/storeSchedules.name.test.tsx` and `__tests__/storeSchedules.domain.test.tsx` drive the real
screens with the reads above held as deferreds. The book answers at once from the in-memory file
system, as the device's disk does, except the domain screen's first read of it, which is held too,
since Pay and Continue wait on it. Plans come in groups, and each group holds the reads and inserts
the events that decide what it checks, answering every other read at once, so the schedules grow by
group and not by product. For each plan they play every order of the held settles with the plan's
presses and events inserted at every position, and after every step they check the oracles.

- **O1** has the kept outcome on the first render after the book read.
- **O2** has a read an earlier press sent, or a poll a newer poll followed, change nothing on screen
  once a later press came, and the earlier press make none of the screen's own writes to the book (a
  wait dropped, an outcome dismissed, a check kept or ended, an order opened) after it. A
  confirmation is the gateway's verdict about the order, written whichever press asked, and reaches
  the screen through the listener, which shows what the book keeps. Within one press, a refusal or a
  support case on screen never gives way to the wait again, since an answer the root's sync brings
  while the press runs is the later outcome. Send to support changes nothing in the book, and on
  screen only adds the support card under the press (its line, the address, the mail's text and
  Copy), whether the mail opens or not, since a mail app can open and send nothing.
- **O3** has the store open only after a purchase press with its price, never beside an order the
  book keeps open on the sheet and never for an order a confirmation settled, and no purchase press
  enabled while its gating set is out or keeps something, or on the domain screen while an earlier
  purchase press still runs.
- **O4** has no failure line after delivered, no connection named without a network failure, no
  status line before a claim answered, the DNS steps saying what the latest poll and the reconnect
  read (its status, the unread line, or the refusal's own line, never two of them, and for an active
  domain the line of the reconnect), the caption inviting a first payment only once the reconnect
  answered, no line about setting the address up after the reconnect failed, the first year kept in
  the book with Try again on screen after a failed reconnect, the first year out of the book once it
  answered, and a renewal that was off the edge saying its addresses come back until the reconnect
  answered and its new end date only after.
- **O5** has an unsettled order of the host show on the screens rule 3 names, and not on the
  first-year form on open when a renewal opened it, open no other order for its host, keep its
  record, hold the claim when Continue names its host, the form name the host of a first year it
  put back, and the first-year form read the store's list on open only for an order it shows.
- **O6 liveness** has the purchase press on screen, whichever the screen shows (Buy or Use this name,
  Pay, Continue), and enabled whenever the screen waits on no read and nothing kept, owed, delivered,
  taken or unknown blocks the sale. On the sheet it also checks rule 4: a support case on screen with
  the latest credits answer covering the typed name offers Use this name, and leaves the sheet's
  availability line up, which the harness's stand-in for the address sheet hides on a takeover. On the renewal, a press
  that leaves a wait or a refusal for the price has read the line again (`line`).
- **O7 no false denial** has no line that says nothing was charged or the payment did not go through
  (`useDomain.payFailed`, `receive.lnPayFailed`, and `store.refusedTest` away from the refusal of a
  test purchase) on a store build, and on the sats build none while a payment is on record or a send
  that left has not answered failed.

Each file lists the outcome values it prunes and why, and prints how many plans and schedules ran,
by group, and in how many steps each oracle's precondition held, which must be above zero.

On a full run the name sheet ran 107 plans and 5,196 schedules (base 2,619, check
verdict 87, sync 855, sync in check 1,125, identity 100, second press 83, wait gone 53, sync another
136, typing 48, closing 90), with O1 holding in 4,919 steps, O2 in 5,562, O3 in 306, O4 in 4,627, O6
in 1,459, rule 4 in 201 and O7 in 23,321. The domain year ran 215 plans and 2,775 schedules (base
1,158, check verdict 218, sync 226, second press 482, typing 135, identity 38, sync another 175, poll
169, sats 174), with O1 in 895 steps, O2 in 1,574, O3 in 4,061, O4 in 2,830, O5 in 12,059, O6 in
1,584, the renewal's line in 529 and O7 in 3,742. Run together the two files took 120 s on a machine
running other work at a load between 30 and 50, the name sheet 101 s and the domain year 116 s of it.
`SCHEDULE_GROUP` and `SCHEDULE_MATCH` narrow a run to a group or to plans whose name holds the text,
and `SCHEDULE_TRACE` prints every failing step.

#### Worked examples

One read at a time. Rows are what the book keeps for the screen, columns the
state of that read, where in flight is a read held open and failed is one whose connection fails.
`storeNameOffer.test.tsx` and `useMyDomainStore.test.tsx` drive every cell after a reopen and after a
restart.

**Name sheet.** The read is the credits list, sent on every open.

| The book keeps | In flight | Failed | Answered |
|---|---|---|---|
| nothing | a Skeleton in the offer's shape, nothing sold | `store.unread` with Check again | the offer |
| a check | the check, with Check again | the check | the check ends, and the credit is offered with Use this name |
| a wait | the wait | the wait | the wait |
| support | the support line and Send to support, no Buy | the same | the same, with a credit the list shows offered beside it |
| a refusal | the refusal and Close | the refusal | the refusal |
| delivered, which only the list keeps for a name | a Skeleton | `store.unread` | the credit, with Use this name |

On a domain whose names are free nothing needs a credit, so the offer shows while the read is out.
An answer that arrives after a press leaves the press's view and credits on screen (I2).

**First-year form.** The read is the claim, which Continue sends and the DNS steps of a delivered
year poll. Nothing is read on open, so with nothing kept the cell is what Continue does. A renewal's
outcome for a host reaches the form only through Continue on that host (rule 3).

| The book keeps | In flight | Failed | Answered |
|---|---|---|---|
| nothing | Continue waits on the claim, and no order or store opens | `store.retry`, and no order or store opens | `domain_tier_not_paid` opens the store, a claim that holds reaches the DNS steps, and any other refusal is said and opens nothing |
| a check, which is a name's and never read here | as with nothing | as with nothing | as with nothing |
| a wait a first year left | the wait, and no claim is sent | the wait | the wait |
| a support case a first year left | the support line and Send to support | the same | the same |
| a refusal a first year left | the refusal and Close | the refusal | the refusal |
| a renewal's wait, support case or refusal for the host | the form, and Continue on that host shows the outcome and sends no claim | as in flight | as in flight |
| a first year delivered | the DNS steps, with the record and target blank and a Skeleton for the status | the DNS steps, `useDomain.statusUnread` and Check again | the DNS steps naming the record and target |

**Renewal.** The read is the claim sent on open, which only picks the early or the late line (rule
7). A kept outcome takes the place of the price and no claim is sent.

| The book keeps | In flight | Failed | Answered |
|---|---|---|---|
| nothing | the store's price, Pay waiting on the claim, and no line | the price and Pay, and no line | the price, Pay and the early or late line |
| a check, which is a name's and never read here | as with nothing | as with nothing | as with nothing |
| a wait for the host, opened by either screen | the wait | the wait | the wait |
| a support case for the host, from either screen | the support line and Send to support | the same | the same |
| a refusal for the host, from either screen | the refusal and Close | the refusal | the refusal |
| a renewal delivered | the line with the new end date | that line alone, since the renewal shows the poll only for a domain that was off the edge | the line with the new end date |

## Screens

- **A store build never quotes or pays in sats.** With `getDistribution()` at `store`,
  `LnAddressSheet` sells a name through `StoreNameOffer` and `UseMyDomainScreen` buys `domain_year`.
  A sats purchase already paid is still resumed in every build.
- **A purchase refused for good says what became of the money.** `storeRefusedKey` gives a refund
  the store already made, and a purchase made in a test environment, which the store never charges,
  their own lines; every other final refusal says how that store gives the money back.
- **A refusal that clears on its own says when, and the next press is the person's.** The order
  route answers `name_held_for_credit`, and the register `held_by_another_wallet` or
  `reservation_barred`, with `retry_at`, the unix second the obstacle clears (`retryAt` on
  `orderRefused`, `gatewayRetryAt` for the register). The name sheet says `store.heldTryLater` with
  that time, and the date when it is not today, and leaves the offer, or the support case or refusal
  on screen. It sends nothing by itself, however soon the name clears, so the next Buy or Use this
  name is a press like the first, which reads the credits again. A refusal that lands after another
  name was typed answers the press that met it, and the line names the name pressed (I2).
- **The sats sheet says when a held name clears.** The quote route answers `name_held_for_credit`
  with `retry_at` too, and the sheet that sells in sats says `store.heldTryLater` with that time in
  place of the name being taken. It waits for nothing, and the next See the price is the person's.
  An answer to See the price that arrives after another name was typed lands nowhere, whether it is
  the price, the held line, another refusal or a free name's register, so the sheet never offers to
  pay for a name the field no longer shows.
- **The sats sheet offers no price while its proof read is out.** Each opening reads the proof before
  the price button shows, and until that read answers the button's shape stands in its place. A read
  that fails, torn or refused by the platform, takes the sheet as unread. Only the latest opening's
  answer counts: an earlier one answers first in the proofs' queue (`purchase.ts`), so the latest says
  the same or newer. A read that never answers keeps the shape with no bound, a reopen included,
  since every later read and write of the proofs waits behind it in that queue; no price shows, and
  Pay could not write its proof. A new process reads again. A store build shows its offer meanwhile,
  which never reads the sats proof.
- **A Pay that fails and finds another purchase's proof waits on that purchase.** The slot is shared
  with the recovery sweep, so the sheet shows that purchase's line under its name, as the open does
  with a proof it finds. The quote whose Pay failed gets a line of its own above it,
  `receive.lnOtherPurchase`, which says its payment may or may not have gone and that what follows is
  about another payment. Its outcome is not known there (the sweep may have settled and cleared its
  proof, `recover.ts`), so the line claims neither, and it never takes the awaited purchase's line.
  The next opening drops it, since what the open reads is what is true then.
- **A paid answer that names more than a person giving the sats back is final too.** A name paid
  again for a wallet that already held it (`paidAgain`, thrown by `confirmName` though the gateway
  answers as the holder), a charge given back (`repaid: true`) and a name or year bought before
  (`bought_before`) are said by the sheet, the domain screen and the recovery card with no check again
  and no price. Only the answer for this charge says the sats came back, and support is offered only
  where sats are still to be given back. A gateway without the fields answers as it did.
- **Every final answer gives the slot up at the first answer, except two.** Given back, paid again
  and given back, bought before, and a holder's paid-again answer (a 200 thrown as `paid_again`) are
  recorded on the proof (`finalAnswer`) and the proof is then cleared (`releases` in `lnRefusal.ts`,
  `releasePending`, `releasePendingPurchase`), after the line is on screen or kept to be said. The next opening shows the offer, with no quote kept from the paid one, and no reader asks the
  gateway about that charge again: the sheet and the domain screen confirm only what the slot holds,
  and the gateway lists neither a settled nor a given-back charge to the sweep (`outstandingCharges`).
  The release marks the record as given up (`released`) before it clears it, and a record so marked,
  or one whose answer owes nothing, reads as no proof (`releasedProof`), so a clear that fails after
  one changes none of this, a holder's paid-again answer included.
  A fresh quote mints a fresh invoice, since the gateway never hands back a settled, refused, lapsed
  or given-back charge's (`liveChargeFor`). A holder's paid-again answer releases because what is
  owed back is tracked on the charge (`paid_again_at`), not on the device.
- **The two owed with nothing delivered keep the slot.** A refusal for good (`kept`) and a 409
  paid-again answer, whose name is gone since, keep the proof, and each opening asks again until the
  gateway says the sats came back; that answer then releases.
- **No paid-again answer swaps an address in use.** On a holder's answer the sheet and the sweep put
  the name on the wallet only while it answers on no address at all (`takeName` in `recover.ts`, which
  also refuses on an address it could not read, and reads the address and registers in one turn of the
  address queue, `sparkTakeLnAddress`, so the sheet and the sweep taking one name register it once and
  a register that lands meanwhile is never replaced), inside the reader's guard: the sheet reads the answer
  within the opening or press that asked, a Pay and an opening asking about one payment take the name
  through one guard of its own, and one sweep runs at a time. The slot is given up right
  after, so this happens once. A name the wallet holds can be taken from the sheet for free at any time
  (`already_paid`).
- **A released line is said once.** Its line never lives on the proof, which has one record per kind.
  Only the reader that claimed a reference shows its line. A claim (`claimLine` in
  `src/wallet/releasedLines.ts`) runs whole in one turn of the list's queue and answers `shown` when
  the reference is already recorded as shown, writing nothing; `claimed` after taking out any line
  kept for it and recording it as shown; or `unknown` when the list cannot be read or the write does
  not land, writing nothing. A view counts as on screen only while the app is in the foreground
  (`useAppActive`), since a line painted while the app is away is seen by nobody and dies with the
  process. The view that heard the answer itself (the sheet visible, the domain screen mounted, the
  sheet after a holder's address read) claims before it shows, and decides when the claim is answered,
  with no await before the paint (`sayOnce`): on screen, a claim or an unknown shows the line and a
  reference shown elsewhere passes over it to a fresh quote; closed or sent to the background
  meanwhile, a claim puts the line back for the next view and an unknown keeps it. A view already
  closed, or in the background, when the answer lands keeps the line in its own list first (per paying wallet, any number, one per kind and
  reference, with the address or host as it was heard), and only then is the slot given up; a sheet
  opened again meanwhile claims it. The sweep keeps every released answer it hears, whether or not the
  charge held the slot, and its card is a line only once a claim hands that line back, read after the
  sweep's questions were answered (throttled or not), and claimed only while the app is in the
  foreground; one claimed as the app leaves goes back to the list. A sweep that asked the gateway
  nothing, throttled or unable to fetch the list, weighs the card Home has on screen against the kept
  lines (`showing`): a line it outranks, or one as urgent, stays in the list, so a card asking for a
  person is never replaced by a line until a sweep has news. The sheet's opening and the domain screen's
  mount, each with no proof held and for its own kind, take the oldest kept line in one turn and put
  it back when the view closed while taking it. A note skips a reference recorded as shown, so an
  answer heard after a claim is never kept again. A crash between keeping the line and giving the slot
  up leaves the proof, which the next reader confirms again, hears the same answer about and says
  once. A list file that cannot be read is set aside by the next line kept and never written over, and
  never keeps a slot.
  Residues: a crash between saying a line and giving the slot up asks again at the next opening, and
  that reader does not say the line again; a crash between a claim and its paint loses that line; with
  a list file that cannot be read, or a write that does not land, a view shows the fresh answer it
  heard and another reader can show it again; a sheet closed when its answer lands and opened again
  inside the write that gives the slot up, with an older name line kept, takes and shows the older line,
  and the claim of the newer one then paints over it, so both are recorded as shown and the older is on
  screen for about a frame, which is accepted; the shown records keep the newest 16 references, so an
  answer to an older one heard later is kept again; a list the platform refuses to read loses a line
  heard meanwhile, while the slot is given up all the same.
- **A wait stands only on a proof still in the slot.** The recovery sweep shares the slot with the
  address sheet and the domain screen, and can confirm, give up or clear a proof while one of them says
  that payment is coming. Every write that leaves a reference no longer owed tells the views once its
  turn of the queue is over (`onPendingGone` in `purchase.ts`, `onPendingPurchaseGone` in
  `domainOnboard.ts`), with how it left, which the writer knows: delivered, from the clear after a grant
  (`clearGranted`, `clearGrantedPurchase`, which carries the year the grant answered), or gone, from
  every other way out (a clear, a release, a mark naming an answer that owes nothing, a disowned
  record, an expired charge, a wallet's data forgotten). A write that leaves it owed, or that does not
  land, tells nobody. A view mounted then, on screen or closed, keeps how each reference left and acts
  on its next render. On gone it drops the wait, with the quote it paid, the line about another
  payment beside it and the line its last press left, which promised the payment would complete, and
  goes on as a released slot, which offers a fresh quote; a first year goes back to the form, and a
  store build's domain screen reads the store's book as an open with no proof does, which gives Pay
  back. On delivered it shows what its own grant shows, with nothing asked again and no price: the
  sheet reads the address and hands it to the screen, which closes the sheet (a read that fails closes
  it all the same, and the screen reads the address again), and the domain screen shows the year
  renewed or a first year's DNS steps. A line the view claimed and said for an answer that gave the
  slot up stays. Home's recovery card about a payment still in its slot (landing, or a name granted
  and waiting or blocked) goes either way, and a card about a final answer stays. An opening of the
  sheet that reads no proof drops any wait it still carries the same way. Every confirmation of a proof
  (Check again, the question at an opening or a mount, and on the domain screen the Pay after its send
  and a Continue or Pay that met a held proof) reads the slot last before it asks, and a reference no
  longer held there is passed over with nothing asked, as it left; an opening or a mount whose proof
  went gone goes on as one that read none, so it takes a line kept for it. A wait drops only on a read
  of the slot, in the same turn and after what set the drop off, that finds its reference no longer
  held; an announcement is that read, since its writer has just taken the proof out. A failure, of the
  question or of the identity read before it, reads the slot again: held keeps the wait with the line
  the press or the opening says for a failure, and gone drops it, with no line about that payment. How
  a reference left only chooses what a drop shows, delivered or a fresh start, and never decides that a
  wait drops, because a Pay files the same quote again after a send that failed and the sweep files back
  a charge it finds; the read before a question or after a failure that finds the reference held
  forgets it. A read that fails is not a proof gone: it asks nothing, drops nothing and shows the
  record as unread. Dropping a wait never shows the released line itself, which reaches the screen only
  through the reader that claims it, the sweep's card or the next view.
  Five races are left as accepted residues. A release that lands while a confirmation is already out is
  still asked about that once, and its answer is the same final word, said under the claim above. A
  confirmation already out when the sweep delivers, answered as not seen after, puts the wait back over
  the delivered state until the next Check again on the domain screen or the next opening of the sheet
  (`settle` at `UseMyDomainScreen.tsx:535`, `resume` at `LnAddressSheet.tsx:438`). A Home sweep in
  flight when another reader gives the proof up can put the card about a payment still landing back on
  screen until the next sweep (`HomeScreen.tsx:374`). A sheet whose own proof leaves while another
  proof is owed goes on as a released slot and offers a price beside that proof, and Pay still answers
  owed and puts that proof on screen (`LnAddressSheet.tsx:243` and `:734`). An opening during the
  delivered address read that takes a kept line of another reference does not hand the address on, and
  the screen reads the address again when the sheet closes (`LnAddressSheet.tsx:283`,
  `LnAddressScreen.tsx:469`).
- **The sweep files and reads under the wallet it asked about.** Home sweeps as the wallet whose key signs
  (`sparkConnectedWalletId`), which right after a switch is still the previous wallet, and the sweep
  names that wallet to every read and write of the name slot, the year record and the kept lines
  (`walletId` in `purchase.ts`, `domainOnboard.ts` and `releasedLines.ts`); the views resolve the
  active wallet as before. A switch while its questions are out leaves the wallet switched to with what
  it had. The card goes up only while that wallet is still the active one: the sweep answers none
  otherwise, or when the registry cannot be read (`showCard`), Home drops an answer a switch overtook
  and takes its card down on a switch, and the lines stay listed for the asked wallet. A card made from
  a kept line left the list when the sweep claimed it, so one Home drops before painting it, overtaken
  by a switch anywhere after the claim, replaced by a newer card, dismissed with the card it would
  replace, or left when the screen goes, is handed back (`putBackCard`) and its line returns to the
  asked wallet's list, for the next view or sweep of that wallet to say once. Every write to the list
  that follows a question or a take (a note of the answer heard, a claim's shown mark, a take, a
  put-back) carries the scope its operation started on (`LineScope` in `releasedLines.ts`): the wallet
  it asked or took on, never the one active when the write runs, and the number of forgets run by
  then. Home reads the sweep's in the same step that picks the wallet the sweep asks for, before it
  reads that wallet's key and deletion mark, and hands it to the sweep (`RecoverDeps.lines`); it takes
  the list of wallets in that same step and asks nothing for a connected wallet the list no longer
  holds, since a removal that finished before the pick already forgot its lines; a view
  reads its own as its question or its take starts. Such a write lands nothing once that wallet's lines
  were forgotten after the scope started (the wallet removed, or its data deleted at Voltz), whichever
  of the forget and the write the list's queue runs first, so the same words taking the id again bring
  no line or mark back; a claim then answers `unknown`, which a view on screen shows and a closed one
  keeps for nobody. The marks, releases and clears of a proof's slot that a view's answer leads to go
  to the scope's wallet as well (`onAskedWallet`), so a switch while the question is out gives up or
  marks the asked wallet's slot and leaves the wallet switched to as it was; a scope whose wallet could
  not be read writes nothing there. Painted means
  committed beside a balance, the only place the card is drawn; a painted card gives nothing back. Any other card
  so dropped is not kept, which is accepted: a proof still in the slot is said by the sheet or the
  domain screen on its next opening, a store credit by the next sweep that asks, and a name already put
  on the wallet is not announced again.
- **The sweep puts a name only on the wallet that paid.** Its confirmation is unsigned, so a switch and
  reconnect while it is out would register the name with the key of the wallet switched to, and a name
  the gateway gives that key for free would land there. The sweep's take names the asked wallet
  (`sparkTakeLnAddress` with `walletId`), which reads and registers nothing when the session is on
  another wallet as its turn starts, or when the connection it read on is no longer live right before
  the register. The charge is then reported as waiting, nothing is cleared, and the proof stays for
  that wallet's address screen. A holder's paid-again answer still gives the slot up and keeps its
  line, as it does beside an address in use. The sheet follows the same rule: a grant heard by its
  opening or its Pay registers the name only while the live connection is the wallet the question
  started on, read in the step that starts the address read and again right before the register
  (`sparkRegisterLnAddress` with `paidBy`), and its holder's take names that wallet. Otherwise, or
  when the question could not read its wallet, it registers nothing, clears nothing, says the name
  waits, and the proof stays in the slot of the wallet that paid.
- **A Pay writes only the slot of the wallet its press started on.** The record filed before the
  send, its promotion, and its drop on every way out before the money moves or after a send that
  failed go to that wallet (`payAndSettle` with `walletId`, and the domain screen's Pay), and so does
  the sheet's drop of an unpaid quote's record on close, so a switch while the send is out never
  leaves the pressing wallet's record behind. The domain screen's question after the send, and its
  question about an older payment the press found in the slot, read, mark, release and clear the record
  of that wallet and keep their line under the press's scope (`settle` with `pressed`); asked from
  anywhere else, the question reads its own scope as it starts. A send that threw is read against that
  wallet's slot too, in the sheet and on the domain screen, so the wallet switched to never puts its own
  payment on screen in place of this one or keeps the pressing wallet's record from its drop. A press
  that could not read its wallet files and sends nothing, and reads as a record it cannot read.
- **A name taken for free keeps every paid proof.** Its claim names no charge, so it drops only a record
  of this wallet standing for no payment, a send that never left (`clearUnpaid`), and leaves a paid
  proof the sweep filed meanwhile, released or not, and the mark disowning the unkeyed record. Every
  other clear of the slot or the year record names its reference. The name goes on, and the clear goes
  to, the wallet active as the sheet's press started (or as the store offer's claim started), and only
  while the live connection is that wallet's, read in the step that starts the address read and again
  inside the register's turn (`sparkRegisterLnAddress` with its wallet). After a switch that moved the
  session, or a press that could not read its wallet, nothing is read, registered or cleared, and the
  sheet stays on the name for the next press.
- **A name purchase is a credit of the name's tier** (`src/wallet/nameCredit.ts` copies the gateway's
  ladder), spent by the signed intent and the usual register. A name lost to somebody else between
  the two stays taken in the sheet, and the credit goes on only to a name of its tier. A credit the
  list marks `held` (a withdrawal of its purchase is open) is spent on nothing at the gateway, so
  `spendable` leaves it out of every offer, of what a register could spend and of the recovery; a
  list without the mark offers as before.
- **A register with no clear answer is read back before anything is offered.** The address and the
  credits decide it. A held address is done, and so is one of the credits that register could spend
  now spent on the name; a reserved credit is finishing, and a list that cannot be read is the check,
  kept in the book by `keepNameCheck` so a reopen shows it again.
  The gateway's list keeps every credit for ever and names each by `id`, the SHA-256 of its payment
  reference, the same on every read and through every state. A register keeps the ids of the credits
  it could spend (`attemptCredits`), so a credit an earlier register spent on the same name never
  reads as this one done, and a row without an id makes the whole list unreadable. A register is sent
  only with the credits read first.

## Withdrawal

A buyer may withdraw from a name or a domain year in its first 14 days, on every rail.
`src/wallet/withdrawal.ts` reads the purchases the credits route lists beside the credits, signs
`voltz-withdraw:v1` and maps the answers; `components/WithdrawalSection.tsx` draws it on the address
screen (names) and the domain screen (years).

- **The row follows the gateway.** It shows only while the list says `withdrawable` for the
  purchase, and gives way to the withdrawal's state once one exists, at once on the gateway's answer
  and then as the next list read says. A list read in flight, failed or never answering draws
  nothing; a row the list cannot read in full (an Apple one without its transaction id) is left out.
- **Only the wallet that paid signs.** The list is read for a wallet that is both active and
  connected, read again when the connection reaches another wallet (a focus right after a switch can
  come before the SDK reconnects), and dropped at once when the connection leaves the wallet it was
  read for. The confirmation keeps that wallet. Before signing it checks the active wallet, the
  loop checks the connected one before every try, and `sparkSignMessage` and `sparkOwnSparkAddress`
  refuse another identity, so a switch while the confirmation is open sends nothing and says so.
- **The receipt is the gateway's.** It shows `requestedAt` from the answer, never the device's
  clock, and Save receipt shares it with the purchase reference. A 5xx, an answer that is not the
  gateway's and no connection say the request could not be confirmed; a repeat answers the first
  receipt, so asking again is safe.
- **The receipt follows the answer's state.** Google's 200 can already be refunded or failed, and a
  repeat answers the state the withdrawal is in now, so the line under the receipt and the row's patch
  after it come from that state (`receiptNextLine`): requested gives the rail's line, refunded the
  refund's own date (`outcomeAt`, undated from a gateway that does not send it), failed a line that
  Voltz was alerted to finish it by hand with no time promised, lapsed that Apple sent no word about
  the request in 14 days, which is all the gateway knows. Apple's sheet opens only for an answer
  still requested.
- **Each rail says only what it holds.** Refunded is said only from the gateway's state, 3 business
  days only on the sats rail, and an Apple decline says only that Apple did not approve it. The
  consent box is on Apple alone, starts unticked, and only a tick signs 1. It says what the gateway
  answers Apple's consumption request with (the consent, delivered, no free sample or trial before
  the purchase, a full refund preferred) and nothing more. A store's time is said only as that
  store's own word. Apple's page gives 24 to 48 hours for an update once the request is sent, and
  Google's says the time depends on how the buyer paid, so the Google receipt names none. The sats
  rail sends the wallet's own mainnet Spark address, and any other form sends nothing.
- **Apple's sheet opens after the 200.** `requestStoreRefund` wraps
  `Transaction.beginRefundRequest(for:in:)` for the transaction id the answer names and returns
  sent, closed, duplicate or failed (StoreKit's `RefundRequestError` has `duplicateRequest` and
  `failed` and nothing else). A closed or failed sheet keeps Open the request with Apple, and so
  does every withdrawal still waiting on Apple. Google has no sheet; the module answers unsupported.
- **An Apple purchase is sent only where Apple's sheet opens** (`storeRefundSheetAvailable`, an
  iPhone with the bridge). Anywhere else Apple would never get the request, so the row, and the way
  back to the sheet, give way to a line that points to an iPhone with this wallet or to Apple's refund
  page, and nothing is posted; `requestWithdrawal` refuses such a purchase itself, before signing. A withdrawal Apple sends no word about for 14 days lapses at the
  gateway, which frees the credit, and the list says only that Apple sent no word in 14 days.
- The confirmation names the amount only for a sats charge, from the list's `amountSats`; a store's
  price is the store's to say, so the store rails name the item and the date only.
- `withdrawal.test.ts` holds the statement against vectors the gateway builds byte for byte, and
  `withdrawalSection.test.tsx` drives the screens' half against a gateway double. The sheet itself is
  only seen on a device.

## What the app needs from the gateway

Every store, credits, withdrawal and name request goes to the build's domain (`currentDeps`), and the
domain it is about travels in the signed body as `host`: the order, its confirm, a spend, a quote and
its confirm. A customer domain's own hostname is the customer's to keep, so whoever answers it after a
lapse or a DNS change would receive the wallet's signed statements and could answer a confirm with a
delivery that never happened; a frozen domain is off the edge, so a renewal sent there reached nobody.
The gateway reads `host` from the body on those five routes (voltz-gateway `src/actedHost.ts`) and
must be deployed before an app that sends it, or a wallet on its own domain is refused there.

A build without `BREEZ_LNURL_DOMAIN`, which only a development build is, has no build domain, so
`currentDeps` falls back to the domain in use and still sends these requests to a customer's own
hostname.

The line above Pay, that the purchase can be cancelled within 14 days here, is the app's own text and
shows against any gateway. The rest depends on fields of the gateway's answers:

- **`purchases`** on the credits route. The withdrawal row shows only where the route answers it;
  without it the screen promises a way to cancel that it never offers.
- **`held`** on a credit a withdrawal holds, and a lapse of an Apple withdrawal Apple sends no word
  about for 14 days. Without the lapse a withdrawal whose Apple sheet was never sent holds its credit
  for good, and without `held` the name sheet offers a credit a withdrawal holds and the register is
  refused.
- **`amountSats`** on a sats withdrawal and **`outcomeAt`** on the receipt. Without them a sats
  confirmation names no amount and a refund in the receipt reads undated.
- **`id`** on every credit. `storeCredits` reads a list with any row lacking an id as no list at all,
  so every read of the credits fails. The name sheet then shows `store.unread` and sells nothing
  outside a domain whose names are free, a credit already paid is never offered, and every check
  stays open.

## Tests

- Jest covers `store.ts` and `storePurchase.ts` against the double, and `storeAndroid.test.ts` and
  `storeIos.test.ts` read the native sources for the rules above.
- `VoltzWalletTests` runs `VoltzStoreCore` against StoreKit's local test environment with
  `ios/VoltzWallet/Store/VoltzStore.storekit`. It holds cases for purchase, finish by id, cancel,
  network failure, Ask to Buy approved and declined, interrupted purchase, refund and the queue. The
  StoreKit ones among them skip on the iOS 26.5 runtime (below), so a green run there says nothing
  about them. The target compiles the core's own source and has no CocoaPods integration. Run it with
  `xcodebuild test -workspace ios/VoltzWallet.xcworkspace -scheme VoltzWallet -destination 'platform=iOS Simulator,name=<simulator>'`.
  The gateway refuses the Xcode environment, so this tests the bridge and never a delivery.
- On the iOS 26.5 simulator runtime StoreKit testing does not load outside an Xcode debug session
  (FB22237318, https://developer.apple.com/forums/thread/826971). Every `SKTestSession` call logs
  `SKInternalErrorDomain Code=3` and StoreKit lists no product, while storekitd logs that the app "is
  not installed for development". The StoreKit cases skip on that runtime and fail on any other where
  no product loads. The queue, the error map, the reference check and the window scene run anywhere.
- Nothing here runs a real store. The sandbox, a licence tester on Play and a device are still
  needed for the cases the documentation leaves open.

## Dependencies

StoreKit 2 ships with iOS. Android adds `com.android.billingclient:billing`, which brings
`play-services-location` and `play-services-places-placereport`, and nothing else in the
`releaseRuntimeClasspath` changes version. The three are pinned by checksum in
`android/gradle/verification-metadata.xml`; bumping one follows `docs/supply-chain.md`.
