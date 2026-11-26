// Wallet lifecycle over the registry and the Keychain. Payment flows go through wallet/spark.ts.

import {
  SparkReconnectBusy,
  connectActiveSpark,
  connectSpark,
  disconnectSpark,
  disconnectSparkWhenIdle,
  sparkEraseLocalData,
  whileSparkErasing,
} from './spark'
import {
  PRIMARY_ID,
  deleteSeedFor,
  deletePassphraseFor,
  hasSeedFor,
  listPassphraseIds,
  listSeedIds,
  loadPassphraseFor,
  loadSeedFor,
  savePassphraseFor,
  saveSeedFor,
} from './seed'
import { fingerprintFromMnemonicAsync } from './fingerprint'
import { refuseMinor } from './ageSignal'
import { noteHeld, wasHeld } from './heldWallets'
import { deleteWalletImage } from './walletImage'
import { carryWalletMeta } from './walletMeta'
import { clearDeletionMark, clearImportCheck, noteImportCheck } from './deletionMark'
import { forgetPurchaseAsk } from './recover'
import { forgetWalletLines } from './releasedLines'
import { forgetConversionNotes } from './conversionNotes'
import { forgetLnAddress } from './lnAddressMemory'
import { forgetDollarInviteSeen, forgetDollarMode } from './settings'
import { clearDomainFor } from './lnurlDomainPref'
import { forgetDomainAsk, forgetDomainCache } from './domainTier'
import { clearUnconfirmed, countUnconfirmed, markUnconfirmed } from './backupMark'
import { deletePin } from './pin'
import { disableBiometricUnlock } from './biometrics'
import { isUnreadableFile } from './durableFile'
import { emergencyExitLive } from './emergencyExit'
import { forgetTokenPrefs } from './tokenPrefs'
import { forgetExitPlan, isLivePlan, loadExitPlan, WalletHasLiveExit } from './exitPlan'
import { forgetPendingSends } from './pendingSends'
import { forgetStoreReview } from './storeReview'
import { retirePaymentWebhook } from './paymentWebhook'
import {
  forgetPasskeyWallet,
  notePasskeyWallet,
  passkeyWalletStored,
  type PasskeyNote,
  type PasskeyWallet,
} from './passkey'
import {
  ensureRegistered,
  getActiveWalletId,
  loadRegistry,
  newWalletId,
  removeWalletEntry,
  registryRepairPending,
  replaceUnreadableRegistry,
  setActiveWallet,
  type Registry,
  type WalletEntry,
} from './walletRegistry'

// What moving the active pointer onto a wallet throws when that wallet's seed is not in the Keychain.
// The registry lives in Documents, which an iCloud or computer backup carries to a new iPhone, while
// every seed is stored WHEN_UNLOCKED_THIS_DEVICE_ONLY and stays behind, so a restored registry can list
// wallets this device cannot open. Such a wallet cannot sign, so it is never made active, and it can
// still be removed.
export class WalletSeedAbsent extends Error {
  constructor(readonly walletId: string) {
    super(`the seed of wallet ${walletId} is not on this device`)
    this.name = 'WalletSeedAbsent'
  }
}

// Read by name, which survives any transpilation of the class.
export function isWalletSeedAbsent(err: unknown): boolean {
  return (err as Error | null)?.name === 'WalletSeedAbsent'
}

// What adding throws when this device already holds a listed wallet with the same words and
// passphrase. Adding it again would list one key under two ids, and two ids keep two sets of records
// (deletion marks, the address, purchase proofs) for one key, so a reader that asks one id misses the
// other's. The existing id and its registry fingerprint travel with it, so a screen can name it.
export class WalletAlreadyAdded extends Error {
  constructor(
    readonly walletId: string,
    readonly fingerprint: string,
  ) {
    super(`these words and passphrase are already wallet ${walletId}`)
    this.name = 'WalletAlreadyAdded'
  }
}

