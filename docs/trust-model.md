# Trust model

The wallet itself needs no server run by the project. Keys, balances, sending and receiving over a
Spark address, a Bitcoin address or a Lightning invoice all go through the Breez SDK Spark running
on the device. The Spark network and the SDK have a trust model of their own, documented upstream at
<https://sdk-doc-spark.breez.technology/>. This page states what the optional server side that
serves lightning addresses can and cannot do, and closes with the parts that sit outside it,
namely passkey wallets, the update notice, the emergency exit relay, payment notices, the stable
balance rewards, the transport to the gateway and iOS backups. Each of those names at its start the
release it applies from.

## When there is a server side at all

A server side run by the project exists only when a build sets `BREEZ_LNURL_DOMAIN` (read through
`getBreezLnurlDomain()` in `src/config.ts`) to a domain the project serves itself. Without the
variable, the SDK keeps the lightning address on its default LNURL server, `ensurePushRegistered`
(`src/wallet/pushToken.ts`) registers nothing, and `readDomainState` (`src/wallet/domainTier.ts`)
returns nothing.

With it, the configured domain carries two services.

- **The LNURL server.** The server a payer's wallet queries to pay `name@domain` (LUD-06, LUD-16).
  It creates invoices on the wallet's behalf while the wallet is offline. The SDK registers the
  wallet's name with it, so it is Breez's open source LNURL server or one compatible with it.
- **The gateway**, under `/api` on the same domain. It answers the app's requests about its own
  address, namely names, custom domains, device registration for push notifications, and pending
  charges. A payer's wallet never reaches it, so it is not in the payment path. With notifications
  on, it also receives the wallet's payment events from the Spark service provider (below), which it
  turns into notices for the wallet's devices.

## What the server side cannot do

- Spend a wallet's funds, or sign anything on its behalf.
- Read the mnemonic, the seed or any private key. The app never sends them.
- Freeze or seize a balance. Stopping an address stops payments to that address and nothing else;
  the funds and every other way of receiving keep working (see
  [custom-domain.md](custom-domain.md)).

Where the app has to prove to the gateway that a request comes from a given wallet, it signs a
statement with the wallet's identity key on the device and sends the identity public key, the
signature and a timestamp. Each statement carries its own versioned prefix and action word (for
example `voltz-push:v1` in `src/wallet/push.ts` and `voltz-domain:v1` in
`src/wallet/domainTier.ts`), so a signature made for one action cannot be replayed as another, nor
against the LNURL server's own `breez-lnurl:` routes.

## What the server side can do, if it is compromised or dishonest

The LNURL server answers payers with invoices, and the payer trusts that the invoice belongs to the
address it asked for. The README of Breez's LNURL server states that the wallet has to trust the
server not to return invoices that are not its own. Running the server moves that point of trust
from Breez to whoever runs it. A server under someone else's control can do the following.

- **Return another recipient's invoice** to a payer, diverting a payment in flight. This is pointed
  rather than systemic, since it reaches only payments made through the address while the diversion
  lasts, and it leaves a trace, since the payer paid and the wallet never received.
- **See preimages** of the invoices it serves. LUD-21 verification returns them by design, so they
  are protocol data, and the server must never log or cache them.
- **See metadata.** Which identity key holds which name or domain, the amount and time of payments
  made through an address, the comment a payer attaches, and the push token and notification wording
  a device registered.
