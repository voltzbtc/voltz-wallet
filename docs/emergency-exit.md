# Emergency exit

Moves bitcoin from Spark onto the Bitcoin chain, for funds that already left the balance and, when the
operators stop serving the wallet, for the sat leaves still in it. Spark tokens never leave this way:
the exit only walks sat leaves. It follows the SDK's guide,
`recover_funds.md`, whose calls are `prepareRecoverFunds`, `recoverFunds` and `checkRecoverFunds`.

Everything here sits behind `EMERGENCY_EXIT_LIVE` in `src/wallet/emergencyExit.ts`, which ships on
after the measures on the real SDK listed under Measured and not, below. Off, the drawer has no row,
the Home draws no card, the route does not exist and no pass runs. Only the suite can force it either
way; a release or development bundle keeps the value it ships with, whatever the seam is asked.
`__tests__/emergencyExitSwitch.test.tsx` holds both.

## Modules

| Module | Holds |
|---|---|
| `spark.ts` | the three SDK calls, and the plain shapes of steps, verdicts and skipped leaves |
| `exitQuote.ts` | whether a quote may go on, what arrives and whether that is a floor (`exitArriving`), whether a plan states it at all (`planArriving`), when a quote is too old, the outputs and size of a raw transaction, the coins a child takes |
| `exitPlan.ts` | the plan file, and the only writes to it |
| `exitPass.ts` | `prepareExit`, `startExit`, `runExitPass`, `payMore`, `confirmAsk`, `leaveExit` |
| `exitFeeKey.ts` | the fee key, handed to a callback and wiped |
| `chainRelay.ts` | the two public chain hosts, which take hex, txids and addresses and nothing else |
| `EmergencyExitScreen.tsx` | the steps: first screen, address, review, fee, follow-up |
| `useHomeExit.ts` | one pass when Home gains focus with a plan alive, and whether that pass waits on the person (`waitsOnPerson`) |
| `exitHold.ts` | whether a plan alive holds Send and Receive, for the active and the connected wallet, every spend `spark.ts` signs, every receive and lightning address it makes, claims or reads, and the SDK's leaf optimizer and stable balance at connect |

## The flow

1. **Quote.** `prepareExit` refuses when a plan is alive, since preparing the same leaves again makes
   a second recovery that races the first. The rate is `sparkExitFeeRate`, and with no rate nothing
   is quoted: a guess under the relay minimum goes nowhere.