// Read by name, which survives any transpilation of the class.
export function isWalletAlreadyAdded(err: unknown): err is WalletAlreadyAdded {
  return (err as Error | null)?.name === 'WalletAlreadyAdded'
}

// The listed wallet whose seed is on this device with exactly these words and passphrase. Only an
// entry with the same fingerprint is read, and its secrets are compared in memory and never logged.
// The fingerprint alone is not enough, since its four bytes can collide for different words. A read
// that throws propagates before anything is written. An absent passphrase and an empty one are the
// same wallet, as savePassphraseFor stores them.
async function presentTwinOf(
  wallets: readonly WalletEntry[],
  fingerprint: string,
  mnemonic: string,
  passphrase: string | undefined,
): Promise<WalletEntry | undefined> {
  for (const w of wallets) {
    if (w.fingerprint !== fingerprint || !(await hasSeedFor(w.id))) {
      continue
    }
    if ((await loadSeedFor(w.id)) === mnemonic && ((await loadPassphraseFor(w.id)) ?? '') === (passphrase ?? '')) {
      return w
    }
  }
  return undefined
}

// A listed wallet with these words whose seed is not on this device, as on an iPhone restored from
// another device's backup. Saving the same words again takes its id, so the list keeps one row for the
// wallet and everything this device keeps under that id (the domain, the remembered address,
// settings, purchase proofs, deletion marks) stays with it. The seed is gone, so the words cannot be
// compared as presentTwinOf does, and the match is the four-byte fingerprint alone: different words
// take a lost wallet's id, and its records, only on a fingerprint collision, about 1 in 2^32 for each
// lost entry. Only a listed entry with the same fingerprint is asked, and a read that throws
// propagates before anything is written.
async function lostEntryWith(wallets: readonly WalletEntry[], fingerprint: string): Promise<string | undefined> {
  for (const w of wallets) {
    if (w.fingerprint === fingerprint && !(await hasSeedFor(w.id))) {
      return w.id
    }
  }
  return undefined
}

// A wallet this device holds or held is not a new one, so its words go on whatever the store's age
// signal says: one the list names (with its seed, or without it after a backup carried the list), and
// one removed here, the erase behind Forgot PIN included (heldWallets.ts). Any other wallet is refused
// with AgeRefusal when the signal says the person is under 18 (ageSignal.ts).
async function refuseNewForMinor(wallets: readonly WalletEntry[], fingerprint: string): Promise<void> {
  if (wallets.some(w => w.fingerprint === fingerprint) || (await wasHeld(fingerprint))) {
    return
  }
  await refuseMinor()
}

// An id no wallet here holds: not listed, and with no seed in the Keychain under it, which a kill
// before the registry write can leave. The add writes the passphrase and the seed under its id with
// no further check, so a taken id would replace another wallet's key. newWalletId keeps the time
// prefix the repair orders by (repairRegistry). A read that throws propagates before anything is
// written, and a Keychain that answers every id as taken stops the add rather than spin.
const FRESH_ID_DRAWS = 8

async function freshWalletId(wallets: readonly WalletEntry[]): Promise<string> {
  for (let draw = 0; draw < FRESH_ID_DRAWS; draw++) {
    const id = newWalletId()
    if (!wallets.some(w => w.id === id) && !(await hasSeedFor(id))) {
      return id
    }
  }
  throw new Error('no free wallet id')
}

// Where a wallet's words came from, which decides what the add owes them.
//   drawn            shown on screen, with nothing proving they were kept
//   confirmed        a dice phrase that passed its confirmation before the add
//   typed            entered by hand, so the person holds them and the wallet may have a past
//   passkeyCreated   derived from a passkey registered for this wallet
//   passkeyRestored  derived from a passkey that already existed, so the wallet may have a past, and a
//                    biometric tap shows nothing about holding the words
export type WalletOrigin = 'drawn' | 'confirmed' | 'typed' | 'passkeyCreated' | 'passkeyRestored'

