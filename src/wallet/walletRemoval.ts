import { isWalletHasLiveExit } from './exitPlan'
import { removeWalletById } from './wallet'
import { loadRegistry } from './walletRegistry'

// How a removal a screen asked for ended. `gone` covers a removal that threw after the wallet had
// already left the registry, since the screen then has nothing left to show and moves on as on
// success.
export type RemovalOutcome = 'gone' | 'liveExit' | 'failed'

// What a screen says for a removal that left the wallet in place. Literal keys, one per outcome.
export const REMOVAL_ERRORS: Readonly<Record<Exclude<RemovalOutcome, 'gone'>, string>> = {
  liveExit: 'emergencyExit.removeRefused',
  failed: 'editWallet.removeFailed',
}

/**
 * Removes the wallet `id` and says how it ended, for Edit wallet and for the deletion screen.
 *
 * The removal runs in steps, so after an error the registry is what says whether the wallet is still
 * here. A registry that cannot be read counts as still holding it, which only keeps the error up.
 */
export async function removeWalletAndCheck(id: string, fingerprint: string): Promise<RemovalOutcome> {
  try {
    await removeWalletById(id, fingerprint)
    return 'gone'
  } catch (err) {
    if (isWalletHasLiveExit(err)) {
      return 'liveExit'
    }
    const stillHere = await loadRegistry().then(
      reg => reg.wallets.some(w => w.id === id),
      () => true,
    )
    return stillHere ? 'failed' : 'gone'
  }
}

/**
 * Removes the wallet `id` with the registry's fingerprint for it, which its photos are swept by,
 * for a screen that knows the wallet by id alone.
 *
 * A registry that cannot be read removes nothing, rather than sweep by a fingerprint it does not
 * know; a wallet it no longer lists is already gone.
 */
export async function removeListedWallet(id: string): Promise<RemovalOutcome> {
  const reg = await loadRegistry().catch(() => null)
  if (!reg) {
    return 'failed'
  }
  const entry = reg.wallets.find(w => w.id === id)
  return entry ? removeWalletAndCheck(id, entry.fingerprint) : 'gone'
}