2. **Review.** `quoteVerdict` refuses a value that does not exceed `totalFeeSats`, the totals being
   what include the shared fan-out fee, and each recovery kind with leaves that leaves under 546 sats,
   the largest dust limit of any address type, since the SDK builds such a sweep and no node relays it.
   It warns past a fifth of the value. What arrives is the value less `cooperativeFeeSats`,
   `refundFeeSats` and `sweepFeeSats`, never below zero. Funding the fees did not use comes back on top
   of that in the sweep (the guide: the sweep fee and a per-branch allowance "come back to you in the
   sweep"), so with funding the figure is a floor and the review and the follow-up's question say "at
   least" (`exitArriving`). On the measured exit the sweep the plan built pays more than the review
   said. Without funding nothing comes back and the figure stands plain. Value less `totalFeeSats` is
   wrong, since it charges CPFP and fan-out fees to the funds a second time.
3. **Fee.** Only a quote with `funding` has this step. The person pays `singleUtxoSats` to an address
   of `m/84'/0'/0'/0/0` from another wallet, since a Spark wallet holds no UTXO, and only confirmed
   outputs count: the children are TRUC transactions, which nodes do not relay on an unconfirmed input.
4. **Build.** `startExit` refuses what the verdict refuses, and quotes again past 30 minutes or when
   the rate rose. The key is derived from
   the words and passphrase of the plan's wallet, used, and wiped. A quote with no `funding` takes no
   inputs, no signer and no read of the words. A failed build writes nothing and leaves the money at
   the fee address, and a process killed after the answer and before the write lost nothing, since
   nothing was sent. The verdict runs again on the totals of the answer, and on the output of each
   cooperative and sweep transaction read from its hex, because real coins weigh more than the quote
   assumed and the quote gives only a total for cooperative leaves. A build only signs, so one that
   fails here is discarded at no cost.
5. **Follow.** A pass checks, writes, builds again when the SDK says `redo`, sends what is ready, and
   writes. It runs every 30 seconds with the screen open and once when Home gains focus. There is no
   background work.

## Send while an exit is alive

A send can spend the sat leaves an exit is taking on-chain, and a plan does not record which selection
made it, so Send neither prepares nor confirms while the wallet holds any live plan. It reads on each
focus, since the exit's screen opens over it, and again at the press of Confirm, which holds the button
busy while it reads. The wallet that signs is the connected one, which a switch without reconnecting
leaves apart from the active one, so both are asked. A plan the platform will not read, a wallet list
that will not read, and a read with no answer in five seconds hold Send as well, with a line that says
the plan could not be read rather than that an exit is under way. Either line comes with a way to the
follow-up. A plan in `done` or `closed` holds nothing.

Every spend is held again in `spark.ts`, the one place they all pass, which covers Convert, the domain
and name payments in sats, the dollar balance, and an exit that starts between Send's read and the SDK
call: `sendPayment`, `lnurlPay`, each conversion leg and turning the dollar balance on throw
`SpendHeldByExit` before the SDK is called while the signing wallet's plan is alive or unread, and the
screens say it in the same two lines, with a purchase's proof dropped since nothing left. Refunding a
deposit (it spends the deposit's own output, no leaf), turning the dollar balance off (it sells only the
token and stops the SDK's own sale of loose sats) and the exit's own calls go on.

## Receive while an exit is alive

Receives are held at the source, as spends are. Every `spark.ts` function that makes or claims a
receive for the connected wallet throws `ReceiveHeldByExit` before the SDK is called while that
wallet's plan is alive or unread: `sparkReceive` (a Lightning invoice, a Bitcoin address, a Spark
address or invoice, in sats or a token), `sparkOwnSparkAddress` (where a refund from the gateway is
asked to land), `sparkReceiveStable` (a cross-chain receive), `sparkParseLnurlWithdraw` and
`sparkConfirmLnurlWithdraw` (a voucher pulled in), `sparkClaimDeposit`, and `sparkBuyBitcoinUrl`, since
the SDK hands Moonpay the wallet's static deposit address (`buy.rs`, SDK 0.28). The wallet asked is the
connected one, captured before the read, since it is the one the SDK receives into, and a connection
replaced during the read receives nothing. `classifyWalletError` maps the error to `receiveHeld` and
`receiveHeldUnread`, which `walletErrorKey` says with the Receive lines. So a voucher scanned on a
held wallet opens Redeem on that line, whatever screen opened it.

`ReceiveScreen` still reads the hold on each focus and draws no code before the read answers, the
refocus included: a focus clears what the last read said, so a code minted before the exit started is
never drawn while the new read is in flight. Copy and Share read again at the press, on Receive and
on the cross-chain panel alike.

The lightning address is held the same way, before the SDK is asked anything: the ensure a screen
asks for, which reads the address and can register one (`sparkEnsureLnAddress`), the plain read a
screen shows or compares (`sparkGetLnAddress`), a chosen name (`sparkRegisterLnAddress`), a paid name
the purchase sweep takes (`sparkTakeLnAddress`, whose refusal leaves the proof waiting) and a name
another wallet gave (`sparkClaimLnAddressTransfer`). The availability check, giving a name away and
deleting it make no way to receive and are not held.

An address registered before the exit and the deposit address are served by others and still take
payments the app cannot stop, and the SDK still claims a deposit on its own when the claim's fee fits
its ceiling. With the optimizer and the stable balance off those add leaves and spend none.

## What the SDK spends on its own while an exit is alive

The SDK swaps leaves on its own after any payment, sent or received (guide/optimize.html: it "triggers
optimization after each payment"), and with the default multiplicity a payment in that takes the
balance past a power of two swaps the larger leaves (`swap_minimizing_leaves` in `leaf_optimizer.rs`,
SDK 0.28). An active stable balance sells the sats of any receive above its threshold
(guide/stable_balance.html, "On receive"), spending `Available` leaves. Either can spend a leaf the
exit is taking and waste the fees paid for its steps.
`leafOptimizationConfig.autoEnabled` is read once, at connect (guide/config.html), and the binding has
no call that stops a running instance's optimizer: `optimizeLeaves` only starts a manual run, and fails
with `OptimizationAlreadyRunning` beside an automatic one. The stable balance is built at connect too,
and `Config` has no switch for its automatic part alone. So a connection is the unit:

- A wallet whose plan is alive or unread connects with `autoEnabled` false and the multiplicity it had,
  and with no `stableBalanceConfig`, so the SDK builds neither the stable balance middleware nor its
  conversion worker (`build_stable_balance` in `sdk_builder.rs`) (`buildConfig`). Each `Connection`
  records which way it was opened (`spendsOnItsOwn`). The chosen label stays in the SDK's own storage:
  while held, `getUserSettings` reads the dollar balance as off, the SDK refuses a change to it, and
  turning it on is refused before that as a spend; the first connection request after the exit, on
  any path, brings it back.
- `connectInTurn` asks `exitHoldOnSigner` on every connect, and keeps a live connection of the same
  wallet only when it was opened under that answer (`liveToKeep`): one that spends on its own is
  replaced while the wallet is held, and one opened while it was held is replaced once the hold reads
  none. A held connection with a send, a prepare or an address change in flight stays until the next
  request, since dropping it takes that call down; the check runs again in the step that drops.
- `connectActive`'s fast path, which returns without a turn on every focus and payment event, asks the
  hold too and takes that shortcut only for a connection `liveToKeep` keeps. Otherwise it goes through
  `connectInTurn`, which replaces it.
- `sendReady`, the one place a pass transmits, calls `sparkStopSpendsOnItsOwn` first. A connection
  that still spends on its own is replaced, and when that fails, or the connection is not the plan's
  wallet, nothing goes out and the pass answers `offline`. The plan is on disk before the first pass,
  so the replacement's own hold read sees it.

A pass that runs on the old connection during the replacement fails and the next one goes on. Once a
plan ends, or a plan that could not be read reads as ended, the next connection request replaces the
held connection with one that has both, so Home's next load brings the dollar mode back without a
restart or a wallet switch.

## Home while an exit is alive

`balanceSats` is the sum of the leaves whose status is `Available` (`process_get_leaves` in
`spark/src/tree/store.rs` puts every other status in `not_available`, and `Leaves::balance` adds only
the available ones). Under `All` the plan's unilateral leaves start in it, and the guide says a
unilateral exit "takes its leaves out of the balance too" once a sync sees them leave; on the measured
exit that had not happened with 6 of 15 steps confirmed, and it happens branch by branch. The binding
gives no status per leaf, so nothing on the device can say which of the plan's leaves the figure still
counts, and taking them off by what the plan records counts twice every leaf the SDK already left out.

So no figure is computed from the plan. While a plan is alive or unread, Home and the bitcoin
`AssetDetailScreen` draw the SDK's own figure, never labelled the total (the hero says bitcoin balance
and leaves the tokens to the list), under a line saying that while the exit runs the wallet sends
nothing and gives out no address to receive, and that part of the figure may be leaving through the
exit. The exit card states only the floor of what arrives (below). The plan is read with a five second
limit, and a read that fails or does not answer counts as unread, which draws the same figure and line,
and the card says the exit could not be read.

The first screen and the follow-up ask the person to open the app every 8 hours or so, and the app opens
on Home, so a question only the follow-up showed could go unseen. When the pass Home runs on focus ends waiting on the person, for new figures
to confirm (`ask`) or more money at the fee address (`short`), the card says the exit is waiting for
them and states no figure, and its tap opens the follow-up, whose own pass offers the question. Nothing
of the question is kept: a question is figures in memory, and the plan stays on disk, alive and marked
`redo` when the check said so, so after a restart the pass Home runs on focus finds it again. Each focus
starts from the plan, so a question answered on the follow-up stops showing on Home once the next pass
goes on.

## What arrives, on every screen

`exitArriving` in `exitQuote.ts` is the one figure of what arrives, read from a quote or from the plan's
recovery: the value less `cooperativeFeeSats`, `refundFeeSats` and `sweepFeeSats`, never below zero,
and marked as a floor when the quote or plan has funding, whose leftover comes back in the sweep on
top. The plan does not know that leftover, so it is never added. The review, the question of a pass
and the follow-up draw it with "at least" when it is a floor, and the Home card says it the same way.
The value before fees is labelled as such on the review and never as what moves or arrives.

A plan whose last check answered `redo` states no figure at all (`planArriving`): the chain took another
way than its transactions, as when the operators' own version of a step lands, so what it says arrives
is of an exit that will not happen. Home's card and the follow-up leave the figure out until a new build
writes a plan, which it records as valid itself, and the question of a pass shows the new figures
instead.

The floor holds while each step goes out once it is ready (the guide: an exit whose steps go out as
they become `Ready` "keeps the fee split of the quote"). A step left waiting about 50 blocks past its
timelock can go out in the operators' version, whose fee comes off the leaf. There is no background
work, so a pass runs only with the exit's screen open or when Home gains focus. Until the next pass
rebuilds the plan, which then carries that fee in `refundFeeSats`, the figure can read above what
arrives. The first screen and the follow-up ask the person to open the app every 8 hours or so, and say
that after longer part of the fee can come out of what arrives (`introOpen`, `trackBody`).

## What goes out

`ready` always. `unverified` only on a cooperative recovery: on a tree step the funding may be spent
already, and only building again settles that, so a pass builds again once a quote shows a whole read
of the chain, and sends the `ready` steps meanwhile. A build that still holds such a step never replaces
a plan. A step with `cpfpTxHex` goes as a pair, any other alone. Sending twice is harmless, so a pass
keeps no memory of what it sent.

`done` comes only from the SDK's verdict, however many steps read confirmed.

## The fee address

The fee address is the exit's working capital, not a place where money waits. A child has one output,
its inputs less its fee, paid to the script of its first input, and the next child of the branch spends
that change. The fan-out pays the same script, one output per branch. So with a plan alive what sits
there is the input of a transaction still to come, and spending it elsewhere breaks that child: the
check looks only at the first input and the anchor, so it answers `Valid` and the hosts refuse for good.
The SDK hands back a child's hex and no txid, so no read of the address can tell change from a spare
coin.

Hence the rule of the screens. Before a plan exists they say what is confirmed and on its way. While one
is alive they say nothing of what is there, and the address appears only as where to pay when the fee
falls short. Once a plan ended, at `done` and at `closed` alike, one read says what stayed and that the
same words and passphrase open it in any BIP84 wallet, with a line of its own for what is on its way and
no figure when the read fails. A closed plan sends no child again, and a new exit reads the address
afresh before it builds.

## What is missing

`InsufficientCpfpFunds` carries `requiredSats`, the whole of what one of four points in the SDK wants,
never the difference. The app cannot tell which point spoke. `build` does no sum, because the funding it
was handed counts spent coins at face value. What is missing is read at the address after the failure:
`requiredSats` less what is confirmed there, plus 68 vbytes at the quote's rate, the weight of the coin
being asked for, or paying the exact figure falls short again.

A figure shows only with a good read, nothing on its way and a result above zero. The SDK counts a coin a
pending child spent, which the address no longer lists, so with value on its way the screen asks to wait.
Without a figure it says the fee fell short and shows where to pay.

## How many coins a child takes

Every CPFP child is a TRUC transaction with an unconfirmed parent, which BIP431 caps at 1,000 vbytes,
and the first child of a branch spends every coin the build is handed, plus the parent's anchor, into one
change. At the 72 byte signature the SDK sizes fees on, 13 P2WPKH coins make 967 vbytes and 14 make
1,035, so `fundingCoins` hands a build at most 13, the largest first. Past the cap it leaves out a coin
worth no more than its own 68 vbytes at the rate, since that coin adds more fee than value, and what
remains is the set of 13 or fewer that pays the most.

When those coins fall short, a new coin would push the smallest out of the child, so the figure is what
the SDK wants less the other twelve, and the screen asks for it as one payment. More small coins would
never get there.

The SDK follows spent funding to what it became, which can hand a child more coins than the build gave
it, so `build` also reads the size of every child it gets back. A child over the limit discards the
build, which only signed: nothing is written and nothing goes out. A first build ends `failed`, and a new
build leaves the plan as it was and the pass `stuck`. Hex that does not parse is not refused on size,
since a parser's limit is no reason to stop an exit.

## Starting over

A pass builds again on a `redo`, on a kept recovery the SDK refuses as input, and on a tree step left
`unverified`. Each prepares with `Specific`, naming the plan's leaves, at the higher of the plan's rate
and the medium rate, since a lower one would lose the replacement on the network. The build takes the
kept `fundingInputs` plus anything confirmed at the fee address, and the SDK follows spent funding to
what it became, so a failed read of the address goes on with what is kept. `All` and `RecoverableOnly`
would drop a leaf the new rate makes uneconomical. `Specific` takes it whether or not it is worth it, so
every route passes the verdict of the Review, on the quote and again on what comes back.

A new build that costs a higher rate, delivers less out of the value, or leaves a leaf out sends nothing:
it becomes a question held in memory, which the follow-up offers and Home's card points to (Home while an
exit is alive, above). A new coin at the fee address does not improve the comparison, which looks only at
what comes out of the value.