const WORDS_PROVED: ReadonlySet<WalletOrigin> = new Set<WalletOrigin>(['confirmed', 'typed'])
const MAY_HAVE_A_PAST: ReadonlySet<WalletOrigin> = new Set<WalletOrigin>(['typed', 'passkeyRestored'])

// Who has proved they hold the words: whoever typed them, or confirmed them before the add. The mark
// of words shown and not proved goes in before the seed, which is what makes the wallet exist, so a
// kill between the two leaves a mark with no wallet and never a wallet with no mark, and a mark that
// cannot be stored stops the add. Proved words take back any mark the id holds, after the seed, since
// a mark left there by a failure costs one more confirmation and a mark lost costs a wallet. A clear
// that fails is logged and the add goes on, for the same reason.
//
// A passkey's note goes in before the seed as well, so a wallet that owes its words is never left
// without what says so.
async function saveSeedMarked(
  id: string,
  mnemonic: string,
  origin: WalletOrigin,
  fingerprint: string,
  note: PasskeyNote | undefined,
): Promise<void> {
  const proved = WORDS_PROVED.has(origin)
  if (!proved) {
    await markUnconfirmed(id)
  }
  if (note) {
    await notePasskeyWallet(id, fingerprint, note)
  }
  await saveSeedFor(id, mnemonic)
  if (proved) {
    await clearUnconfirmed(id).catch((err: unknown) => {
      console.warn(`unconfirmed mark not cleared: ${(err as Error)?.message ?? String(err)}`)
    })
  }
}

// The fingerprint is derived locally, so no connection is needed and Home connects on focus.
//
// An imported seed may have had its data deleted at Voltz from another device, which leaves no mark
// here, so its deletion status is read once Home can sign for it (deletion.ts,
// checkImportedDeletion). A list that cannot be written costs only that early read: the gateway still
// refuses the key, and the address screen reads the status on that refusal.
//
// The passphrase is written before the seed, as in addFirstWallet: on a listed id a seed written
// alone would open at boot without its passphrase, which is a different, empty wallet.
//
// The same words and passphrase as a wallet already here are refused with WalletAlreadyAdded before
// anything is written. The same words with another passphrase are another wallet and are added.
//
// A wallet this device never held is refused with AgeRefusal when the store's age signal says the
// person is under 18, before anything is written (refuseNewForMinor).
//
// `origin` left out counts the words as shown and not proved, the safe side for a caller that forgets it.
export async function addAndActivateWallet(
  mnemonic: string,
  passphrase?: string,
  origin: WalletOrigin = 'drawn',
  note?: PasskeyNote,
): Promise<string> {
  // The fingerprint covers mnemonic+passphrase, so the entry matches what the SDK connects to.
  const fingerprint = await fingerprintFromMnemonicAsync(mnemonic, passphrase)
  const { wallets } = await loadRegistry()
  const twin = await presentTwinOf(wallets, fingerprint, mnemonic, passphrase)
  if (twin) {
    throw new WalletAlreadyAdded(twin.id, twin.fingerprint)
  }
  await refuseNewForMinor(wallets, fingerprint)
  const id = (await lostEntryWith(wallets, fingerprint)) ?? (await freshWalletId(wallets))
  await savePassphraseFor(id, passphrase ?? '')
  await saveSeedMarked(id, mnemonic, origin, fingerprint, note)
  await ensureRegistered(id, fingerprint)
  if (MAY_HAVE_A_PAST.has(origin)) {
    await noteImportCheck(id).catch(() => undefined)
  }
  await activate(id)
  return id
}

