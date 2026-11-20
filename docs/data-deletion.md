# Deleting a wallet's data at Voltz

`DeleteDataScreen` asks the gateway to delete what Voltz holds for the active wallet: its names on
every domain, the devices registered for push, the payments and comments kept for its addresses. The
deletion does not touch the seed, the bitcoin or the history, which live on the device and on Spark;
from the remove flow the wallet then leaves the device, and its recovery phrase opens the bitcoin
again.

The way in is Edit wallet's Remove wallet, in a build with a domain. For a wallet that can be removed,
the remove question carries a switch, Also delete my data at Voltz, off each time it opens. Off, the
confirm removes as it always did; on, it opens the deletion screen naming the wallet (`thenRemove`)
and removes nothing itself. The only wallet on the device cannot be removed, so the same button opens
a sheet that says it stays and offers Delete my data at Voltz, which opens the screen with no wallet
named. Every wallet keeps that way in. Remove wallet waits for Edit wallet's reads, and when they
fail it is not drawn on that visit, so the only wallet has no way to the deletion screen until a
later visit reads, and that screen could not sign then either. Wallets (`WalletsScreen`) removes
without offering the deletion,
which signs as the active wallet only.

The logic is in `src/wallet/deletion.ts`, the mark in `src/wallet/deletionMark.ts`, and the tests in
`__tests__/deletion.test.ts`.

## The route

`POST /api/wallet/delete` at the build domain (never a customer's own domain, which can be off the
edge), with `{ action, pubkey, signature, timestamp }`. The signature is the wallet identity's DER
signature over

```
voltz-delete:v1\n<action>\n<pubkey>\n<timestamp>
```

whose bytes the golden vectors in the test pin, and which the gateway builds byte for byte.

| action | answer the app reads |
|---|---|
| `preview` | 200 `{ names: [{ domain, name }], recentPurchases: [{ rail, kind, domain, subject, reference, at }], ownDomains: [{ host, guests, expiresAt }], blockers: string[], stays: string[], owed: [{ reference, kind, domain, subject, sats, state, at }] }`, with the status fields below merged in |
| `request` | 202 `{ status: 'pending', requestedAt, finishBy }`; 200 `{ status: 'done', ... }` for a request already finished; 409 `{ error: 'blocked', blockers }`; 409 `{ error: 'signed_before_return' }` |
| `status` | 200 `{ status: 'none' }`, `{ status: 'pending', requestedAt, finishBy }`, `{ status: 'done', requestedAt, doneAt }` or `{ status: 'returned', returnedAt }` |
| `return` | 200 with the status; 409 `deletion_pending` while the request runs |

These are the answers the app reads from the gateway. Times are gateway unix seconds. A 5xx, a timeout
or a network failure is no answer, never a refusal, and a 200 to `request` is no answer either, so the
status read runs the local cleanup before anything says deleted. The preview is parsed strictly; any
field of the wrong type is no preview and keeps the button off. `owed` is read as empty when a gateway
older than the field leaves it out, and a malformed row is no preview like any other.

`owed` lists every charge in sats Voltz may owe the wallet, with no time window: `refused` and
`not_granted` were paid and turned into nothing, and `unchecked` is past its expiry with nothing
recorded, which the gateway has not yet recorded as paid. Nothing records a repayment made by support,
so the screen never states the debt as a fact: the first two say the charge was paid and that support
pays the sats back if they have not come back, and the third says it is not known whether it was paid.
Each shows before the confirm button with its reference selectable on its own, and the card ends with
the one row that mails support every sats reference on the screen.

`blockers` and `stays` are codes, and the app owns their words (`BLOCKER_KEYS` and `STAY_KEYS` in
`DeleteDataScreen.tsx`). `stays` is the gateway's deletion map read as the `what` of every entry that
is kept or made pseudonymous, so the screen's list of what stays comes from the map. The test pins
the gateway's codes and fails when one has no words in any of the 24 locales; a code the app does not
know is still shown, as "one more record stays", and an unknown blocker as "something is still in
progress".

## The mark

`deletion.json` holds one mark per wallet id, with the wallet's key and a state:

