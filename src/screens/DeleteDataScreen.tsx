import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Linking, Platform, StyleSheet, View } from 'react-native'
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useTranslation } from 'react-i18next'
import {
  activeDeletionView,
  liveDeletionDeps,
  previewOrAdopt,
  requestDeletion,
  settleDeletion,
  type DeletionPreview,
  type DeletionView,
  type OwedCharge,
  type OwedState,
  type PreviewResult,
} from '../wallet/deletion'
import { formatDate } from '../wallet/history'
import { formatSats } from '../wallet/amount'
import { deviceDateTimePrefs } from '../wallet/deviceLocale'
import { helpMailUrl } from '../wallet/recover'
import { lastLnAddress } from '../wallet/lnAddressMemory'
import { passkeyRemovalNote } from '../wallet/passkey'
import { REMOVAL_ERRORS, removeListedWallet } from '../wallet/walletRemoval'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { Screen } from '../components/Screen'
import { Card } from '../components/Card'
import { ErrorBox } from '../components/ErrorBox'
import { SectionLabel } from '../components/SectionLabel'
import { SupportMailCard, useSupportMail } from '../components/SupportMail'
import { Txt } from '../components/Txt'
import { Skeleton } from '../components/Skeleton'
import { MenuRow } from '../components/MenuRow'
import { ConfirmSheet, type ConfirmRequest } from '../components/ConfirmSheet'
import { GradientButton } from '../components/GradientButton'
import { font, rhythm, space } from '../theme'

// The store's own refund page: Apple's, as the App Review guideline names it, and Google Play's.
const REFUND_URL = Platform.OS === 'ios' ? 'https://support.apple.com/118223' : 'https://support.google.com/googleplay/answer/2479637'

// Literal keys, so the locale test sees every one the screen can ask for. A code this build does not
// know is said generically rather than hidden, since it still keeps the button off.
export const BLOCKER_KEYS: Readonly<Record<string, string>> = {
  sats_charge_open: 'deleteData.blockerCharge',
  store_order_open: 'deleteData.blockerStoreOrder',
  credit_unresolved: 'deleteData.blockerCredit',
  epoch_closing: 'deleteData.blockerClosing',
  domain_payment_in_progress: 'deleteData.blockerDomainPayment',
}

// One line per thing the gateway's deletion map keeps, by the map's `what`. The list itself comes
// from the gateway, so nothing kept is left unsaid; a code this build does not know gets a line that
// says something more stays, never silence.
export const STAY_KEYS: Readonly<Record<string, string>> = {
  purchases: 'deleteData.staysPurchases',
  mark: 'deleteData.staysMark',
  name_hold: 'deleteData.nameAfter',
  request_record: 'deleteData.staysRequest',
}

// The passkey's line here, keyed by the note the remove wallet screens read. Their sentence speaks of
// removing the wallet, which this screen does not do, so it says where the passkey stays instead.
export const PASSKEY_KEYS: Readonly<Record<'passkey.deleteIos' | 'passkey.deleteAndroid', string>> = {
  'passkey.deleteIos': 'deleteData.passkeyIos',
  'passkey.deleteAndroid': 'deleteData.passkeyAndroid',
}

// One sentence per state of a charge Voltz may owe, literal for the locale test. Only `refused` and
// `not_granted` say the charge was paid; `unchecked` says Voltz has not confirmed it either way.
export const OWED_KEYS: Readonly<Record<OwedState, string>> = {
  refused: 'deleteData.owedRefused',
  not_granted: 'deleteData.owedNotGranted',
  unchecked: 'deleteData.owedUnchecked',
}

// A name reads as the address it was for; a domain year as its host.
function owedSubject(charge: OwedCharge): string {
  return charge.kind === 'name' ? `${charge.subject}@${charge.domain}` : charge.subject
}

// Every sats reference support needs to find the payment, the owed charges' included.
function satsReferences(preview: DeletionPreview): string[] {
  const purchases = preview.purchases.filter(p => p.paidWith === 'sats').map(p => p.reference)
  return [...new Set([...purchases, ...preview.owed.map(c => c.reference)])]
}

