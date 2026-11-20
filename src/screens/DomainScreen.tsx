import React, { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import { useTranslation } from 'react-i18next'
import { sparkGetIdentityPubkey, sparkSignMessage } from '../wallet/spark'
import { ensureLnAddressOrAdopt } from '../wallet/deletion'
import { identitySigner } from '../wallet/identitySigner'
import { forgetDomainAsk, phaseOf, readDomainState, type DomainState } from '../wallet/domainTier'
import { moveDomain, type DomainMoveStep } from '../wallet/domainMove'
import { reconnectActiveWallet, switchWalletAndConnect } from '../wallet/wallet'
import { setDomainFor } from '../wallet/lnurlDomainPref'
import { getActiveWalletId, loadRegistry } from '../wallet/walletRegistry'
import { loadWalletMeta } from '../wallet/walletMeta'
import { resolveWalletDisplay } from '../wallet/walletIdentity'
import { getBreezLnurlDomain } from '../config'
import { type ConfirmRequest } from '../components/ConfirmSheet'
import { ErrorBox } from '../components/ErrorBox'
import { WalletPickerSheet } from '../components/WalletPickerSheet'
import { MenuRow } from '../components/MenuRow'
import { WithdrawalSection } from '../components/WithdrawalSection'
import { rhythm } from '../theme'
import { Screen } from '../components/Screen'
import { Txt } from '../components/Txt'

// Each leg reconnects the SDK, which takes seconds, so the row says which one is running instead of
// sitting there looking stuck.
const STEP_LABELS: Record<DomainMoveStep, string> = {
  'reading-target': 'domain.moveStepReading',
  signing: 'domain.moveStepSigning',
  claiming: 'domain.moveStepClaiming',
}

// The gateway's refusals, which do not all mean the same thing to the person holding the phone. A
// stale sequence says the screen was out of date and the move works on the next try; a renewal in
// flight says the opposite, that trying again cannot work until the payment settles. Telling
// somebody to retry there is telling them to repeat a gesture guaranteed to fail. A Map rather than
// an object literal, so a reason that happens to name something on Object.prototype cannot resolve
// to a key nobody wrote.
const MOVE_REFUSALS = new Map<string, string>([
  ['stale_transfer_seq', 'domain.moveStale'],
  ['renewal_in_progress', 'domain.moveRenewing'],
])

// One door for everything to do with domains. Kept off the address screen so actions on the address
// are not mixed with actions on the domain, and so the word appears once.
// A handover can be refused after the person left the screen, and the reason still has to reach them,
// so it waits here for the next open.
let refusalOffScreen: string | null = null

export function DomainScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation<{ navigate: (screen: string, params?: object) => void }>()
  const [status, setStatus] = useState<DomainState | null>(null)
  // Where the address currently is, which is not the same question as who owns it. Shown because
  // this screen is where someone comes to change domains, and changing one that cannot be seen is
  // guesswork.
  const [current, setCurrent] = useState<string | null>(null)
  // The wallet the domain would move away from, and the one the picker must not offer.
  const [activeId, setActiveId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [asking, setAsking] = useState<ConfirmRequest | null>(null)
  const [moveError, setMoveError] = useState<string | null>(() => {
    const refusal = refusalOffScreen
    refusalOffScreen = null
    return refusal === null ? null : t(refusal)
  })
  const [busy, setBusy] = useState<string | null>(null)
  // Moves with every read of the screen, a handover's included, and the year purchases are read again.
  const [purchasesRead, setPurchasesRead] = useState(0)
  // The reads land after several awaits, and the handover re-runs them from a handler rather than
  // from the effect that started them, so aliveness outlives any one effect.
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // Which domain the address sits on and what the gateway says about that domain are independent
  // questions, asked separately so neither can hide the other.
  //
  // The role is asked for rather than inferred. Calling an owner-only route and reading a refusal as
  // "not the owner" cannot tell a refusal from a network that never answered, so an owner on a bad
  // connection would lose the controls for their own domain with nothing on screen to say why.
  //
  // In one function because a handover re-runs it. The move ends on the wallet that now owns the
  // domain, so every answer on screen by then was read for a wallet that no longer does.
  const read = useCallback((keep?: DomainState) => {
    setPurchasesRead(n => n + 1)
    ensureLnAddressOrAdopt()
      .then(addr => alive.current && setCurrent(addr?.address.split('@')[1] ?? null))
      // A failed read says nothing about the address, so the domain already named stays named, as on
      // the receive and address screens.
      .catch(() => undefined)
    ;(async () => {
      const walletId = await getActiveWalletId()
      if (alive.current) {
        setActiveId(walletId)
      }
      if (!walletId) {
        return null
      }
      // `keep` covers the moment right after a handover. A wallet holding a frozen domain is
      // deliberately not pointed at it, so the read has no host of its own and falls back to asking
      // what the key holds, which is a round trip and can fail. The carry is local certainty about
      // a move that already succeeded, and anything the gateway does say still wins over it.
      return (
        (await readDomainState({ walletId, ...(await identitySigner()) })) ??
        keep ??
        null
      )
    })()
      .then(next => alive.current && setStatus(next))
      // readDomainState answers null rather than rejecting, so this only covers a wallet that
      // cannot produce a key at all. The rest of the screen is worth more than the owner rows.
      .catch(() => alive.current && setStatus(null))
  }, [])

  useFocusEffect(read)

  // Only the wallet that bought the domain can renew it or change who uses it, so only that wallet
  // is offered either. A wallet let into somebody else's domain reads as a member and keeps exactly
  // the screen it has always had: which domain its address is on, and the two ways in.
  const owner = status?.role === 'owner' ? status : null
  // The gateway's clock decides this, never the device's.
  const frozen = owner ? phaseOf(owner, owner.serverNow) === 'frozen' : false

  // The name is what the confirmation puts in front of the person, since a wallet id names nothing
  // and the key is 66 characters nobody checks by eye.
  const nameOf = useCallback(
    async (walletId: string): Promise<string> => {
      const registry = await loadRegistry()
      const wallet = registry.wallets.find(w => w.id === walletId)
      const fingerprint = wallet?.fingerprint ?? ''
      const meta = fingerprint ? await loadWalletMeta(fingerprint) : null
      return resolveWalletDisplay(fingerprint, meta, t('drawer.walletName')).name
    },
    [t],
  )

  async function handOver(targetWalletId: string): Promise<void> {
    if (!owner || !activeId) {
      return
    }
    const fromWalletId = activeId
    setMoveError(null)
    // Non-null before the walk starts rather than on its first step, so the row cannot be pressed
    // twice while the first reconnect is still running.
    setBusy(t('domain.moveStepReading'))
    // Survives the handover so the read below has something to fall back on.
    let carried: DomainState | undefined
    try {
      const moved = await moveDomain(
        {
          // The shared build domain, never the customer's own hostname, because a frozen domain is
          // off the edge and the owner would be locked out of handing over the thing that stopped
          // working.
          gatewayUrl: `https://${getBreezLnurlDomain()}`,
          identity: sparkGetIdentityPubkey,
          // The connecting switch at every leg. The one that only repoints the registry leaves the
          // SDK on the previous wallet, which then signs both halves of the handover.
          switchTo: switchWalletAndConnect,
          sign: sparkSignMessage,
          adopt: async (walletId, host) => {
            await setDomainFor(walletId, host)
            // The SDK takes its lnurl domain once, at connect, so the new owner serves addresses on
            // the domain only after the session is rebuilt.
            await reconnectActiveWallet()
          },
          onStep: step => setBusy(t(STEP_LABELS[step])),
        },
        {
          host: owner.host,
          fromWalletId,
          toWalletId: targetWalletId,
          // Read with the state on this screen's focus. The gateway refuses a stale one, which means
          // the domain moved while the screen was open, and the read below tells the owner so.
          transferSeq: owner.transferSeq,
          frozen,
        },
      )
      // A frozen domain is handed over without pointing the new owner at it, so nothing on the
      // device records that this wallet owns anything and the next read answers nothing. The rows
      // would disappear at the moment they matter most: the renewal is what brings the hostname
      // back and writes the preference, and it can only be reached from the row above. Retyping the
      // domain does not substitute for it, since the gateway refuses to claim a lapsed year.
      //
      // The sequence has to travel with it. The handover bumps it at the gateway, and a second
      // handover signed over the old number is refused as stale.
      if (frozen) {
        carried = { ...owner, transferSeq: moved ?? owner.transferSeq + 1 }
      }
      // The wallet receiving the domain may have asked what it owned minutes ago and been told
      // nothing, and that throttled answer is now wrong on this device's own evidence. Dropping it
      // is what lets the next focus find the domain rather than the rows staying gone until the
      // window turns over.
      await forgetDomainAsk(targetWalletId)
    } catch (err) {
      // Moving is not creating, and the reason has to reach somewhere: swallowing it leaves a failed
      // handover with nothing to go on.
      const reason = (err as Error)?.message
      console.warn('domain move refused:', reason ?? err)
      const refusal = MOVE_REFUSALS.get(reason) ?? 'domain.moveFailed'
      if (alive.current) {
        setMoveError(t(refusal))
      } else {
        refusalOffScreen = refusal
      }
    } finally {
      // The domain named was read for the wallet the walk started on. A walk that ended on another
      // wallet drops it before reading again, since a failed read keeps whatever is named and would
      // go on naming the previous wallet's domain.
      const endedOn = await getActiveWalletId().catch(() => null)
      if (alive.current) {
        setBusy(null)
        if (endedOn !== fromWalletId) {
          setCurrent(null)
        }
        // Read again whatever happened. On success the active wallet is the one that now owns the
        // domain; on a refusal it may already belong to somebody else, and only the gateway can say.
        read(carried)
      }
    }
  }

  // The target is picked from a list and never typed, so a key entered wrong cannot lose a domain
  // for good. The confirmation is the tap that defends itself: this cannot be undone from here.
  async function askHandOver(targetWalletId: string): Promise<void> {
    if (!owner) {
      setPickerOpen(false)
      return
    }
    const name = await nameOf(targetWalletId).catch(() => t('drawer.walletName'))
    setAsking({
      title: t('domain.moveTitle', { domain: owner.host, name }),
      body: t('domain.moveBody'),
      confirm: t('domain.moveConfirm'),
      cancel: t('domain.cancel'),
      danger: true,
      // handOver reports its own failures, so nothing is left for a caller to catch.
      onConfirm: () => handOver(targetWalletId),
    })
  }

  // Either answer ends the picker, the question being the last thing it asks.
  function closePicker(): void {
    setPickerOpen(false)
    setAsking(null)
  }

  return (
    <Screen scroll layout="padded" contentStyle={styles.content}>
      <Txt role="caption" tone="muted">
        {t('domain.hubHint')}
      </Txt>

      {current && (
        <Txt role="bodyStrong" tone="default">
          {t('domain.current', { domain: current })}
        </Txt>
      )}

      <ErrorBox message={moveError} />

      {/* One group of rows, so each divider meets the row under it. The container's gap is for the
          blocks around the group, never between its rows. */}
      <View>
        {/* Deliberately no skeleton over the owner rows. A skeleton is shaped like the ready state so
            the layout does not jump, and here the ready state for almost every wallet is nothing at
            all. A placeholder would promise rows that are never coming and then collapse. Most wallets
            are on the shared domain, where readDomainState answers without leaving the device, so the
            gap it would fill does not exist for them either. */}
        {owner && (
          <>
            {/* First of the two, because it is the one with a deadline. The row is the press that
                asks for a price, and nothing is quoted before it. An invoice minted for somebody who
                only opened this screen is an invoice nobody asked for. */}
            <MenuRow
              bleed
              icon="refresh"
              label={t('domain.renew')}
              onPress={() => navigation.navigate('UseMyDomain', { renew: owner.host })}
            />
            <MenuRow
              bleed
              icon="key"
              label={t('domain.allowed')}
              value={owner.host}
              onPress={() => navigation.navigate('DomainWallets', { domain: owner.host })}
            />
            {/* Last of the owner rows, since it is the only one that cannot be undone from this
                device. */}
            <MenuRow
              bleed
              icon="move"
              label={busy ?? t('domain.move')}
              onPress={() => {
                if (!busy) {
                  setAsking(null)
                  setPickerOpen(true)
                }
              }}
            />
          </>
        )}
        <MenuRow
          bleed
          icon="server"
          label={t('useDomain.entry')}
          onPress={() => navigation.navigate('UseMyDomain')}
        />
        <MenuRow
          bleed
          divider={false}
          icon="globe"
          label={t('domain.request')}
          onPress={() => navigation.navigate('DomainAccessRequest')}
        />
      </View>

      <WithdrawalSection kind="tier" readKey={purchasesRead} />

      <WalletPickerSheet
        visible={pickerOpen}
        title={t('domain.movePick')}
        excludeWalletId={activeId ?? undefined}
        asking={asking}
        onClose={closePicker}
        onPick={walletId => askHandOver(walletId)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: { gap: rhythm.hintToContent },
})