- `asked`, written before the request is signed, so a process killed mid request still holds;
- `pending`, after a 202 or a status of `pending`;
- `done`, after a status of `done` and the local cleanup;
- `removed`, written by "Remove address" on the address screen, with nothing asked of the gateway.
  It is written only for a wallet nothing holds, looked up in the same turn of the marks' queue as
  the write (`markAddressRemoved`); an `asked` or `pending` mark found there instead gains
  `removedAt`. Both are written before the name is forgotten or the address given up, and the name
  is forgotten only once the SDK gave the address up. A removal the SDK refuses takes back only what
  it wrote (`unmarkAddressRemoved`), so a mark written meanwhile stays. Only a status read, the
  wallet's removal or a return from the deletion can write meanwhile, and a request cannot, since it
  runs in the same address turn as the removal. The return runs only while the wallet is held, when
  Remove is not offered.

Every reader looks a mark up the same way (`findDeletionMark`): the wallet's own mark by its id, or
else any mark for the same key, which is what the gateway refuses. Removing a wallet drops its mark,
so a seed imported again is never held by a mark nobody can see.

A request keeps `removedAt` when the address had been given up before it, and every path that lets
the wallet go (status `none` or `returned`, a refusal) writes the `removed` mark back rather than
clearing it.

Any mark stops the automatic steps for that wallet: `sparkEnsureLnAddress` (at the start and again
inside the address turn), a register or a transfer claim, push registration, store orders and spend
intents, sats quotes and domain claims. A wallet's payment webhook comes off the Spark provider
before the request is sent (`retirePaymentWebhook` in `paymentWebhook.ts`), so the provider stops
posting its payments to a gateway that is about to forget them. What the provider may hold is first
written to a removal marker in the Keychain, keyed by the wallet's identity key, and that marker
loses an entry only once the provider removed the webhook; a removal the provider does not confirm
within `RETIRE_WAIT_MS` neither stops the request nor is forgotten, and every later connect of the
key tries it again. The drop of the secret also queues the gateway forget of every registration made
with it (`deviceForget.ts`), which is sent at once and never waited on; one the gateway does not
answer is sent again on later starts, connects and returns to the foreground. The stops throw or
return the gateway's own `deleted` code,
which `errors.ts` classifies, except that a `removed` mark alone answers the explicit purchases (name
quote, domain quote and claim, store order, spend intent) with `address_removed`, whose words
(`receive.lnOffBuy`) point at "Create the address again" on the Lightning address screen. The
gateway knows nothing of a removed address, so that refusal is the device's own.

### Writes that survive a cut, and a file that cannot be read

`deletion.json` and `deletion-check.json` are never written in place. A write goes to
`<file>.tmp`, is read back and synced, and only then renamed over the file, and the directory is
synced before the write resolves. rename(2) replaces the file in one step, which RNFS's own move
cannot do on iOS (`NSFileManager moveItemAtPath` refuses an existing path, error 516 measured on
macOS Foundation), so a process killed or a power cut at any step leaves the file from before or
the new one. A finished copy whose rename was cut is synced and moved in before the
next write overwrites it, and a clear removes the copy before the file and syncs the directory, so a
cleared file does not come back after a cut. Every read of either file waits in the writes' queue:
RNFS answers its calls in order on one native queue and the rename runs on another, so a read sent
while a finished copy is moved in could find no file yet and then, behind the rename, no copy
either, and read as no marks at all.

A file that still cannot be read (torn, of another shape, or a torn copy with no file) holds every
wallet and every key, shown as `checking`: the address screen says only that an address can show
there once Voltz answers. That holds for every answer the read can bring (none or returned, where the
address comes back; pending or done, where it does not; and no answer at all), since the address is
most often still live and no read may be running. The deletion screen reads the status or says it
could not check, with nothing to press.
The first write over it rebuilds it with every wallet in the registry unread, kept under the
`~repair` key beside the marks, and never drops another wallet's mark. Each wallet is read back by
the import's read (`checkImportedDeletion`, `adoptDeletionStatus`) on its next Home focus or on the
deletion screen, and the answer is written as its mark; a key answered with nothing held is recorded
as clear. A wallet not read yet stays held by its id, and a key no read answered stays held, since an
unread wallet may hold the same seed. The record goes with the last unread wallet. With no wallet in
the registry nothing is written and every wallet stays held. An import list that cannot be read
counts every wallet in the registry as due.