// The first-run onboarding's wallet, made the active one and recorded with its fingerprint as
// addAndActivateWallet does for a later wallet, so the next open finds it whatever the registry held.
//
// Wallets listed when the onboarding runs are ones whose seeds are absent (the boot found none to
// open). The same words as one of them take its id (lostEntryWith). Otherwise the primary id, whose
// Keychain entry predates the registry, goes only to a registry with no wallet in it, and any other
// wallet takes an id of its own rather than inheriting a lost wallet's records or slot. The same words
// on a wallet that does have its seed are this write repeated after failing past its registry line, and
// keep that line, or one key would be listed twice. A wallet this device never held is refused with
// AgeRefusal when the store's age signal says the person is under 18 (refuseNewForMinor).
//
// The passphrase is written before the seed. The seed is what makes a wallet exist at boot, so a kill
// between the two leaves no wallet rather than one that opens without its passphrase, which is a
// different, empty wallet. On a fresh id, a kill before the registry write leaves a seed that no entry
// names and nothing reads; on the primary id, or on an id taken back, the boot finds it with its
// passphrase already in place.
export async function addFirstWallet(
  mnemonic: string,
  passphrase: string | undefined,
  origin: WalletOrigin,
  note?: PasskeyNote,
): Promise<string> {
  const fingerprint = await fingerprintFromMnemonicAsync(mnemonic, passphrase)
  const { wallets } = await loadRegistry()
  const twin = await presentTwinOf(wallets, fingerprint, mnemonic, passphrase)
  await refuseNewForMinor(wallets, fingerprint)
  const id =
    twin?.id ??
    (await lostEntryWith(wallets, fingerprint)) ??
    (wallets.length === 0 ? PRIMARY_ID : await freshWalletId(wallets))
  await savePassphraseFor(id, passphrase ?? '')
  await saveSeedMarked(id, mnemonic, origin, fingerprint, note)
  await ensureRegistered(id, fingerprint)
  if (MAY_HAVE_A_PAST.has(origin)) {
    await noteImportCheck(id).catch(() => undefined)
  }
  await activate(id)
  return id
}

const passkeyOrigin = (wallet: PasskeyWallet): WalletOrigin =>
  wallet.note.created ? 'passkeyCreated' : 'passkeyRestored'

// A passkey's words enter through the same doors as typed ones, with no passphrase: the passkey
// derives none, and one added here would be a wallet the passkey can no longer reopen. Nothing connects
// before the seed is stored, which is what leaves no passkey wallet the app has shown but cannot reopen.
export async function addFirstPasskeyWallet(wallet: PasskeyWallet): Promise<string> {
  const id = await addFirstWallet(wallet.mnemonic, undefined, passkeyOrigin(wallet), wallet.note)
  passkeyWalletStored(wallet.note)
  return id
}

// A sign-in can land on a wallet this device already lists, and a second row for one key would split
// its records, so the person is taken to that wallet instead. The note only adds what the entry lacks,
// and it cannot stop the switch, since the wallet is here either way.
export async function addPasskeyWallet(wallet: PasskeyWallet): Promise<string> {
  try {
    const id = await addAndActivateWallet(wallet.mnemonic, undefined, passkeyOrigin(wallet), wallet.note)
    passkeyWalletStored(wallet.note)
    return id
  } catch (err) {
    if (!isWalletAlreadyAdded(err)) {
      throw err
    }
    await notePasskeyWallet(err.walletId, err.fingerprint, wallet.note).catch((noted: unknown) => {
      console.warn(`passkey note not kept: ${(noted as Error)?.message ?? String(noted)}`)
    })
    passkeyWalletStored(wallet.note)
    await switchWalletAndConnect(err.walletId)
    return err.walletId
  }
}

// Fires before the SDK reconnects, so per-wallet chrome never sits on the previous wallet's accent
// and Home never keeps the previous wallet's figure.
const activeWalletListeners = new Set<(id: string) => void>()

export function onActiveWalletChanged(cb: (id: string) => void): () => void {
  activeWalletListeners.add(cb)
  return () => {
    activeWalletListeners.delete(cb)
  }
}

