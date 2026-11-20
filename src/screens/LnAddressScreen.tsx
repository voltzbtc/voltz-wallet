import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, AppState, StyleSheet, View } from 'react-native'
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import { useTranslation } from 'react-i18next'
import QRCode from 'react-native-qrcode-svg'
import Clipboard from '@react-native-clipboard/clipboard'
import {
  sparkAuthorizeLnAddressTransfer,
  sparkClaimLnAddressTransfer,
  sparkDeleteLnAddress,
  sparkEnsureLnAddress,
  sparkGetIdentityPubkey,
  sparkGetLnAddress,
  type SparkLnAddress,
} from '../wallet/spark'
import { identitySigner } from '../wallet/identitySigner'
import {
  activeDeletionView,
  ensureLnAddressOrAdopt,
  returnActiveWallet,
  type DeletionView,
} from '../wallet/deletion'
import { transferLnAddress } from '../wallet/lnTransfer'
import { gatewayRefusal, moveRefusalKey } from '../wallet/lnRefusal'
import { ReceiveHeldByExit } from '../wallet/errors'
import { phaseOf, readDomainState, type DomainState } from '../wallet/domainTier'
import { reconnectActiveWallet, switchWalletAndConnect } from '../wallet/wallet'
import { clearDomainFor, setDomainFor, storedDomainFor } from '../wallet/lnurlDomainPref'
import { getBreezLnurlDomain } from '../config'
import { getActiveWalletId } from '../wallet/walletRegistry'
import { WalletPickerSheet } from '../components/WalletPickerSheet'
import { DomainNoticeCard } from '../components/DomainNoticeCard'
import { LnAddressSheet } from '../components/LnAddressSheet'
import { WithdrawalSection } from '../components/WithdrawalSection'
import { ChunkedAddress } from '../components/ChunkedAddress'
import { MenuRow } from '../components/MenuRow'
import { TabIcon } from '../components/TabIcon'
import { Skeleton } from '../components/Skeleton'
import { GradientButton, Spinner } from '../components/GradientButton'
import { useAccent } from '../wallet/dollarMode'
import { deviceDateTimePrefs } from '../wallet/deviceLocale'
import { colors, font, motion, qrFrame, radius, rhythm, space } from '../theme'
import { Screen } from '../components/Screen'
import { Card } from '../components/Card'
import { ConfirmSheet, type ConfirmRequest } from '../components/ConfirmSheet'
import { ErrorBox } from '../components/ErrorBox'
import { Txt } from '../components/Txt'
import { Touch } from '../components/Touch'
import { receiveStyles, RECEIVE_QR_SIZE as QR_SIZE } from '../components/receiveStyles'
import { joinSentences } from '../i18n/join'
import type { RootStackParamList } from '../navigation/RootNavigator'