`payMore` quotes at the fast rate and builds nothing. `confirmAsk` serves it and the question of a pass:
it takes the turn, reads the plan again, quotes again when the figures aged or the plan changed
transactions, and only then builds. With figures with no value there is no confirm. With the figures on
screen no pass runs.

A plan ends short of `done` in the `closed` verdict, which is not alive, stays until its screen is closed
and is written over by a new start. That happens when a new quote has no leaves left and none was skipped
for a failed read, as when the same words finished the exit on another device, when a build comes back
with no transactions and no failed leaves, and when the person leaves for later a forced rebuild with no
value in it. The money stays recoverable by preparing again. An empty quote with a leaf skipped as
`Unverified` or `OperatorsUnavailable`, or an empty build with failed leaves, stays stuck, since that is
a read or the operators failing. The quote screen tells `OperatorsUnavailable` apart from every other
reason, a fee above what is left included, and names it first, since it is the one a later try can
change.

## The plan file

`exit-plan-<wallet id>.json` in Documents, through `durableFile`. It holds the recovery the SDK returned,
the funding strategy of the quote it came from, which a recovery does not carry and a new build asks for
again (always the default, one UTXO per branch, and absent on a plan written before the SDK had the
option, which reads the same), the verdict, the time of the last check, what the hosts refused, and the fee key's index, address and
public key. It holds no secret: `__tests__/exitPass.test.ts` scans the saved file for the words and the
key. Bigints are written as `{"$bigint":"123"}`. Variants are stored as `tag` and `inner`, which is all
the binding's converters read.