- **See the wallet's payment events, with notifications on.** The device registers a webhook with
  the Spark service provider (Lightspark), which then posts four events to the gateway, signed with a
  secret drawn on the device: a Lightning receive on an invoice the wallet made (its status, preimage,
  invoice amount, received amount and, when another wallet made the invoice, the receiving identity
  key), a Lightning send that finished (status, BOLT11 invoice, fee,
  idempotency key, invoice amount and preimage), an on-chain send (status, fee, on-chain fee,
  destination address, transaction id, speed, expiry and total), and an on-chain deposit claimed
  (status, deposit and credited amounts, maximum fee, transaction id and output, network and
  deposit address), each with the provider's request id and times
  (<https://sdk-doc-spark.breez.technology/guide/webhooks.html>). The gateway keeps the registration
  id the provider posts to (random, at least 128 bits, not derived from any key), the secret, and for
  72 hours a digest of each delivery's wallet, type and request id that drops a repeat. It keeps no
  payload: no amount, invoice, preimage, address or transaction id. The provider holds the webhook's
  URL, which names no device and carries no push token. The gateway keeps one record per secret, each
  with an id of its own, so a registration with a new secret never writes over the record of another.

  A device's row at the gateway also keeps the timestamp its latest registration was signed with, read
  off the device's own clock, and a registration signed earlier changes nothing of the row, its wallet,
  wording, locale or timestamp. So a registration that stalled for a wallet the person has since left
  cannot point the device back at that wallet, and a late copy cannot bring back wording the device
  replaced; the late one still keeps its own record, which pushes nothing while the device names
  another wallet. Only one install's clock is compared with itself, since a push token belongs to one
  install. When the clock is set back between two registrations that reach the gateway under 20
  minutes apart, by more than the time between them, the newer one is left out until the app registers
  again with a change. Of two that arrive 20 minutes or more apart the row always keeps the newer,
  since the gateway takes a signed time only within 10 minutes of its own clock.

  Before a data deletion request, when the wallet is removed from the device and when notifications
  are turned off (in the app or in the system settings, which the app reads on every start and every
  return to the foreground), the app drops the wallet's secret and asks the gateway to forget every
  registration made with it. The request carries the wallet's identity key and a proof: the
  HMAC-SHA256 of a fixed statement (`voltz-push-forget:v1`, the domain and the key) keyed with that
  secret. It proves only that the sender held the secret the registration was made with, and it names
  no device and no time. The provider holds that secret, since it signs each delivery with it, and the
  wallet's public key and the domain the webhook URL names, so it can compute the same proof and send
  a forget too. With it the provider can do what the app's own forget does, stop this device's notices
  of that wallet, and nothing more, since a forget only removes. For that key, the gateway deletes
  each record whose secret makes the proof, under every push token it was registered with, and the
  device row of each of those tokens, its wording with it, while that row still names the wallet and
  no record of the wallet under another secret is left on it; so of two secrets of one wallet on one
  device, whichever forget lands last takes the device row. A device that moved to another wallet, and
  a record made with another secret, stay as they are. It answers 410 to any later delivery to a
  deleted webhook id, answers every well formed forget with the same bytes whether anything matched,
  as a token revocation is answered (RFC 7009, section 2.2), and logs nothing of it. The time it takes
  is not the same: a key with registrations costs a read of its rows and one HMAC per stored record
  that an unknown key does not, and a match costs the deletions too. The proof has no timestamp
  because it can only remove: once a forget names a
  secret, that secret is never registered again, so a replayed proof removes nothing that is not
  already removed or refused. The app keeps only the key and the proof, never the secret, sends them
  at once and again on every start, connect and return to the foreground until the gateway answers
  200, with no time limit, and never holds up the removal, the deletion or a payment for it. The app
  also takes the webhook off the provider through the SDK when that wallet is the connected one, and
  otherwise leaves a removal marker that a later connect of the same wallet settles.

  The gateway holds itself to that rule too, so the order in which a forget and a registration reach
  it does not matter. For every well formed forget, matched or not, it writes in the same transaction
  a mark made from the proof alone, with no key, no push token and no platform, and it takes a forget
  and a registration of the same wallet one at a time. A registration whose secret makes a marked
  proof writes nothing, no device row, wording or webhook, and is answered 410 `forgotten`. A forget
  and a registration made with one secret therefore end the same whichever arrives first, even when
  the registration was already in flight as the secret was retired, because the forget wins, as
  removal does in a remove-wins set. The app takes that answer without telling the person anything,
  never sends that secret again, retires it if it still holds it, and registers a fresh one on the
  next connect. The gateway keeps a mark for 7 days from its latest forget, far past the 10 minutes a
  registration's signed time may differ from the gateway's clock. A retired secret (32 random bytes)
  is never drawn again.

  For a wallet removed while another one is connected, or after Forgot PIN erases everything, the
  provider registration cannot be taken down from the device, so the provider may keep posting that
  wallet's events to the gateway; once the forget has reached it, the gateway answers 410, keeps
  nothing of them and logs nothing of them.

  Until the forget reaches the gateway, the gateway still holds those rows and can still notify this
  device of that wallet's payments. Sending it needs only the network, not the words, the PIN or a
  connection, so a removal or an erase made offline is completed by the first start or return to
  the foreground with a network, however long after.

  Forgot PIN removes every wallet as a removal does (`eraseAllWallets` in `wallet/wallet.ts`), so the
  erase leaves in the Keychain each erased wallet's removal marker, which holds its identity public
  key, the gateway's ids for its webhooks and the provider's webhook ids and URLs, and its queued
  forget, which holds the key and the proof. Nothing in the erase clears them. The marker loses a
  wallet's entry only when a connect of that key here removes the webhook or finds it gone, and a
  forget only when the gateway answers it with a 200 (`wallet/webhookSecret.ts`). On iOS, where the
  Keychain can keep an app's items after the app is deleted, they can outlive the app as well.
- **Stop serving** a name or a domain, so payments to that address fail until it is served again.
- **Send or withhold notifications** to a registered device.

None of this is custody. There is no key that can spend a wallet's funds and no balance held on
anyone's behalf. It is a capacity for a pointed, detectable diversion, and it is acceptable only
while it is declared openly and kept narrow.

## What keeps it narrow

An operator of the server side is expected to do five things.

- Run the upstream LNURL server unmodified, so its behaviour is the published one.
- Restrict access to the processes and data that answer payers.
- Keep preimages out of every log, those in the provider's payment events included, and the
  registration id out of the access log.
- Alert when an invoice served for an address does not belong to the wallet behind it.
- Charge, if at all, a fixed price for software, never a share of the payments (see
  [principles.md](principles.md)).

## Passkey wallets

Applies from release 1.0.1.

A passkey wallet derives its mnemonic on the device from the output of the passkey's PRF. The
passkey lives in the user's Apple or Google account, which may sync it, end to end encrypted
according to Apple and Google, a statement the project has no way to measure. The project never
receives the passkey, its PRF output, the mnemonic or a key. The passkey is bound to the project's
own domain, `usevoltz.app`, so that domain adds two points of trust.

- **Who may ask for the passkey.** Whoever controls the `.well-known` files of `usevoltz.app`
  decides which apps can ask for the passkey. An app listed there still needs the user to approve
  with biometrics inside it, and derives nothing on its own. This reach matches what publishing an
  app version that reads the Keychain already gives.
- **Reaching it on a new device.** Taking those files down cuts the passkey off on a new device, and
  the recovery words stay valid, so the wallet still opens from them. This is availability, not
  control of funds.

An operator is expected to keep the content of those files held by a test, and to be alerted when it
changes.

The SDK also publishes the wallet's fixed label as a public Nostr note, to Breez's relay and to
public relays, signed by a Nostr key derived from the passkey. The note carries no key that can
spend, and opening a wallet with the fixed label does not read it.

## Update notice

Applies from release 1.0.1.

The app reads one public file, `https://www.usevoltz.app/app-notice.json`, to learn whether a newer
version exists. The request is a plain GET with no body, no query and no header of the project's, so
it carries nothing about the wallet. Cloudflare serves the site, so it sees the IP address and the
time of each read.

The file is signed with an Ed25519 key whose public half ships inside the app. It carries version
numbers and no text and no link. The app turns them into one of two fixed banners, each with the
store's fixed link. A notice never blocks anything, so sending, seeing the recovery words and
restoring keep working at any level, and a read that fails, stays unanswered or has a bad signature
shows nothing.

- **Whoever holds the signing key** can show either banner, and nothing else.
- **Whoever controls the site without the key** can withhold the file or serve an older signed one,
  which hides a notice and shows nothing false.

## Emergency exit relay

Applies from release 1.0.1.

The emergency exit takes a wallet's funds to the Bitcoin network without the Spark operators, using
transactions signed on the device. A pair of those transactions has to reach the network together,
so the app sends it as a package to `mempool.space`, with `blockstream.info` as the fallback. The
transactions that follow a package go alone, through any ordinary endpoint. The project runs no
relay of its own, so this path depends on nothing the project operates.

Each of the two hosts learns the IP address, the time, the fee address the app looks up and the
signed transactions, which become public on entering the network. Neither receives a key, and
neither can change or spend anything, because the transactions arrive signed. A host can refuse or
delay, and the app then tries the other. If both refuse, the screen shows the pair of transactions
to copy and take to a node that accepts packages through `submitpackage`.

## Payment notices

Applies from release 1.0.1.

With notifications on, the gateway sends each notice as a Firebase Cloud Messaging message with a
notification block, and FCM reaches an iPhone through the Apple Push Notification service. The block
carries the title and body in the wording the device registered, with the amount in sats filled in
for a payment received at the lightning address, a Lightning payment received, sent or not
completed, and an on-chain payment received, and with the domain filled in for the reminders about a domain
of the wallet's own and the notice that it is serving. Google, and Apple for an iPhone, therefore see
that text, the amount and the domain, the time, and the device's push token. A payment notice carries
only that title and body, and a notice about a domain also carries its host, for the app to route the
tap; none carries a key, an invoice, an address or a transaction id.

While the app is away the system draws the notice itself and no app code runs, so what a locked
screen shows of it follows the system: on iOS the person's Show Previews setting, and on Android the
lock screen setting. An app cannot make its own channel private on the lock screen: Android resets
that field on every channel an app creates, so the text of a payment notice, amount included, shows
on a locked screen whenever the person's setting shows notice contents.

## Stable balance rewards

Applies from release 1.0.1.

Opening the stable balance screen reads the wallet's USDB rewards from Flashnet
(`src/wallet/rewards.ts`), with two GET requests and no body: `/v1/rewards/<key>` and
`/v1/rewards/<key>/payouts?limit=5` on `rewards.flashnet.xyz`, where `<key>` is the wallet's Spark
identity public key. Try again on the screen sends both again. Flashnet learns that key, the IP
address of the device and the time, so it can tie the key to that address. The requests carry
nothing that signs or spends, and the project receives nothing of them.

## Transport to the gateway

Applies from release 1.0.1.

The app reaches the gateway over HTTPS through the platform's own network stack and pins no
certificate or key, so any certificate for the domain from an authority the device trusts is
accepted. A release build on Android trusts only the system's authorities: the app declares no
network security configuration, and at its target API level the default leaves out authorities a
user installs; it also allows no cleartext. iOS trusts, besides the system's authorities, a root the
person installs as a profile and turns on under Certificate Trust Settings.

Reading these requests in transit therefore takes a certificate for the domain issued in error, or
a root the person added to their own iPhone. Such a reader sees what the app sends to the gateway,
the payment webhook's secret in a registration for notifications included, which would let it have
the gateway send this device notices of payments that did not happen. The gateway holds no key and
no funds, so nothing read this way signs or spends, and the balance and the history the app shows
come from the SDK, never from a notice. On these grounds the gateway's requests go unpinned.

## iOS backups

Applies from release 1.0.3.

iOS puts the files of an app's Documents folder into iCloud backups and into computer backups. The
SDK's own folder, `Documents/spark`, which holds the payments, the contacts and the lightning
address in the clear, is flagged out of backups at every connect (`connectInTurn` in
`src/wallet/spark.ts`), and the network gives its content back. The seeds, the passphrases and the
PIN are in the Keychain, stored `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, which Apple says does not move to
another device.

Every other file the app keeps in Documents still crosses, and none holds a key that can sign or
spend. They are the following, grouped by what they hold.

- **Which wallets exist.** `wallets.json` (wallet ids, fingerprints and the active one),
  `passkey-wallets.json` (which wallets came from a passkey, with what the authenticator reported),
  `wallet-meta.json` and the `wallet-avatars` folder (the name and photo given to each wallet), and
  `backup-marks.json` (wallets whose words are not confirmed yet).
- **Payments.** `pending-sends-<wallet>.json` (the ids of sends in flight), `conversion-notes.json`
  (what the SDK quoted for each conversion), `refund-fees.json` (the highest fee signed for each
  refunded deposit, by its output) and `exit-plan-<wallet>.json` (an emergency exit's plan, with its
  transactions and the fee address).
- **Addresses and domains.** `lnurl-domain.json` (the domain of each wallet's address),
  `ln-address-last.json` (each wallet's remembered address), `released-lines.json` (answers about a
  name or a year still to be shown, with the address or host they name), `domain-tier.json` and
  `domain-mine.json` (the last answer about a wallet's own domain, and when it was asked),
  `domain-wallet-labels.json` (the names given to wallets let into a domain, by key) and
  `domain-purchase.json` (a domain purchase under way).
- **Purchases.** `purchases.json` and the older `purchase-<kind>.json` (the proof of a name or domain
  bought in sats, with its reference and amount), `purchase-asked.json` (when each wallet last asked
  what it is owed) and `store-orders.json` (orders opened with the App Store or Google Play).
- **Notices and deletion.** `push-registration.json` (the push token, the wallet's identity key, the
  domain and the wording last registered), `notification-asked.json`, and `deletion.json`,
  `deletion-read.json` and `deletion-check.json` (the marks of wallets whose data was deleted at
  Voltz, and when their status was read).
- **Preferences.** `settings.json` (currency, language, explorer, the dollar wallet and similar
  choices), `token-prefs.json` (the tokens each wallet added or hid), `biometric-offer.json` and
  `price-cache.json` (the bitcoin price series).

A file written through `src/wallet/durableFile.ts` can also leave a `.tmp` copy beside it, and one
that could not be read is set aside as `.unreadable`; both cross with the rest.