// A card of text lines, which is what lands on every branch of this screen.
function TextCardSkeleton(): React.JSX.Element {
  return (
    <Card gap="sm">
      <Skeleton width="60%" height={font.leading.base} />
      <Skeleton width="100%" height={font.leading.base} />
      <Skeleton width="100%" height={font.leading.base} />
    </Card>
  )
}

type Outcome = { kind: 'failed' } | { kind: 'blocked'; blockers: string[] } | null

// The answers that say Voltz holds the request, the only ones after which the remove flow takes the
// wallet off the device.
const HELD: ReadonlySet<DeletionView['kind']> = new Set(['pending', 'done'])

// The wallet's own address when the gateway lists it, so the line names the address the person
// knows; otherwise the first name listed.
function addressThatGoes(preview: DeletionPreview, current: string | null): string | null {
  const names = preview.names.map(entry => `${entry.name}@${entry.domain}`)
  const own = current ? names.find(name => name.toLowerCase() === current.toLowerCase()) : undefined
  return own ?? names[0] ?? null
}

/**
 * Deleting this wallet's data at Voltz. The bitcoin and the history stay on Spark, and the seed on
 * this device unless the remove flow takes the wallet off it, so the lines that say what stays
 * follow `thenRemove`.
 *
 * Says deleted only on the gateway's `done`, after the device dropped its own copies, and in
 * progress for a recorded request and for one sent with no answer (deletion.ts).
 *
 * Opened from the remove flow, `thenRemove` names the wallet to remove as well. It goes only once the
 * gateway answered pending or done for it, a 202 to the request or a focus read that settles there,
 * while the screen has focus and only when the wallet the deletion signed for is the one named.
 * Removing it any earlier would drop its deletion mark, the one record that follows a request with no
 * answer yet.
 */