A torn file, an unknown version included, goes to `exit-plan-<wallet id>.json.unreadable` with every byte
and reads as no exit, so it never holds the wallet, and the first screen says an earlier exit was kept
apart. A read the platform refuses throws `ExitPlanUnread`, since that file may be whole: every caller
takes it as a plan that may be alive, and the screen stops on its error with a way to try again. A plan
in `done` or `closed` stays until its screen is closed, and starting a new exit writes over it.

## Limits

- The exit works on the device that synced the wallet. Its data lives in the SDK's storage, and there
  is no export of it.
- There is no hand signer for the fee address. A coin no child spends, such as a payment after the
  build, joins a later build, or stays there after `done` or `closed`, where that screen names it.
- Reading the wallet's own address goes through the operators. When that read fails the destination
  answers `unchecked`, and the screen takes a second tap with a line saying so, because refusing would
  stop the exit on the day it exists for.
- `recoverFunds` has no limit of its own, since a limit would call a build that may still finish failed.
- When the operators mark an exiting leaf as such, and so when the SDK's balance drops, was not
  measured: with 6 of 15 steps confirmed the SDK still counted the whole value of the exiting leaves.
  Home draws the SDK's own figure under the line of Home while an exit is alive, never one computed
  from the plan.
- The hold on Send lives on the device that holds the plan, and no device sees another's plan. Another
  device opened with the same words holds nothing, so a payment there can spend a leaf the exit quoted.
  In a measured run one such payment spent a quoted leaf. A payment that spends a leaf already on its
  way out would waste the fees paid for its steps; that case, and what the operators do
  with a leaf whose parent is already on the chain, were not measured. The first screen asks the person
  not to open the wallet on another device, with its words or its passkey, until the exit ends
  (`introOtherDevice`): a passkey wallet opens elsewhere through the person's Apple or Google account
  without any words in sight.