// The one way this module moves the active pointer. Adding, switching, removing and the boot all go
// through it, because a move that is not announced leaves Home on the previous wallet's figure,
// unmarked. The boot's repair of an unreadable list (repairRegistry) writes the pointer with the
// rebuilt list instead, which no screen hears since none listens before the boot ends. The seed is
// asked for first: only an answer of absent refuses, and a read that throws propagates, so the
// pointer never moves on a failed read.
async function activate(id: string): Promise<void> {
  if (!(await hasSeedFor(id))) {
    throw new WalletSeedAbsent(id)
  }
  await setActiveWallet(id)
  activeWalletListeners.forEach(cb => cb(id))
}

// Repoints the registry and announces the change without touching the live connection, which is
// what the wallet picker wants: the chrome repaints at once and Home reconnects on focus. Named for
// what it leaves undone, because a flow that talks to the SDK after switching needs
// switchWalletAndConnect below, and picking this one by accident is a bug the suite cannot see.
export async function switchWalletWithoutReconnecting(id: string): Promise<void> {
  await activate(id)
}

// Switching repoints the registry and leaves the reconnect to a screen focus. A flow that switches
// and then talks to the SDK without a focus in between reaches the previous wallet, so it has to
// reconnect itself: the lightning address transfer signs with whichever wallet is connected, and
// running a leg on the wrong one produces a request the server refuses.
export async function switchWalletAndConnect(id: string): Promise<void> {
  await switchWalletWithoutReconnecting(id)
  await connectActiveSpark()
}

// The first of these wallets whose seed answers present, asked in order and stopping there. Reads
// only the Keychain presence flag, without decrypting any seed. A read that throws propagates.
async function firstWithSeed(wallets: readonly WalletEntry[]): Promise<WalletEntry | undefined> {
  for (const w of wallets) {
    if (await hasSeedFor(w.id)) {
      return w
    }
  }
  return undefined
}

// A list of wallets rebuilt from the seeds the Keychain holds, for a list that cannot be read. Each
// entry carries the fingerprint of its words and passphrase, which is what keys a wallet's name,
// colour and image, so every wallet comes back as it was shown. The primary goes first and the rest
// by id, whose time prefix orders them by when they were added, and the first is the active one.
// Wallets listed without their seed on this device cannot be rebuilt; their ids stay in the file set
// aside. Any read that throws, or a seed that answers present and reads empty, propagates before
// anything is written.
async function repairRegistry(): Promise<Registry> {
  const ids = await listSeedIds()
  const ordered = [
    ...ids.filter(id => id === PRIMARY_ID),
    ...ids.filter(id => id !== PRIMARY_ID).sort(),
  ]
  const entries: WalletEntry[] = []
  for (const id of ordered) {
    const words = await loadSeedFor(id)
    if (!words) {
      throw new Error(`the seed of wallet ${id} answered present and read empty`)
    }
    entries.push({ id, fingerprint: await fingerprintFromMnemonicAsync(words, await loadPassphraseFor(id)) })
  }
  return replaceUnreadableRegistry(entries, entries[0]?.id ?? null)
}

// The boot's answer to whether a wallet can open. The active wallet is the one the registry points
// at, or the primary on a registry that names none. When its seed answers absent, as on an iPhone
// restored from another device's backup, the pointer moves to the first registered wallet whose seed
// is present, and then to a primary seed the registry does not list (stored by an onboarding that
// did not register it, beside a registry from another device), so a person holding a wallet is never
// sent back to the onboarding. False only when no such seed is here.
// A registry that cannot be read, or one a repair set aside and wrote nothing after, is first rebuilt
// from the Keychain (repairRegistry), and any other failure of its read propagates. Past that, nothing
// is written before a seed answers present, so a read that throws leaves the registry as it was and
// the boot fails closed.
export async function settleActiveWallet(): Promise<boolean> {
  const reg = await loadRegistry().then(
    async found => (found.wallets.length === 0 && (await registryRepairPending()) ? repairRegistry() : found),
    (err: unknown) => {
      if (!isUnreadableFile(err)) {
        throw err
      }
      return repairRegistry()
    },
  )
  const activeId = reg.active ?? PRIMARY_ID
  if (await hasSeedFor(activeId)) {
    return true
  }
  const next = await firstWithSeed(reg.wallets.filter(w => w.id !== activeId))
  if (next) {
    await activate(next.id)
    return true
  }
  const primaryOutOfReach = activeId === PRIMARY_ID || reg.wallets.some(w => w.id === PRIMARY_ID)
  if (primaryOutOfReach || !(await hasSeedFor(PRIMARY_ID))) {
    return false
  }
  const words = await loadSeedFor(PRIMARY_ID)
  if (!words) {
    throw new Error('the primary seed answered present and read empty')
  }
  // Registered first, since the pointer moves only onto a listed wallet.
  await ensureRegistered(PRIMARY_ID, await fingerprintFromMnemonicAsync(words, await loadPassphraseFor(PRIMARY_ID)))
  await activate(PRIMARY_ID)
  return true
}

