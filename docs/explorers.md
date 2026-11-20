# Block explorer, the "view in explorer" link

The Spark SDK reads no block explorer (its `Config` has no field for one), so this setting decides
one thing only, **where a transaction link opens**.

## What it is

The **Block explorer** item in the menu chooses **which site a transaction opens in** when the user
taps "view in explorer" from a history entry, or from the detail of a bitcoin deposit still on its
way (a pending row above the history). Nothing beyond that. A deposit being sent back opens its
return transaction once the network has accepted it, which is where the money is going; a return
signed and not yet seen, or refused, is on no chain, so the link stays on the received transaction.

- Ships with **mempool.space** and **blockstream.info**.
- The user can add **their own** (a self-hosted mempool or esplora, including one on the local
  network, such as `http://node.local:3006`), and remove the ones they added.
- The selected one is the filled dot. Adding selects it.
- Removing goes through edit mode, opened by the **Edit** link above the list, by holding an added
  explorer, or by the edit action a screen reader finds on one. The link shows only once an explorer
  has been added, since the shipped ones cannot be removed. Under reduced motion the remove slot
  appears at once instead of sliding the rows over.

## What it is NOT, and why that matters

**It is not a data source.** Balance, sync and payments come from the Spark operators, and the
choice here cannot break or delay any of them. That is why the screen has no failover, no
availability probe and no Electrum mode.

- **No failover**, because there is nothing to fail. If the site is down, the browser says so.
- **No probe**, because it is a site opened in a browser, not an API the app consumes. An explorer
  on the user's own local network would not answer a probe from the app anyway.
- **No Electrum**, because Electrum is TCP and has no web page to open.

**Plain http is valid, deliberately.** Somebody running their own explorer behind a VPN, a mesh
network or on the LAN alone has neither a certificate nor a public name, and requiring https would
lock out exactly the self-hosting user the screen exists for. What validation refuses is a scheme that is not
the web (`javascript:`, `file:`), because the address is typed by the user and ends up in
`Linking.openURL`. Since the link opens in the **browser**, Android's cleartext policy and iOS's ATS
never enter the path, because they govern requests the app makes, and the app makes none here.

## How the URL is built

`explorerTxUrl(method, txId, base)` in `wallet/history.ts`:

- builds a link only for an **on-chain** payment with a txid, since Lightning and Spark have no
  on-chain transaction;
- **preserves the path** of the address, so a self-hosted install under a subpath
  (`https://mynode.com/mempool`) becomes `https://mynode.com/mempool/tx/{id}`, where trimming to
  the origin would produce a link to a site that is not the user's;
- drops the trailing slash, so the separator never doubles;
- **refuses anything that is not http(s)**. The value is typed by the user and ends in
  `Linking.openURL`, so `javascript:` and `file:` are barred here and in the field's validation.

`/tx/{id}` is the path mempool.space, blockstream.info and their self-hosted builds all use, which
is why one format covers both presets and custom entries.

## Persistence

`settings.json`, key `txExplorer` (`{ custom: [], selectedId }`). The presets are **not** written,
only referenced by id, so the built-in list can change without a migration. A selection pointing at
something that no longer exists (a preset dropped from the built-in list, for example) resolves to
the first preset rather than leaving a broken link.

Every write merges into the existing file, so a key that no setting reads, such as an `explorers`
entry left by an older build, stays in `settings.json` and has no effect.

## Files

- `src/wallet/settings.ts`, the model, the presets, the URL validation.
- `src/wallet/history.ts`, `explorerTxUrl`.
- `src/screens/ExplorersScreen.tsx`, the screen.
- `src/components/TransactionDetailSheet.tsx`, reads the preference and opens the link, for a
  payment (`TransactionDetailSheet`) and for a pending deposit (`DepositDetailSheet`).
- `__tests__/explorersScreen.test.tsx`, covers choosing, adding a self-hosted entry, refusing an
  invalid address, and the one that matters most: that the choice reaches the link that opens.

## Pending on device

Actually opening the link (`Linking.openURL`) on a handset, including an address on the local
network.
