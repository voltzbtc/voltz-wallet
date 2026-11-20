# The bitcoin price and the asset screen

How the app shows the bitcoin price, why it lives on the asset screen rather than on Home, and where
each number comes from.

## Why an asset screen exists

The "Bitcoin" row, and any token's row, in Home's asset list **opens** the asset screen. It shows
that asset's balance, its value in fiat, the price chart (Bitcoin only) and its recent movements.

The chart stays **off Home** for three reasons, in this order:

1. Home has one job: balance, send, receive. A chart is something to look at rather than something
   to do, and even a compact card takes about 140pt, nearly the whole action block.
2. The fiat line under the balance already answers "what is it worth today". A chart answers "and
   yesterday?", which is the question of somebody following a price, and a wallet that **opens** on
   a chart puts that question first.
3. On the asset screen the same chart charges nobody a toll: whoever does not want a price never
   goes there, and whoever does finds it at 132pt, with decent touch targets on the periods and that
   asset's movements right below.

The route works for any asset, so USDB has a screen at no cost, and there it **links** to
`StableBalanceScreen` (the dollar balance and rewards) instead of repeating that content.

## Where each number comes from

| What | Source |
|---|---|
| The asset's balance | SDK, `sparkGetWalletInfo()`, the same getInfo Home uses |
| Value in fiat | SDK, `sparkGetFiatRates([currency, 'USD'])` |
| **Price now** | SDK, the same rate above |
| **The chart's curve** | **Kraken**, `api.kraken.com/0/public/OHLC?pair=XBTUSD` |
| Movements | SDK, `sparkListHistory(25, filter)`, filtered by asset |

The SDK has **no history**. `listFiatRates()` returns `Rate { coin, value }`, the price right now,
one line per currency. There is no time series endpoint anywhere in the Spark binding (checked in
`breez_sdk_spark.d.ts`). That is why the curve comes from outside.

## The anchor, the rule that avoids two prices on one screen

Kraken's series is BTC/USD. It is **rescaled** to end exactly on the rate the SDK reports for the
user's currency:

```
price(i) = seriesUSD(i) / seriesUSD(last) × sdkRate[currency]
```

Two consequences, both deliberate:

- The card's large number **never** disagrees with the balance's fiat line, because both come from
  the same rate. Switching currency costs no request, because the series is rescaled over the cache.
- The shape is BTC in dollars. Over a long window the local exchange rate of that period does not
  appear, so what the curve asserts is "how bitcoin moved over the period", which is the question a
  price chart is asked. Do not label it as a historical price in the local currency.

## Why Kraken, and what is ruled out

| Source | Key | Currencies | Why not |
|---|---|---|---|
| **Kraken OHLC** | no | USD (the shape) | **chosen**, with 720 candles per interval, 5 intervals that cover 1D through All, a per-IP limit that in an app is per user, and no geographic block |
| CoinGecko | optional | 45 fiat | keyless answers `429` then `401` within ten calls from one IP, and the Demo key is 10k calls a month across **every** install |
| Binance klines | no | 7 fiat directly | `451` for US IPs |
| mempool.space | no | 7, no BRL | not enough currency coverage for an international app |
| A proxy run by the project | | all | puts a Voltz server back in the app's path |

Binance has a direct pair for a few currencies (BRL, EUR, MXN, JPY, TRY, ARS, IDR), which would remove
the exchange rate distortion there; the app does not use it, and every currency takes Kraken's
BTC/USD shape.

## Cache and degradation

A file cache (`price-cache.json`, the same pattern as `settings.json`, RNFS, nothing sensitive), one
entry per period, storing the closes **in USD**, which is why switching currency makes no request.

The TTL is 5 minutes on 1D, 30 minutes on 1W and 6 hours on the rest.

The read order is **fresh cache, then network, then stale cache**. An old chart is a better answer
than an empty screen when the network is down or the limit is hit.

Failures never take the screen down:

- With no curve, the network out and no cache, the card shows **the price alone** with "Chart
  unavailable". The price comes from the SDK, so it stays correct.
- With no SDK rate, the **whole** card disappears, since there is nothing to anchor to and nothing
  to show. Balance and movements stay on the screen.
- While loading, the card is a skeleton, never a spinner or a "loading" label, per the design system
  rule.

## UI details that are decisions rather than accidents

