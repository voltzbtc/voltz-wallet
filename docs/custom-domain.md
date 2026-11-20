# Lightning addresses on a custom domain

A wallet's lightning address lives on the build's shared domain (`BREEZ_LNURL_DOMAIN`) unless the
wallet has moved it to a domain of its own, such as `pay.example.com`. This page covers the app side
of that, namely where the choice is kept, how the app learns the domain's state, and what each
screen shows in each state. What the server side can and cannot do is in
[trust-model.md](trust-model.md).

The domain belongs to whoever registered it. What runs for a year and can lapse is the service of
lightning addresses on it, never the domain itself.

## Where the choice lives

The domain is stored per wallet in `lnurl-domain.json` (`src/wallet/lnurlDomainPref.ts`), written
whole through `durableFile.ts`, since losing it moves every wallet with a domain of its own to the
shared one. A file that cannot be read answers no choice; a write sets a torn file aside before it
writes, and fails over a read the platform refused, leaving the file as it is.
`domainFor` falls back to the build domain and is what `connectSpark` hands to the SDK as
`Config.lnurlDomain`. `storedDomainFor` has no fallback, and the difference matters. A wallet with
nothing stored connects like every other wallet, yet it is the only kind that can own a domain it
cannot name, because a wallet restored from its seed on a new handset has no preference file.

The SDK reads the domain once, at connect, so a changed preference takes effect at the next
connection. The screens that change it (`UseMyDomainScreen`, `DomainScreen`, and the move back to
the shared domain on `LnAddressScreen`) reconnect right after. The adoption described under "How the
state is read" is the one exception, and it waits for the next connection on purpose.

## The five phases

`phaseOf` (`src/wallet/domainTier.ts`) derives the phase from the facts the gateway sends, which are
`kind`, `expiresAt`, `frozenAt` and `serverNow`. The gateway never sends a state word, so the
vocabulary exists in one place.

| Phase | Derived from | The owning wallet sees | A payer sees |
|---|---|---|---|
| `fine` | more than 30 days left, `kind: 'public'`, or no date at all | nothing, and no gap where a card would be | pays normally |
| `ending` | 30 days or less left | orange card with the paid-until date and Renew | pays normally |
| `lastDay` | 24 hours or less left | red card, last day | pays normally |
| `expired` | `expiresAt <= serverNow` and `frozenAt` null | red card, about to stop | still pays, the hostname is still served |
| `frozen` | `frozenAt` is a number | red card dated by the pause, no QR and no address | the address does not resolve |

Three ordering rules inside `phaseOf` carry weight.

- `kind: 'public'` returns `fine` before any date is read. The shared domain has no year to run out,
  and a missing date there must never read as long past.
- `frozen` outranks `expired`. Expiry is derived on every read, while a freeze is an effect the
  server recorded after it stopped serving the hostname. After a renewal whose thaw has not landed
  yet, the row holds a live expiry and a freeze at once, and frozen is the truth for the payer.
- A missing `expiresAt` reads as `fine`. Alarming a paid-up domain costs more than a card that
  appears one read later.

Only the gateway's clock is used. A device clock can be set by hand and drifts, so trusting it would
put an expiry banner on a paid-up domain whose phone runs fast.

## How the state is read

`readDomainState` runs every time the address screen gains focus, and again whenever the app returns
to the foreground with that screen open, since the tap that lands there is usually the notification
about this very state.

- **The request goes to the shared build domain, with the host in the body.** It never goes to the
  customer's own hostname. A frozen hostname is no longer served, so a request addressed there
  cannot arrive, and the wallet would be locked out of the screen that renews it. The signed
  statement includes the host, so moving it into the body gives nothing away.
- **The host comes from the saved preference, never from the address.** A frozen domain can leave
  `sparkEnsureLnAddress` with no address to return, and a design keyed on the tail of the address
  would have nothing to key on at the moment the explanation matters most.
- **A preference that names the shared domain costs nothing.** It is answered on the device without
  a request.
- **A wallet with no preference asks what its key holds, at most once a day.** That covers most
  wallets, and every wallet restored from its seed. The time of the last ask is kept per wallet in
  `domain-mine.json`, so the answer survives a restart. Only domains the wallet owns are adopted,
  and only while they are not frozen, because pointing a wallet at a frozen host would leave it with
  no address at all. Adoption writes the preference without reconnecting, so the address follows at
  the next connection.