## Measured and not

Jest runs against a double of the SDK. The exit also ran on the real SDK (breez-sdk-spark 0.28.0), on
an Android emulator, in release builds that had the switch on and logged the SDK, the chain hosts and
the leaf optimization each connect is built with, with test wallets holding real bitcoin. Those builds
predate the durable write (synced and renamed over the file), what arrives, Home's figure, the hold on
leaf swaps and on Receive while an exit is alive, and the Home card for an exit that waits on the
person, which are proven in Jest. The durable write was also run on a throwaway emulator with a probe
build: 15 power cuts right after a write left 15 whole files on its ext4 `/data`, where the order
before it lost 15 of 15. None of it was run on a phone, nor on f2fs, which many Android phones use for
`/data`.

Measured:

- How long a quote takes. The first quote of the day came back from the SDK in 33.7 s, past the 30 s
  the app waits (`PREPARE_WAIT_MS` in `exitPass.ts`), so the screen said it could not work the exit
  out; the same tap four minutes later took 5 s. That wallet held 22 leaves, the SDK loaded 246 nodes
  and read each leaf's spend from mempool.space, which answered 429 in the same minute. The wait was
  not changed: the screen keeps the address, and tapping Continue again asks for a new quote.
- `connect` and `prepareRecoverFunds` with the three operators blocked for the app alone (their TLS
  names and addresses refused, the chain hosts still answering). The app opened on the stored balance
  marked as not updated, and the quote of two leaves came back in 12 s with the same
  figures as with the operators up, read from the SDK's own leaves and tree and the chain hosts. The fee
  screen worked as well, since its address is derived on the device.