// The wallet's deletion mark and its entry in the import check list go first. A mark left behind
// keeps holding the same seed imported again under a new id, by its key, with nothing on that
// wallet's screens to say why. Any failure of either file, unreadable or unwritable, is logged and
// the removal goes on: an unreadable mark file holds every wallet while it stays so, which is the
// safe side, a check entry left behind costs one status read, and the wallet the person asked to
// remove goes anyway.
// Its cached dollar mode, when it last asked about purchases, the released lines kept for it and its
// conversion notes go once it is unlisted, each logged and passed over on failure, since any of them
// left behind is only an entry under an id no wallet holds, or, under the primary id, which passes to
// the next first wallet, an entry that wallet reads as its own. A line names an address or a host and owes
// nothing on this device, so it goes with the wallet rather than coming back under the id the same words
// take again. So does the address it was last seen holding, which never fails the removal, and what is
// remembered of its passkey, which itself stays in the person's account, out of this app's reach. Its
// own-domain choice goes as well: the primary id passes to the next first wallet, which would connect
// on a domain it may not register on and never hold an address. The same words get the domain back
// from the gateway only when they own it and it is not frozen; a member's place on one is chosen again.
// Its purchase proofs are kept, since they stand for money paid. Its unconfirmed mark goes after the
// seed: a removal that fails before that leaves the wallet here, and a wallet still here keeps its mark.
export async function removeWallet(id: string, fingerprint: string): Promise<void> {
  // Before the seed goes, so a removal cut in the middle leaves the words able to come back past the
  // age gate. A note that fails costs only that, and never stops the removal.
  await noteHeld(fingerprint).catch((err: unknown) => {
    console.warn(`held wallet not noted on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await clearDeletionMark(id).catch((err: unknown) => {
    console.warn(`deletion mark not cleared on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await clearImportCheck(id).catch((err: unknown) => {
    console.warn(`import check not cleared on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  // The secret signs this wallet's payment notices at the gateway, so it does not outlive the wallet
  // here: a forget proved with it is queued and sent, needing neither the secret nor the words again,
  // and what the provider may still hold moves to the removal marker, which stays until a connect of
  // this key removes it. A re-added wallet draws a new secret. Only the provider's removal on this
  // wallet's own connection is waited on, bounded, and nothing that fails stops the removal.
  await retirePaymentWebhook(id).catch((err: unknown) => {
    console.warn(`payment webhook not retired on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await deleteSeedFor(id)
  await deletePassphraseFor(id)
  await deleteWalletImage(fingerprint).catch(() => undefined)
  await removeWalletEntry(id)
  await clearUnconfirmed(id).catch((err: unknown) => {
    console.warn(`unconfirmed mark not cleared on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await forgetDollarMode(id).catch((err: unknown) => {
    console.warn(`dollar mode not cleared on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await forgetDollarInviteSeen(id).catch((err: unknown) => {
    console.warn(`dollar invitation not cleared on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await forgetPurchaseAsk(id).catch((err: unknown) => {
    console.warn(`purchase ask not cleared on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await forgetWalletLines(id).catch((err: unknown) => {
    console.warn(`released lines not cleared on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await forgetConversionNotes(id).catch((err: unknown) => {
    console.warn(`conversion notes not cleared on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await clearDomainFor(id).catch((err: unknown) => {
    console.warn(`domain choice not cleared on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await forgetDomainCache(id).catch((err: unknown) => {
    console.warn(`domain answer not cleared on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await forgetPasskeyWallet(id).catch((err: unknown) => {
    console.warn(`passkey note not cleared on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await forgetExitPlan(id).catch((err: unknown) => {
    console.warn(`exit plan not cleared on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await forgetTokenPrefs(id).catch((err: unknown) => {
    console.warn(`token lists not cleared on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await forgetPendingSends(id).catch((err: unknown) => {
    console.warn(`pending sends not cleared on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await forgetStoreReview(id).catch((err: unknown) => {
    console.warn(`review ask not cleared on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await forgetDomainAsk(id)
  await forgetLnAddress(id)
}

// A plan the platform will not read may stand for a live exit, so it holds the wallet too.
// Exported for a removal that waits on something else first, which asks before it starts.
export async function holdsLiveExit(id: string): Promise<boolean> {
  if (!emergencyExitLive()) {
    return false
  }
  return loadExitPlan(id).then(isLivePlan, () => true)
}

export async function removeWalletById(id: string, fingerprint: string): Promise<void> {
  // The words open the fee key, and the plan follows only from this wallet, so removing it would strand
  // an exit halfway. An erase takes the plan with everything else, since preparing again on the restored
  // wallet picks the funds up wherever they are.
  if (await holdsLiveExit(id)) {
    throw new WalletHasLiveExit(id)
  }
  if (id === (await getActiveWalletId())) {
    await removeActiveWallet()
  } else {
    await removeWallet(id, fingerprint)
  }
}

// Switches away before deleting, so the live connection is never left on a deleted wallet. The wallet
// it lands on is the first other one whose seed is on this device. With none, the removal is refused
// before anything is touched, since the device would be left with no wallet that opens.
export async function removeActiveWallet(): Promise<void> {
  const reg = await loadRegistry()
  const activeId = reg.active
  const others = reg.wallets.filter(w => w.id !== activeId)
  if (!activeId || others.length === 0) {
    return
  }
  const other = await firstWithSeed(others)
  if (!other) {
    throw new WalletSeedAbsent(others[0].id)
  }
  const removed = reg.wallets.find(w => w.id === activeId)
  // The connection is this wallet's last, so its webhook comes off the provider now. One the provider
  // does not confirm in time stays in the removal marker.
  await retirePaymentWebhook(activeId).catch((err: unknown) => {
    console.warn(`payment webhook not retired on removal: ${(err as Error)?.message ?? String(err)}`)
  })
  await disconnectSpark().catch(() => undefined)
  await activate(other.id)
  await removeWallet(activeId, removed?.fingerprint ?? '')
}

// The way out of a forgotten PIN. It runs at the lock, and the app takes the navigator down before it
// starts, so no screen is left to read the wallet meanwhile. removeWallet has no last-wallet guard, which removeActiveWallet has, and each wallet
// goes whole, its purchase proofs staying as they do on any removal, and the SDK's folder goes with the
// last of them. A folder that cannot be erased holds no seed, so it never stops the way out.
//
// The ids come from the Keychain as well as the list, so a seed an earlier install left, or a passphrase
// a cut write left, goes too. The primary id always goes: records can sit under it with no seed and no
// entry, and the next first wallet takes that id and would inherit them.
//
// The PIN goes last and only once the Keychain lists no seed. A seed with no PIN opens at the PIN step at
// boot, so taking the PIN first would let a kill in the middle hand a wallet to whoever sets a new PIN.
// Any failure propagates and leaves the PIN. The biometric copy of the PIN goes before it, since a copy
// left after the PIN is one a later PIN would never match.
export function eraseAllWallets(): Promise<void> {
  // Every connect is refused while it runs: the next first wallet takes the same primary id, and
  // connectActiveSpark keeps a connection already on it, so one landing on the erased seed mid erase
  // would outlive it.
  return whileSparkErasing(eraseEverything)
}

async function eraseEverything(): Promise<void> {
  // The lock over a running wallet offers the erase too, so the live connection goes first.
  await disconnectSpark().catch(() => undefined)
  const { wallets } = await loadRegistry()
  const ids = new Set([
    PRIMARY_ID,
    ...wallets.map(w => w.id),
    ...(await listSeedIds()),
    ...(await listPassphraseIds()),
  ])
  for (const id of ids) {
    await removeWallet(id, wallets.find(w => w.id === id)?.fingerprint ?? '')
  }
  const left = await listSeedIds()
  if (left.length > 0) {
    throw new Error(`${left.length} seeds were still listed after the erase`)
  }
  await sparkEraseLocalData().catch((err: unknown) => {
    console.warn(`SDK folder not erased: ${(err as Error)?.message ?? String(err)}`)
  })
  await disableBiometricUnlock()
  await deletePin()
}

// How many wallets here have words nobody confirmed, for the warning before an erase. Counted over the
// seeds on the device, the ones the erase takes, since the list can miss one. Rejects when the Keychain
// cannot be listed, and the warning then goes without the number.
export async function countUnconfirmedWallets(): Promise<number> {
  return countUnconfirmed(await listSeedIds())
}

export type WalletIdentity = { fingerprint: string }

// The fingerprint the registry records, of the words and the passphrase, so every screen shows one id
// for a wallet and keys its name, colour and image where the wallets list reads them. Spark's getInfo
// has no fingerprint, so local BIP32 derivation from the seed is the only source. A passphrase wallet
// carries over, once, what was saved under the fingerprint of its words alone. A carry that fails
// leaves that entry in place and runs again on the next read. Both derivations are the async ones:
// this runs on the drawer, Edit wallet and the recovery phrase screen, right after the PIN, and the
// synchronous PBKDF2 would hold the JS thread for its 2048 rounds.
export async function walletIdentityOf(
  mnemonic: string,
  passphrase: string | undefined,
): Promise<WalletIdentity> {
  const fingerprint = await fingerprintFromMnemonicAsync(mnemonic, passphrase)
  if (passphrase) {
    await carryWalletMeta(fingerprint, () => fingerprintFromMnemonicAsync(mnemonic)).catch((err: unknown) => {
      console.warn(`wallet name not carried over: ${(err as Error)?.message ?? String(err)}`)
    })
  }
  return { fingerprint }
}

export async function getWalletIdentity(): Promise<WalletIdentity> {
  const activeId = (await getActiveWalletId()) ?? PRIMARY_ID
  const mnemonic = await loadSeedFor(activeId)
  if (!mnemonic) {
    return { fingerprint: '' }
  }
  return walletIdentityOf(mnemonic, await loadPassphraseFor(activeId))
}

// Reconnects the active wallet so a changed connect-time setting takes effect. The SDK reads its
// lnurl domain once, at connect, so adopting a purchased domain needs the session rebuilt.
//
// `whenIdle` is for a reconnect nobody asked for: while a send or a prepare is in flight it leaves the
// session as it is and rejects with SparkReconnectBusy (spark.ts, disconnectSparkWhenIdle).
export async function reconnectActiveWallet(options: { whenIdle?: boolean } = {}): Promise<void> {
  const activeId = (await getActiveWalletId()) ?? PRIMARY_ID
  const mnemonic = await loadSeedFor(activeId)
  if (!mnemonic) {
    return
  }
  if (options.whenIdle) {
    await disconnectSparkWhenIdle().catch((err: unknown) => {
      if (err instanceof SparkReconnectBusy) {
        throw err
      }
    })
  } else {
    await disconnectSpark().catch(() => undefined)
  }
  await connectSpark(mnemonic, activeId)
}
