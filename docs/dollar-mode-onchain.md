# On-chain send with the wallet in dollar mode

`SendSpark` refuses a bitcoin address, a silent payment address included, while dollar mode is on. It
stops before any quote is asked for, shows `send.onchainNeedsBitcoinMode` and links to the dollar
wallet's screen (`send.openDollarWallet`). Turning dollar mode off leaves the address in the field and
prepares nothing on its own. `__tests__/sendSpark.test.tsx` ("the bitcoin address it cannot pay yet")
holds both.

## Why the guard exists

A withdrawal is priced against bitcoin the wallet holds, and a wallet in dollar mode holds its value
in USDB. The SDK then funds the withdrawal with a swap inside the send, converting USDB into sats in
a Flashnet pool, claiming the proceeds as a Spark transfer and reserving leaves for the withdrawal.

Those two steps race. The leaf the swap produces can still be `TransferLocked` when the withdrawal
reserves its leaves, so the reservation drops it and the send fails after the conversion has run. The
stable balance sweeper then converts the sats back into USDB. Money moves twice, the history shows a
conversion out and one back for a send that never happened, and the screen can only say the send
failed (`send.failed`), since the SDK's error carries no code the app can classify. In the SDK log the
sequence reads as a claim answered `AlreadyExists`, then `leaf_lifecycle cancel_verify_dropped` with
the dropped leaf in `status:TransferLocked`.

The ordering between claiming the swap's proceeds and reserving them is the SDK's, not something the
app can sequence, so the app refuses the address instead. Lifting the guard is the one condition on
`isOnchainKind(info.kind) && dollarMode` in `SendSpark`.

## The estimated fee

When the wallet holds no bitcoin, the SDK does not ask the provider for a fee quote. It estimates the
fee locally and marks the quote `isEstimate`; `spark.ts` passes it on as `onchainFees.estimate`. At
send time the SDK fetches the quote again near expiry, after the conversion has run, and never pays
more than the tier chosen at prepare. It steps down in speed if the rate rose, and fails only when
even the slowest tier is out of reach.

So when `estimate` is set the review adds a row under the fee (`send.feeEstimated`), saying the figure
is a ceiling rather than the fee. With the guard in place that row is not reached from dollar mode.

## Testing it

Regtest has no stablecoin (the Breez docs, `guide/testing.html`), so the flow can only be exercised on
mainnet, with real funds. Its failures are intermittent, so a run that passes once proves little: a
measure takes repeated sends from a wallet whose value is all USDB, each one credited on the receiving
side and the balance adding up after it.