Every answer is written only over the mark it was read from (`answerDeletionMark`), so a status of
`none` sent before a request was recorded never lets that request's mark go. A request's own 202 is
written whatever the mark became.

Residue: a `removed` mark lost with an unreadable file cannot be read back, since the gateway was
never told of it. The wallet's answer is `none`, and the next open makes an address as for any wallet
that never gave one up. An `asked` mark whose request never arrived reads back as `none` too, which
is where it would have ended. The domains a lost request was asked with (`ownedHosts`) are not read
back either; the cleanup after `done` still finds an owner's domain in the domain cache.

The request runs in the address turn, so an automatic register queued behind it finds the mark.

## What the screen says

Deleted only on the gateway's `done`, after the local cleanup ran. In progress for a 202 and for a
request with no answer. Each focus of the deletion screen reads the status, and so does a Home
focus, the first open included (`readDeletionOnFocus`, only while the session signs as the active
wallet), so a request that finished while the app was away ends in `done` with its cleanup without a
visit to this screen. Home reads an `asked` mark on every focus, and a request it already read as
pending at most once every five minutes (`PENDING_FOCUS_FLOOR_SECS`), since the status call shares
the gateway's per-caller budget with quotes and store orders; the same pending answer writes nothing.
A wallet with no mark whose stored domain is not the build's, or whose cached role is owner, is read
at most once a day (`DOMAIN_READ_EVERY_SECS`): a deletion asked from another device can take that
domain down, and then this device's registers go to a host that never answers with the refusal that
would tell it. The time of the last answer sits in `deletion-read.json`, written as the marks are and
dropped with the wallet's mark, and written before the read lets its turn go, so two focuses whose
reads overlap send one; a file that cannot be read makes the read due, and a read with no answer may
repeat after the five minute floor. Members of someone else's domain with a stored domain
pay that one read a day too.
Of the answers, `none` drops the mark and says the request never arrived, `returned` drops it,
`done` runs the cleanup and then says deleted. Each of these, and a definitive refusal, puts back the
`removed` mark of a wallet that had given its address up. With no answer the mark stays, and the
address screen keeps saying the data is being deleted until a later read answers; an answer that
lands while the address screen is open shows on its next focus.

When nothing can be asked (the wallet cannot be connected, or a write fails mid read), the screen
reads the mark: in progress or deleted for a wallet that asked. "Nothing was deleted" is said only for
a wallet known to hold no mark.

Opened from the remove flow, the screen removes the named wallet only once the gateway answered
pending or done for it: a 202 to the request, or a focus read that settles on pending or done, a
request adopted from another device included. It removes only while the screen has focus, and only
when the wallet the deletion signed for (`liveDeletionDeps`, the active one) is the one named, then
goes Home as a removal does. Every other answer leaves the wallet on the device, since removing it
drops its mark, the one record that follows a request nobody has answered yet. On `asked`, from a
request with no answer or a focus read, the screen adds that Voltz has not confirmed the request, so
the wallet is still on this device, and that Remove wallet with the switch on finishes the removal
once Voltz has it; nothing removes it on its own. From the remove flow no line says the wallet stays
or that the screen tells when the deletion is done, since the wallet leaves before that: the list of
what stays and the confirm say it leaves this device once Voltz has the request and that only its
recovery phrase opens the bitcoin again, and the time and in progress lines drop "we tell you here".
A focus read that fails removes nothing, even over a pending mark. One
removal runs at a time and the screen shows busy meanwhile. A removal that fails says so on the
screen through the logic Edit wallet uses (`src/wallet/walletRemoval.ts`): a live exit has its own
line, and anything else is a failure unless the registry no longer lists the wallet, which then goes
Home. A live exit is asked about on Edit wallet too, before the screen opens with a wallet named, so
a wallet that holds one shows the refusal there and no request reaches Voltz for it. The removal
sweeps photos by the registry's fingerprint, so a registry that cannot be read removes nothing. An
app killed between the 202 and the removal leaves the wallet listed with a pending mark, and the
next pass through the remove flow removes it on the focus read. The cases are in
`__tests__/deleteDataThenRemove.test.tsx`.

## The local cleanup