- **The last whole answer is cached** per wallet and host in `domain-tier.json`, so a domain that is
  ending still says so with no signal. The cached answer is aged by elapsed device time and never
  rewound by a clock moved backwards. A 403 or 404 from the gateway drops the entry, while a network
  failure keeps it.

`readDomainState` never rejects. A lifecycle notice that could break the screen whose job is to show
an address is worse than no notice.

## What the address screen shows

The notice slot sits at the top of `LnAddressScreen` and draws nothing until there is something to
say.

- **No skeleton in the notice slot.** Loading is a skeleton everywhere else in the app. Here, for
  almost every wallet, the news is that the slot collapses to nothing, so a shimmer on every open
  would announce something that never arrives.
- **The owning wallet gets the card** (`DomainNoticeCard`). Orange while a date is still ahead, red
  once the next thing to happen is money not arriving. A frozen card dates the pause rather than the
  expiry, since after a renewal the expiry is the wrong fact to show. The Renew button sits outside
  the card, because the card states a condition and the button is what to do about it.
- **A wallet that does not own the domain gets one line** naming it (`domain.onAnotherWallet`). The
  line is keyed on `role`, not on comparing hosts. A handover leaves the outgoing wallet authorised
  and its address working, but only the owning wallet can renew, so a Renew button there would be
  refused.
- **While frozen, a second action offers the shared domain.** It is confirmed first, because the
  address on the frozen domain stops being served the moment the wallet moves. It clears the
  preference and reconnects. Before the freeze the addresses still work, so the offer is not shown.
- **While frozen, the QR code and the address text are withheld**, and so is the QR skeleton. Both
  are the same dead end for a payer. A shop holding either one out to a customer produces an error
  in the customer's wallet, and an empty space under the card is better than that.
- **The name sheet knows the domain is frozen** (`domainFrozen` on `LnAddressSheet`). A frozen
  domain refuses every name, and the refusal reaches the app as the same result a taken name
  produces, so the sheet names the real reason instead of sending someone off to invent another
  name.

## Renewal

Renew opens `UseMyDomainScreen` with the host already known, so the flow starts at the payment step
and the invoice is minted on arrival. Its gateway URL is always built from the build domain, never
from the domain being renewed. Above the price, one line states which renewal this is. Renewing
before expiry adds the new year on top of the days left (`useDomain.renewEarly`), and renewing after
it starts the new year on the day of renewal (`useDomain.renewLate`).

## A dead domain costs the address and nothing else

A domain that stops resolving takes away the wallet's lightning address and leaves the rest of the
wallet intact. The balance, the asset list, Send and Receive keep working. `lnurlDomain` is a field
of the SDK `Config`, set in `buildConfig` and handed to `connect`, and nothing in the app dials that
host while connecting.

To check it on a device, write a preference pointing at a name under the reserved `.invalid`
top-level domain (RFC 2606) into `lnurl-domain.json` in the app's documents directory, keyed by the
wallet id, then relaunch the app so `connectSpark` reads it again. A real freeze fails at a
different layer, a TLS handshake with no certificate for the name rather than a name that does not
resolve. That changes when the failure surfaces, not whether it happens.

If a later measurement ever shows a wallet going dark on a frozen domain, the fix is to stop
connecting with a domain the state read already reports as frozen, not to soften the freeze.

## Known gaps

`DomainWalletsScreen` and `AuthorizeWalletScreen` still address the gateway at the customer's own
host, so they are unreachable while the domain is frozen. Do not copy them when adding a call; build
the gateway URL from `getBreezLnurlDomain()` as `DomainScreen`, `UseMyDomainScreen` and
`src/wallet/domainTier.ts` do.

## Negative cases the tests cover

`__tests__/domainTier.test.ts`, `__tests__/domainTierRead.test.ts` and
`__tests__/lnAddressScreen.test.tsx` cover these cases, which are the ones a refactor loses quietly.

- A device clock a year fast does not expire a live domain, and one two years slow does not revive a
  dead one.
- A public domain reads `fine` even when it carries dates that would read as frozen on a customer
  domain.
- A domain 60 days past expiry still reports its phase.
- A 403 or 404 drops the cached answer, while a network failure keeps it.
- A cached answer is aged by elapsed device time and never rewound.
- One wallet is never served another wallet's answer, nor an answer read for a domain it has since
  left.
- A frozen domain with no address at all still renders its card.