- **A green or red line** by the period's sign (`colors.success` and `colors.danger`). The period
  picker is the app's own `SegmentedControl`, the one Send and Receive use, rather than a private
  control: the design system reserves that shape for "pick one of N", and it already handles RTL and
  accessibility. Polish and Hebrew abbreviate their longest period labels, since six segments give
  about 44pt each.
- **The label becomes the point's stamp** while scrubbing ("Bitcoin · BRL" turns into the date and
  time) rather than opening a tooltip bubble. One layout line fewer, and the large price already
  shows the value being read.
- **"Chart unavailable" speaks about the data, never about the layout.** The geometry is also null
  on the first frame, before `onLayout` measures the width, so a message conditioned on it would
  flash every time the screen opens.
- **The chart only takes the touch when the finger moves sideways.** It is a full width band inside
  a ScrollView, and claiming the gesture on contact would eat every vertical swipe that begins over
  it (`isScrubGesture`, in `wallet/price.ts`).
- **With no curve, no change is asserted.** `periodChange` returns 0 for an empty series, which would
  draw a green "+0.00%" beside "Chart unavailable" for the screen reader to announce, so the delta
  disappears along with the curve.
- **The chart does not mirror under RTL.** Time runs left to right in every locale, and flipping it
  would put "now" where the eye looks for the past. The rest of the layout mirrors normally.
- **A tap opens, a long press still edits.** In Home's list both gestures coexist through
  `Gesture.Exclusive(longPress, tap)`, with the long press, which enters edit mode, taking priority.
- **Movements are requested already filtered** (`AssetFilter.Bitcoin` and `AssetFilter.Token`, the
  binding's variants, never a string) over a window of 25, and filtered again on the client before
  showing 5. Asking without the filter would leave USDB's screen empty on a wallet with heavy BTC
  activity, and keeping the local filter is what holds the "this asset only" promise even if the
  SDK's filter behaves differently from its documentation, which is not validated on a device.

## Why no reanimated

`PriceCard` uses core's `PanResponder` rather than `gesture-handler` with `reanimated`. The
practical reason is that this project's Jest does not run worklets, so every component using
reanimated ends up stubbed in `jest.setup.js` (as `AssetList`, `WalletList` and `Skeleton` are) and
goes untested. The scrub is an x to index map, which `PanResponder` covers entirely, and this way
the card is genuinely testable: line colour, the value read while dragging, switching period.

The x to index map lives in `wallet/price.ts` (`scrubIndex`), pure and tested with the edge cases:
dragging past either end, an unmeasured width, a series of a single point.

## Files

- `src/wallet/price.ts`, the source, the cache, the rescale, the delta, `scrubIndex`. Pure where it
  can be.
- `src/wallet/fiatDisplay.ts`, whose `resolveDisplayCurrency` returns the saved currency with its
  formatter already configured. Every screen that draws a fiat amount asks for the same thing, and
  separate copies would drift.
- `src/components/PriceCard.tsx`, the card.
- `src/screens/AssetDetailScreen.tsx`, the screen.
- `__tests__/price.test.ts`, `__tests__/priceCard.test.tsx`, `__tests__/assetDetail.test.tsx`.

## Pending validation on a device

None of this has been seen running: the chart actually drawn, the drag under a finger, Kraken
answering from a handset, the screen being pushed. The suite passes and the types line up, and that
is all.

## The strip on Home

`PriceStrip` sits under Home's scroll, above the tab bar, and only there: it has no chart, since this
page's chart lives on the asset screen. The 24 hour change is the `1D` series through `dayChangePct`,
which answers null for a series that does not reach a day back or that ended more than 30 minutes ago,
because `fetchBtcPriceSeries` answers a stale cache rather than nothing, and that is fine for a chart
but says nothing of the last day. The series moves in USD and is rescaled onto the spot, so the figure
is bitcoin's own move, as on the asset screen, and not the move of the price in another currency.

The strip and the chart state one figure only when they read one series, since the percentage comes
from Kraken's candles and not from the spot, and two reads minutes apart differ by what the market did.
So the strip reads the `1D` series again on every price read, which keeps it within a minute of the
cache's five, and on `onDaySeriesFetched`, when anything brought a newer one. In the minute after the
cache expires a tap can still fetch a series newer than the one the strip showed, and the strip follows
as soon as that series lands.

A price stops being current on a failed read, past `PRICE_MAX_AGE_MS`, or while Home's hero says it is
not updated. The strip then keeps it muted and drops the change, at the same height. Only a feed with
no such currency, or a change of currency, takes the price away.