// The SDK assigns no address on its own, so sparkEnsureLnAddress claims a random handle on first load.
export function LnAddressScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation<{ navigate: (screen: string, params?: object) => void }>()
  const { accent } = useAccent()
  const [lnAddr, setLnAddr] = useState<SparkLnAddress | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [addressUnread, setAddressUnread] = useState(false)
  const [copied, setCopied] = useState(false)
  // Sent here to choose a name, as from the recovery card's Choose a name, the screen opens on the
  // sheet that picks one, which saves the press on Change.
  const choose = useRoute<RouteProp<RootStackParamList, 'LnAddress'>>().params?.choose === true
  const [sheetOpen, setSheetOpen] = useState(choose)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [moving, setMoving] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [status, setStatus] = useState<DomainState | null>(null)
  // The deletion mark as this device holds it. Read on focus, and a held wallet shows the way back
  // instead of an address, since nothing makes one for it on its own (deletionMark.ts).
  const [held, setHeld] = useState<DeletionView | null>(null)
  const [returning, setReturning] = useState(false)
  const [asking, setAsking] = useState<ConfirmRequest | null>(null)
  // What the last action could not do, in place of a dialog, until the next one starts.
  const [failure, setFailure] = useState<string | null>(null)
  // The wallet's exit holds its receives, so no address is handed out and the screen says why.
  const [exitHold, setExitHold] = useState<'exit' | 'unread' | null>(null)
  // Moves on every focus and after a move to another wallet, and the name purchases are read again.
  const [purchasesRead, setPurchasesRead] = useState(0)
  const prefs = useMemo(() => deviceDateTimePrefs(), [])
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hintOpacity = useRef(new Animated.Value(1)).current

  useEffect(() => {
    getActiveWalletId()
      .then(setActiveId)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let alive = true
    ensureLnAddressOrAdopt()
      // Ensure can take seconds when it asks the gateway, and a name registered from the sheet
      // meanwhile is the address. An empty or failed answer that lands after it never clears it.
      .then(addr => alive && setLnAddr(current => addr ?? current))
      .catch((cause: unknown) => {
        if (!alive) {
          return
        }
        if (cause instanceof ReceiveHeldByExit) {
          setExitHold(cause.hold)
          return
        }
        setAddressUnread(true)
      })
      // Read again once the ensure is over: a gateway that refused the key as deleted has had its
      // status written as the mark by then, and the screen shows that instead of an empty address.
      .then(() => activeDeletionView())
      .then(view => alive && setHeld(view))
      .catch(() => undefined)
      .finally(() => alive && setLoaded(true))
    return () => {
      alive = false
      if (copyTimer.current) {
        clearTimeout(copyTimer.current)
      }
    }
  }, [])

  // Crossfades the copy hint, matching the Receive card.
  useEffect(() => {
    hintOpacity.setValue(0.3)
    Animated.timing(hintOpacity, {
      toValue: 1,
      duration: motion.fast,
      useNativeDriver: true,
    }).start()
  }, [copied, hintOpacity])

  // Asked on every focus, not once per mount, because the tap that lands here is usually a
  // notification about this exact fact, and a year can run out while the screen sits in the stack.
  // The read costs nothing for a wallet on the shared domain, which is almost every wallet, because
  // readDomainState answers those without leaving the device.
  const readState = useCallback(async (): Promise<DomainState | null> => {
    const walletId = await getActiveWalletId()
    if (!walletId) {
      return null
    }
    return readDomainState({ walletId, ...(await identitySigner()) })
  }, [])

  // Focus alone leaves this screen stale in the one case it must not: a domain comes back while the
  // owner is looking at the notice saying it is off. Nothing here changes by their action, so
  // nothing re-fires, and navigating to the screen already open is a no-op. Returning to the
  // foreground is when somebody is looking, and it is also when the notification about this lands.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        readState()
          .then(setStatus)
          .catch(() => undefined)
      }
    })
    return () => sub.remove()
  }, [readState])

  useFocusEffect(
    useCallback(() => {
      let alive = true
      setPurchasesRead(n => n + 1)
      activeDeletionView()
        .then(view => alive && setHeld(view))
        .catch(() => undefined)
      ;(async () => {
        const walletId = await getActiveWalletId()
        if (!walletId) {
          return null
        }
        return readDomainState({ walletId, ...(await identitySigner()) })
      })()
        .then(state => alive && setStatus(state))
        // The address is what this screen is for. A lifecycle notice that cannot be read leaves the
        // screen showing the address with no notice at all.
        .catch(() => alive && setStatus(null))
      return () => {
        alive = false
      }
    }, []),
  )

  // The gateway's clock decides the phase, never the device's, so a phone running fast cannot
  // alarm an owner who is paid up.
  const phase = status ? phaseOf(status, status.serverNow) : 'fine'
  // The hostname has been taken off the edge, so nothing addressed at it resolves for anyone.
  const frozen = phase === 'frozen'

  // Points the wallet back at the build's domain, where a name costs what it costs and receiving
  // works right away. Confirmed first, because the address on the frozen domain stops being served
  // the moment this happens, and somebody who is about to renew should not lose it by tapping here.
  const moveToShared = async (): Promise<void> => {
    const id = (await getActiveWalletId()) ?? 'primary'
    const own = await storedDomainFor(id)
    await clearDomainFor(id)
    // The SDK reads its domain once, at connect, so the addresses follow only after the session is
    // rebuilt. A rebuild that fails puts the domain back, so the wallet is where it was and the line
    // that it could not go back is true; otherwise the next connect would move it unannounced.
    try {
      await reconnectActiveWallet()
    } catch (err) {
      // A connect a newer request cut loose is no failure of the move: the choice is already the
      // shared domain, and the connect that cut it, or the next one, reads it. Putting the own domain
      // back would move the wallet off the shared one unannounced, a second tap's move included.
      // Matched by name, as HomeScreen does.
      if ((err as Error | null)?.name !== 'SparkConnectSuperseded') {
        if (own !== undefined) {
          await setDomainFor(id, own).catch(() => undefined)
        }
        throw err
      }
    }
    // Cleared after, so the notice goes with the domain it was about.
    setStatus(null)
  }

  const useShared = (): void => {
    const shared = getBreezLnurlDomain()
    if (!shared) {
      return
    }
    setFailure(null)
    setAsking({
      title: t('domain.useSharedTitle'),
      body: t('domain.useSharedBody', { domain: shared }),
      confirm: t('domain.useSharedGo'),
      cancel: t('common.cancel'),
      onConfirm: () => {
        moveToShared().catch(() => setFailure(t('domain.useSharedFailed', { domain: shared })))
      },
    })
  }

  function copy() {
    if (!lnAddr) {
      return
    }
    Clipboard.setString(lnAddr.address)
    setCopied(true)
    // The hint under the address changes only on screen, and a screen reader hears nothing of it.
    AccessibilityInfo.announceForAccessibility(t('receive.copied'))
    if (copyTimer.current) {
      clearTimeout(copyTimer.current)
    }
    copyTimer.current = setTimeout(() => setCopied(false), 2000)
  }

  // Both legs reconnect the SDK, so the row shows a spinner while they run instead of freezing.
  async function moveTo(targetWalletId: string) {
    setPickerOpen(false)
    if (!activeId) {
      return
    }
    setFailure(null)
    setMoving(true)
    try {
      const moved = await transferLnAddress(
        {
          identity: sparkGetIdentityPubkey,
          switchTo: switchWalletAndConnect,
          authorize: sparkAuthorizeLnAddressTransfer,
          claim: sparkClaimLnAddressTransfer,
        },
        activeId,
        targetWalletId,
      )
      // The address now belongs to the target wallet, which is the one still connected.
      setActiveId(targetWalletId)
      setLnAddr(moved)
      setPurchasesRead(n => n + 1)
    } catch (err) {
      // Moving is not creating, and the reason has to reach somewhere: swallowing it leaves a failed
      // move with nothing to go on, on a screen that then blames address creation.
      // An SDK error's message is only its class name, and the server's answer rides in `inner`.
      console.warn(
        'lightning address move refused:',
        (err as Error)?.message ?? err,
        (err as { inner?: unknown })?.inner ?? '',
      )
      // Only a reason the app has words for gets a second line. Anything else is somebody else's
      // wording, so the title stands alone and the raw text stays in the log.
      const key = moveRefusalKey(gatewayRefusal(err))
      setFailure(
        joinSentences(t, [
          t('receive.lnMoveFailed'),
          key ? t(key, { domain: lnAddr?.address.split('@')[1] }) : null,
        ]),
      )
    } finally {
      setMoving(false)
    }
  }

  function askRemove() {
    setFailure(null)
    setAsking({
      title: t('receive.lnRemove'),
      body: t('receive.lnRemoveWarning'),
      confirm: t('receive.lnRemoveConfirm'),
      cancel: t('editWallet.cancel'),
      danger: true,
      onConfirm: async () => {
        try {
          await sparkDeleteLnAddress()
          setLnAddr(null)
          setHeld({ kind: 'removed' })
        } catch {
          setFailure(t('receive.lnRemoveFailed'))
        }
      },
    })
  }

  // "Create the address again": the gateway stops refusing the key first, when it was asked to
  // delete, and only then is an address made, through the same ensure as any first open.
  async function recreate(): Promise<void> {
    setFailure(null)
    setReturning(true)
    try {
      const result = await returnActiveWallet()
      if (result.kind !== 'returned') {
        setFailure(t('receive.lnRecreateFailed'))
        return
      }
      setHeld({ kind: 'none' })
      const addr = await sparkEnsureLnAddress()
      setLnAddr(current => addr ?? current)
    } catch {
      setFailure(t('receive.lnRecreateFailed'))
    } finally {
      setReturning(false)
    }
  }

  // Any mark holds the address. Removed and done offer the way back; a request still running offers
  // nothing, since the gateway is in the middle of deleting what a new address would land on, and a
  // mark this device lost offers nothing until a status read says what it was.
  const holding = held !== null && held.kind !== 'none' && held.kind !== 'notArrived'
  const canRecreate = held?.kind === 'removed' || held?.kind === 'done'

  return (
    <Screen scroll layout="padded" contentStyle={styles.container}>
      <View style={styles.top}>
        <Txt role="caption" tone="muted">
          {t('receive.lnManageHint')}
        </Txt>
        <ErrorBox message={failure} />
        {exitHold !== null && (
          <ErrorBox
            message={t(exitHold === 'exit' ? 'emergencyExit.receiveHeld' : 'emergencyExit.receiveHeldUnread')}
          />
        )}

        {/* Deliberately no skeleton in this slot. A skeleton promises news, and for almost every
            wallet the news is that the slot collapses to nothing, so a shimmer that resolves to
            emptiness on every open would announce something that is never coming. Nothing is drawn
            here until there is something to say. */}
        {status &&
          phase !== 'fine' &&
          (status.role === 'owner' ? (
            <DomainNoticeCard
              phase={phase}
              domain={status.host}
              expiresAt={status.expiresAt}
              frozenAt={status.frozenAt}
              prefs={prefs}
              onRenew={() => navigation.navigate('UseMyDomain', { renew: status.host })}
              sharedDomain={getBreezLnurlDomain()}
              onUseShared={useShared}
            />
          ) : (
            // A handover leaves the outgoing wallet authorised, so its address keeps working on a
            // domain it no longer owns. Only the owning wallet can renew, and one line saying which
            // domain this is about beats a button that would be refused.
            <Txt role="caption" tone="muted">
              {t('domain.onAnotherWallet', { domain: status.host })}
            </Txt>
          ))}

        {!loaded && !frozen && (
          // The ready card's shape, the framed code and the address with its hint under it, so the card
          // does not grow when the address arrives.
          <Card centered style={receiveStyles.card}>
            <Skeleton width={QR_SIZE + space.md * 2} height={QR_SIZE + space.md * 2} borderRadius={radius.md} />
            <View style={receiveStyles.addressBlock}>
              <Skeleton width={QR_SIZE} height={font.leading.sm} />
              <Skeleton width={QR_SIZE * 0.55} height={font.leading.xs} />
            </View>
          </Card>
        )}

        {loaded && holding && (
          <>
            <Txt role="caption" tone="muted" testID="ln-held">
              {canRecreate
                ? t('receive.lnOff')
                : held?.kind === 'checking'
                  ? t('receive.lnHeldChecking')
                  : t('receive.lnDeleting')}
            </Txt>
            {canRecreate && (
              <MenuRow
                bleed
                divider={false}
                icon="edit"
                label={t('receive.lnRecreate')}
                right={returning ? <Spinner head={accent} track={colors.surfaceRaised} /> : undefined}
                onPress={() => {
                  if (!returning) {
                    recreate().catch(() => undefined)
                  }
                }}
              />
            )}
          </>
        )}

        {/* Withheld while the domain is frozen. The code and the address are the same dead end
            for the payer, and a shop holding either one out to a customer produces an error in
            the customer's wallet, which is worse than the notice above and no card at all. */}
        {loaded && !holding && lnAddr && !frozen && (
          <Card centered style={receiveStyles.card}>
            <View style={styles.qrWrap}>
              <QRCode value={lnAddr.lnurl} size={QR_SIZE} />
            </View>
            <Touch onPress={copy} feedback="link" label={t('receive.copy')} style={receiveStyles.addressBlock}>
              <ChunkedAddress value={lnAddr.address} chunked={false} />
              <Animated.View style={[receiveStyles.copyHint, { opacity: hintOpacity }]}>
                <TabIcon
                  name={copied ? 'check' : 'copy'}
                  color={copied ? accent : colors.textSecondary}
                  size={14}
                />
                <Txt role="micro" tone={copied ? 'accent' : 'muted'}>
                  {copied ? t('receive.copied') : t('receive.tapToCopy')}
                </Txt>
              </Animated.View>
            </Touch>
          </Card>
        )}
      </View>

      {/* Offered even with no address, so the rare missing case is not a blank dead-end. */}
      {loaded && !holding && (
        <>
          {/* One group of rows, so each divider meets the row under it. The container's gap is for
              the blocks around the group, never between its rows. */}
          <View style={styles.rows}>
            <MenuRow
              bleed
              icon="edit"
              label={t('receive.lnChange')}
              onPress={() => setSheetOpen(true)}
            />
            {lnAddr && (
              <>
                <MenuRow
                  bleed
                  icon="move"
                  label={t('receive.lnTransfer')}
                  right={moving ? <Spinner head={accent} track={colors.surfaceRaised} /> : undefined}
                  onPress={() => !moving && setPickerOpen(true)}
                />
              </>
            )}

            {/* One row for everything about domains, so actions on the address stay separate from
                actions on the domain. */}
            <MenuRow
              bleed
              divider={false}
              icon="globe"
              label={t('domain.hub')}
              onPress={() => navigation.navigate('Domain')}
            />
          </View>

          {lnAddr && (
            <GradientButton label={t('receive.lnRemove')} variant="danger" onPress={askRemove} />
          )}

          <WithdrawalSection kind="name" readKey={purchasesRead} />
        </>
      )}

      <ConfirmSheet request={asking} onClose={() => setAsking(null)} />

      <WalletPickerSheet
        visible={pickerOpen}
        title={t('receive.lnTransferPick')}
        excludeWalletId={activeId ?? undefined}
        onClose={() => setPickerOpen(false)}
        onPick={moveTo}
      />

      <LnAddressSheet
        // Held until the address is read, since opened sooner it would not know what a name replaces.
        visible={sheetOpen && loaded}
        domain={lnAddr ? lnAddr.address.split('@')[1] : undefined}
        currentAddress={lnAddr?.address}
        addressUnread={addressUnread}
        // A name on a domain the customer paid for costs nothing, which the gateway decides and the
        // sheet already handles. Passed so the button can say so before it is pressed, rather than
        // offering a price that will never be quoted.
        namesFree={status?.kind === 'customer'}
        // A frozen domain refuses every name, and the refusal reaches the app as the same boolean a
        // taken name produces. Told here so the sheet can name the real reason instead of sending
        // somebody off to invent another name when what they need is to renew.
        domainFrozen={frozen}
        onClose={() => {
          setSheetOpen(false)
          // A store credit can be spent on a name while the address could not be read, and the sheet
          // then closes without one, so the address is read again rather than left as it was.
          sparkGetLnAddress()
            .then(addr => addr && setLnAddr(addr))
            .catch(() => undefined)
        }}
        onRegistered={addr => {
          setSheetOpen(false)
          setLnAddr(addr)
        }}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  container: {
    gap: rhythm.section,
  },
  top: {
    gap: rhythm.hintToContent,
  },
  // A row's own 16 of padding is part of the 32 above it.
  rows: {
    marginTop: -space.lg,
  },
  qrWrap: qrFrame,
})