export function DeleteDataScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const thenRemove = useRoute<RouteProp<RootStackParamList, 'DeleteData'>>().params?.thenRemove ?? null
  const [removing, setRemoving] = useState(false)
  const removingNow = useRef(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const prefs = useMemo(() => deviceDateTimePrefs(), [])
  const mail = useSupportMail()
  // Keyed by the references the mail carried, since every focus reads the preview again and a card
  // about one set of charges never sits beside another.
  const mailSupport = (p: DeletionPreview) => {
    const body = satsReferences(p).join(', ')
    mail.open(helpMailUrl(t('deleteData.title'), body), body, body)
  }
  const [view, setView] = useState<DeletionView | null>(null)
  // The wallet's passkey stays in the person's account, which nothing here can reach.
  const [passkeyNote, setPasskeyNote] = useState<keyof typeof PASSKEY_KEYS | null>(null)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState<ConfirmRequest | null>(null)
  // The address this device last noted for the wallet, read with the preview.
  const [current, setCurrent] = useState<string | null>(null)
  // Whether this wallet is known to hold no mark. "Nothing was deleted" is said only then: a wallet
  // that gave its address up, or whose mark could not be read, has had something taken away.
  const [emptyMark, setEmptyMark] = useState(false)
  // A press whose answer lands after the screen lost focus is not shown: the next focus reads the
  // status, which is the answer that counts.
  const focused = useRef(false)

  // Kept current for the focus effect, which is created once.
  const removeOnHeld = useRef<(view: DeletionView, signedFor: string) => void>(() => undefined)
  removeOnHeld.current = (held, signedFor) => {
    if (!thenRemove || !HELD.has(held.kind) || signedFor !== thenRemove || !focused.current) {
      return
    }
    // One removal at a time; a focus or an answer landing while one runs adds nothing.
    if (removingNow.current) {
      return
    }
    removingNow.current = true
    setRemoving(true)
    setRemoveError(null)
    removeListedWallet(thenRemove)
      .catch(() => 'failed' as const)
      .then(ended => {
        // Busy until the screen leaves, so the request's card does not come back for a frame.
        if (ended === 'gone') {
          navigation.navigate('Main')
          return
        }
        removingNow.current = false
        setRemoving(false)
        setRemoveError(t(REMOVAL_ERRORS[ended]))
      })
  }

  useFocusEffect(
    useCallback(() => {
      focused.current = true
      // A press answered while the screen was away left the button busy, since only a focused screen
      // takes the answer; the read below decides what this focus shows.
      setBusy(false)
      let alive = true
      ;(async () => {
        const deps = await liveDeletionDeps()
        const stays = await passkeyRemovalNote(deps.walletId)
        const settled = await settleDeletion(deps)
        if (!alive) {
          return
        }
        setPasskeyNote(stays)
        setView(settled)
        removeOnHeld.current(settled, deps.walletId)
        setEmptyMark(settled.kind === 'none' || (settled.kind === 'notArrived' && !settled.removed))
        if (settled.kind === 'none' || settled.kind === 'removed' || settled.kind === 'notArrived') {
          setPreview(null)
          // A seed whose deletion was asked from another device holds no mark here, and the preview's
          // status writes it; the screen then shows that request, not a page asking for another.
          const [read, noted] = await Promise.all([
            previewOrAdopt(deps),
            lastLnAddress(deps.walletId).catch(() => null),
          ])
          if (!alive) {
            return
          }
          setCurrent(noted)
          if (read.kind === 'adopted') {
            setView(read.view)
            setEmptyMark(false)
            removeOnHeld.current(read.view, deps.walletId)
          } else {
            setPreview(read)
          }
        }
      })().catch(async () => {
        // No answer could be had, so the mark alone says what to show: in progress or deleted for a
        // wallet that asked, and the page with nothing to press otherwise.
        const marked = await activeDeletionView().catch(() => null)
        if (!alive) {
          return
        }
        setView(marked ?? { kind: 'none' })
        setEmptyMark(marked?.kind === 'none')
        setPreview({ kind: 'failed' })
      })
      return () => {
        alive = false
        focused.current = false
      }
    }, []),
  )

  const date = (secs: number | undefined) => (secs ? formatDate(secs, prefs) : '')
  // "We tell you here" holds only for a wallet that stays: from the remove flow it leaves this
  // device once Voltz holds the request, and nothing here says when the deletion is done.
  const deadline = thenRemove ? t('deleteData.deadlineThenRemove') : t('deleteData.deadline')

  async function send(ownedHosts: string[]): Promise<void> {
    setBusy(true)
    setOutcome(null)
    try {
      const deps = await liveDeletionDeps()
      const result = await requestDeletion(deps, ownedHosts)
      if (!focused.current) {
        return
      }
      switch (result.kind) {
        case 'pending': {
          const held: DeletionView = { kind: 'pending', requestedAt: result.requestedAt, deadline: result.deadline }
          setView(held)
          removeOnHeld.current(held, deps.walletId)
          break
        }
        case 'noAnswer':
          setView({ kind: 'asked' })
          break
        case 'blocked':
          setOutcome({ kind: 'blocked', blockers: result.blockers })
          break
        case 'failed':
          setOutcome({ kind: 'failed' })
          break
      }
    } catch {
      // Nothing is sent when the mark could not be written or no wallet could sign.
      if (focused.current) {
        setOutcome({ kind: 'failed' })
      }
    } finally {
      if (focused.current) {
        setBusy(false)
      }
    }
  }

  function confirm(ownedHosts: string[]): void {
    setAsking({
      title: t('deleteData.confirmTitle'),
      // From the remove flow the wallet goes with the request, so the body cannot say it stays.
      body: thenRemove ? t('deleteData.confirmBodyThenRemove') : t('deleteData.confirmBody'),
      confirm: t('deleteData.confirmGo'),
      cancel: t('common.cancel'),
      danger: true,
      onConfirm: () => {
        send(ownedHosts).catch(() => undefined)
      },
    })
  }

  if (view === null || removing) {
    return (
      <Screen layout="padded" contentStyle={styles.container}>
        <TextCardSkeleton />
      </Screen>
    )
  }

  // This device lost what it recorded for the wallet and Voltz has not answered yet, so nothing is
  // said about a deletion either way and nothing can be asked over it.
  if (view.kind === 'checking') {
    return (
      <Screen scroll layout="padded" contentStyle={styles.container}>
        <Card gap="sm">
          <Txt role="bodyBold" testID="deletion-state">
            {t('deleteData.checking')}
          </Txt>
        </Card>
        <Txt tone="muted">{t('deleteData.wallet')}</Txt>
      </Screen>
    )
  }

  if (view.kind === 'asked' || view.kind === 'pending' || view.kind === 'done') {
    const line =
      view.kind === 'done'
        ? t('deleteData.done', { date: date(view.doneAt) })
        : view.kind === 'pending' && view.requestedAt && view.deadline
          ? t('deleteData.pending', { date: date(view.requestedAt), deadline: date(view.deadline) })
          : thenRemove
            ? t('deleteData.inProgressThenRemove')
            : t('deleteData.inProgress')
    return (
      <Screen scroll layout="padded" contentStyle={styles.container}>
        <ErrorBox message={removeError} />
        <Card gap="sm">
          <Txt role="bodyBold" testID="deletion-state">
            {line}
          </Txt>
          {view.kind !== 'done' && <Txt tone="muted">{deadline}</Txt>}
        </Card>
        <Txt tone="muted">{t('deleteData.wallet')}</Txt>
        {thenRemove && view.kind === 'asked' && (
          <Txt tone="muted" testID="deletion-wallet-stays">
            {t('deleteData.staysUntilConfirmed')}
          </Txt>
        )}
      </Screen>
    )
  }

  const ready = preview?.kind === 'preview' ? preview.preview : null
  const note = ready ? mail.noteFor(satsReferences(ready).join(', ')) : null
  const blockers = outcome?.kind === 'blocked' ? outcome.blockers : (ready?.blockers ?? [])
  const address = ready ? addressThatGoes(ready, current) : null
  const paidInStore = ready?.purchases.some(p => p.paidWith !== 'sats') ?? false
  const paidInSats = ready?.purchases.some(p => p.paidWith === 'sats') ?? false
  const unanswered = (key: 'deleteData.failed' | 'deleteData.offline') => t(emptyMark ? key : 'deleteData.noAnswer')

  return (
    <Screen scroll layout="padded" contentStyle={styles.container}>
      {/* "Nothing was deleted" only for a wallet that had nothing taken away: one that gave its address
          up before asking still has it given up. */}
      {view.kind === 'notArrived' && (
        <ErrorBox message={t(view.removed ? 'deleteData.notArrivedRemoved' : 'deleteData.notArrived')} />
      )}

      {preview === null && <TextCardSkeleton />}
      {preview?.kind === 'offline' && <ErrorBox message={unanswered('deleteData.offline')} />}
      {preview?.kind === 'failed' && <ErrorBox message={unanswered('deleteData.failed')} />}

      {ready && (
        <>
          <View>
            <SectionLabel style={styles.groupLabel}>
              {t('deleteData.groupGoes')}
            </SectionLabel>
            <Card gap="sm">
              <Txt tone="muted" testID="deletion-goes">
                {address ? t('deleteData.whatGoes', { address }) : t('deleteData.whatGoesNoAddress')}
              </Txt>
              <Txt tone="muted">{t('deleteData.paid')}</Txt>
              {ready.purchases.map(p => (
                <Txt key={p.reference} role="caption" tone="muted">
                  {t('deleteData.purchase', { subject: p.subject, reference: p.reference, date: date(p.at) })}
                </Txt>
              ))}
              {/* The count is of other wallets on the domain, so a domain only this wallet uses has none to lose. */}
              {ready.ownDomains.map(d => (
                <Txt key={d.host} tone="muted">
                  {d.guests > 0
                    ? t('deleteData.domain', { domain: d.host, count: d.guests })
                    : t('deleteData.domainAlone', { domain: d.host })}
                </Txt>
              ))}
            </Card>
          </View>

          {(paidInStore || (paidInSats && ready.owed.length === 0)) && (
            <View>
              {paidInStore && (
                <MenuRow
                  bleed
                  // A line only with the support row under it.
                  divider={paidInSats && ready.owed.length === 0}
                  icon="globe"
                  label={t('deleteData.refundStore')}
                  onPress={() => Linking.openURL(REFUND_URL)}
                />
              )}
              {/* With charges owed the row moves into their card, so it shows once. */}
              {paidInSats && ready.owed.length === 0 && (
                <MenuRow
                  bleed
                  divider={false}
                  icon="help"
                  label={t('deleteData.refundSupport')}
                  onPress={() => mailSupport(ready)}
                />
              )}
            </View>
          )}
          {ready.owed.length === 0 && note && <SupportMailCard note={note} />}

          {ready.owed.length > 0 && (
            <Card gap="sm">
              <Txt role="bodyBold">{t('deleteData.owedTitle')}</Txt>
              {ready.owed.map(charge => (
                <View key={charge.reference} style={styles.section} testID={`owed-${charge.reference}`}>
                  <Txt>
                    {t(OWED_KEYS[charge.state], {
                      subject: owedSubject(charge),
                      sats: formatSats(charge.sats),
                      date: date(charge.at),
                    })}
                  </Txt>
                  <Txt role="caption" tone="muted">
                    {t('deleteData.owedReference')}
                  </Txt>
                  {/* Selectable on its own, so a long press copies the reference and nothing else. */}
                  <Txt role="caption" selectable testID={`owed-reference-${charge.reference}`}>
                    {charge.reference}
                  </Txt>
                </View>
              ))}
              {/* Each charge's words send the person to support, so the way there is in the card. */}
              <MenuRow
                divider={false}
                icon="help"
                label={t('deleteData.refundSupport')}
                onPress={() => mailSupport(ready)}
              />
              {note && <SupportMailCard raised note={note} />}
            </Card>
          )}

          <View>
            <SectionLabel style={styles.groupLabel}>
              {t('deleteData.groupStays')}
            </SectionLabel>
            <Card gap="sm">
              <Txt tone="muted" testID="stays-wallet">
                {thenRemove ? t('deleteData.walletThenRemove') : t('deleteData.wallet')}
              </Txt>
              <Txt tone="muted">{t('deleteData.contacts')}</Txt>
              {/* Keys stay unique, since two codes this build does not know share one line. */}
              {[...new Set(ready.stays.map(code => STAY_KEYS[code] ?? 'deleteData.staysOther'))].map(key => (
                <Txt key={key} tone="muted" testID={`stays-${key}`}>
                  {t(key)}
                </Txt>
              ))}
              {passkeyNote && (
                <Txt tone="muted" testID="stays-passkey">
                  {t(PASSKEY_KEYS[passkeyNote])}
                </Txt>
              )}
            </Card>
          </View>

          <View>
            <SectionLabel style={styles.groupLabel}>
              {t('deleteData.groupWhen')}
            </SectionLabel>
            <Card>
              <Txt tone="muted">{deadline}</Txt>
            </Card>
          </View>
        </>
      )}

      {blockers.length > 0 && (
        <Card gap="sm">
          <Txt role="bodyBold">{t('deleteData.blockedTitle')}</Txt>
          {blockers.map(code => (
            <Txt key={code} tone="muted">
              {t(BLOCKER_KEYS[code] ?? 'deleteData.blockerOther')}
            </Txt>
          ))}
        </Card>
      )}
      {outcome?.kind === 'failed' && <ErrorBox message={unanswered('deleteData.failed')} />}

      <GradientButton
        label={t('deleteData.button')}
        variant="danger"
        disabled={!ready || blockers.length > 0}
        loading={busy}
        onPress={() => confirm(ready?.ownDomains.map(d => d.host) ?? [])}
      />
      <ConfirmSheet request={asking} onClose={() => setAsking(null)} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  container: {
    gap: space.xl,
  },
  section: {
    gap: space.sm,
  },
  groupLabel: {
    marginBottom: rhythm.sectionLabelToList,
  },
})