- A real package accepted by a host and confirmed. The fan-out went alone and confirmed; the first
  node with its CPFP child was accepted by mempool.space as a package (`package_msg: success`) and
  confirmed. Later 6 of the 15 steps were confirmed, both branches had a node ready, and nothing was
  refused.
- The plan written before every transmission and again after it; `checkRecoverFunds` answering `Valid`
  on every pass, including one Home ran on a cold start that read the plan the previous run left, and
  one after an app update installed over the plan; Send holding the wallet in exit to its follow-up;
  the fee address spent only by the exit's own transactions; and no run of seed words in the logs and
  the evidence longer than one word.
- The fee address derived from the words by code independent of the app (`m/84'/0'/0'/0/0`) matches the
  one on screen, with the BIP84 test vector as the control.
- The hosts' `/address/<a>/utxo` hides an output spent in the mempool: mempool.space in 5 of 5 cases,
  blockstream.info in 4 of 5, and in the fifth 18 s later, once it had seen the spend.
- What a host answers a step refused for good: `/tx` answers 400 with `bad-txns-inputs-missingorspent`,
  and a package answers 200 with `package_msg: "transaction failed"` and the error per transaction, on
  both hosts. blockstream.info takes `/txs/package`. Nothing here builds again on it.
- How many blocks an exit takes, as a floor from the relative timelocks the SDK stores: on the two
  wallets read, each leaf waits at least 2,200 to 3,800 blocks (2,400 to 3,800 on one wallet, 2,200 to
  3,200 on the other), about 15 to 26 days at ten minutes a block (2,200 blocks are about 15.3 days), which
  the first screen states as two to four weeks. On the measured exit the slower branch
  can be swept about 3,000 blocks after the first node if each step confirms a block after its
  parent, which is an inference, not a measure.

Not measured:

- `Done`, and the sweep reaching the destination;
- `recoverFunds` with the operators down, which needs a fee coin confirmed while they are blocked;
- when the balance falls after `recoverFunds` (above, under Limits);
- the follow-up on iOS, and any of the exit on a phone rather than the Android emulator;
- whether a leaf already swept stays in the SDK's store. If not, `Specific` makes the quote fail with a
  `SparkError`, which stays stuck instead of closing;
- what the operators do with a leaf whose parent is already on the chain, and a payment from another
  device with the same words spending a leaf already on its way out;
- a fee that falls short (`InsufficientCpfpFunds`, Pay more), a build the SDK asks to redo, and the
  operators' own version of a step left waiting past its timelock.

The plan file was run once through the binding's real converters, with the generated module under Jest
and only its string functions stubbed: a plan read back from disk lowers to the same size as the
original class instances, and lifts to the same values, for every status. That proves the shape, not
the SDK's answer to it. It stays out of the suite because the generated module does not load under the
project's Jest setup.