`dropLocalRecords` runs only after `done` and is keyed by the wallet id, or by its key for the push
registration the device shares between wallets: the address memory, `push-registration.json` when it
is this key's, the payment webhook's secret and id in the Keychain (`webhookSecret.ts`, moved into the
removal marker first, which stays until the provider confirms, with the secret's forget queued), this
wallet's orders and checks in
`store-orders.json`, its entries in
`purchases.json`, `purchase-asked.json`, `released-lines.json`, `domain-tier.json`, `domain-mine.json`
and `domain-purchase.json`, and `lnurl-domain.json` when the domain was its own. Removing a wallet from
the device drops its entry in `released-lines.json` too, since each line names an address or a host and
owes nothing here, while its purchase proofs stay. Labels in
`domain-wallet-labels.json` go only when this wallet owned a domain and no other wallet on the device
owns one, since the file does not say which owner wrote them. A failed step leaves the mark pending,
and the next read runs the cleanup again. A step over `purchases.json`, `released-lines.json`,
`domain-purchase.json` or `store-orders.json` that cannot be read writes nothing and resolves, so the run goes on: those files
are never written over nor removed without a read that answered (`durableFile.ts`), and a cleanup that
failed there would stay pending for good. Home and the deletion screen can hear `done` at once; one
cleanup runs per mark, and the second read waits for it and answers what it answered.

## The way back

The address screen of a held wallet shows why it has no address. For `done` and `removed` it offers
"Create the address again": a `removed` wallet asks nobody, and a deleted one sends `return` and mints
only after the gateway's 200. The SDK reads its lnurl domain once, at connect, so after the cleanup of
a domain owner the session is rebuilt when the wallet's domain moved, both right after `done` and
again before the way back registers.

## Residues accepted

- Labels in `domain-wallet-labels.json` go on a rule of thumb, since the file does not say which
  owner wrote them: with another domain owner on the device, the deleted owner's labels stay here.
- A proof file or store book that cannot be read keeps the deleted wallet's records inside it (ids
  and references, no secret) after the cleanup, and Support reads it as unread while it is there.
- "Remove address" marks this device only. The gateway is not told, so another device holding the
  same seed holds no mark and may make an address again on its next open.
- Two outcomes are checked only on a device, in the device walk before a release: the address made
  again after the way back, and push notifications stopping for a held wallet. The suite runs both
  against doubles of the SDK and of Firebase.

## A seed deleted from another device

A device that holds no mark for such a seed writes it from the preview too: the gateway merges the
request's status into the preview, and `previewOrAdopt` writes a `pending` or `done` status as the
mark through the import's path, so the deletion screen shows that request instead of a page asking
for another, and the automatic steps stop before the gateway refuses them.

The device it is imported on holds no mark. The import notes the wallet in `deletion-check.json`,
and Home's first sweep, once it can sign, reads the status once and writes the mark from the answer
(`checkImportedDeletion`), so the wallet ends where the first device ends: in progress, or deleted
with the way back. No answer keeps the read due for the next focus. The address screens also read it
when the gateway refuses the key with `deleted` (`ensureLnAddressOrAdopt`), and the ensure passes that
refusal up rather than retrying it as a taken name.

Every other call the gateway refuses with 409 `deleted` says so too: push registration, the name
and domain quotes and confirmations, the domain claim, the store order and spend intent, and the
LNURL server's register and transfer claim, each where it reads the refusal
(`noteGatewayDeleted` in `deletionMark.ts`). `deletion.ts` then reads the status once in the
background and writes the mark the answer says. The refused call never waits for that read, and its
result does not change, so the local stops refuse the next call before it is sent. The read runs only
for the key of the wallet the session is on, while it is the active one, and the answer is written
only if the session is still on it. One read runs per wallet at a time, shared with the read after an
import or a lost mark, the daily read and the address screens, so whichever starts while it runs waits
for it; none runs while a mark exists, and none from a refusal within `REFUSAL_READ_FLOOR_SECS` of a
read that got no answer. A refusal heard before
`deletion.ts` is loaded waits for it. `__tests__/deletedRefusal.test.ts` holds each site.

The deletion signs as the active wallet: a wallet switch leaves the SDK on the previous one, so
`liveDeletionDeps` connects the active wallet first and refuses when the connection is still another.
