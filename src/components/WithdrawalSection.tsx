import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Linking, Share, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { currentDeps, type PurchaseDeps } from '../wallet/namePurchase'
import { onSparkConnected, sparkConnectedWalletId, sparkOwnSparkAddress } from '../wallet/spark'
import { getActiveWalletId } from '../wallet/walletRegistry'
import { requestStoreRefund, storeRefundSheetAvailable, type RefundSheetResult } from '../wallet/store'
import {
  needsAppleSheet,
  purchaseLine,
  receiptNextLine,
  refusalKey,
  requestWithdrawal,
  shownPurchases,
  stateLine,
  walletPurchases,
  type PurchaseKind,
  type WalletPurchase,
  type WithdrawReceipt,
} from '../wallet/withdrawal'
import { formatDate, formatTime } from '../wallet/history'
import { formatSats } from '../wallet/amount'
import { deviceDateTimePrefs } from '../wallet/deviceLocale'
import { space } from '../theme'
import { ErrorBox } from './ErrorBox'
import { CheckBox } from './CheckBox'
import { MenuRow } from './MenuRow'
import { Sheet } from './Sheet'
import { Touch } from './Touch'
import { Txt } from './Txt'
import { GradientButton } from './GradientButton'

// The wallet that read the list, which paid for every purchase on it, with the signer and the
// gateway the list was read through. A confirmation keeps the one it opened with, so a switch while
// it is open never lends it another wallet's key.
type Owner = { walletId: string; deps: PurchaseDeps }
type Read = { owner: Owner; purchases: WalletPurchase[] }

// The list is read only for a wallet that is both the active one and the one connected, so a row
// is never offered for a wallet the screen is not showing. Anything that does not answer reads as no
// list, and no row shows: for almost every wallet the section is empty, so nothing is drawn while
// the read is out or after it failed, as with the address screen's domain notice.
async function readPurchases(): Promise<Read | null> {
  const walletId = sparkConnectedWalletId()
  if (!walletId || (await getActiveWalletId()) !== walletId) {
    return null
  }
  const deps = await currentDeps()
  const purchases = await walletPurchases(deps)
  // A switch while the list was out leaves an answer about the wallet switched from.
  if (purchases === null || sparkConnectedWalletId() !== walletId) {
    return null
  }
  return { owner: { walletId, deps }, purchases }
}

type ItemOf = (purchase: WalletPurchase) => string

// Apple's own page for asking a refund, where a purchase made in the App Store can be asked about from
// any device (the delete data screen links it too).
const APPLE_REFUND_URL = 'https://support.apple.com/118223'

// What stands in for the row, and for the way back to Apple's sheet, where that sheet cannot open.
function AppleElsewhere(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <Txt role="caption" tone="default" testID="withdrawal-apple-elsewhere">
        {t('withdrawal.appleElsewhere')}
      </Txt>
      <MenuRow bleed divider={false} icon="globe" label={t('withdrawal.applePage')} onPress={() => Linking.openURL(APPLE_REFUND_URL)} />
    </>
  )
}

// The withdrawal from a name (on the address screen) or a domain year (on the domain screen): a row
// while the gateway says the purchase can be withdrawn, its state once a withdrawal exists, nothing
// otherwise. `readKey` moves on every focus and after anything on the screen that switches wallets,
// and each change reads the list again, as does the connection reaching another wallet.
export function WithdrawalSection({ kind, readKey }: { kind: PurchaseKind; readKey: number }): React.JSX.Element | null {
  const { t } = useTranslation()
  const prefs = useMemo(() => deviceDateTimePrefs(), [])
  const appleSheet = useMemo(() => storeRefundSheetAvailable(), [])
  const [read, setRead] = useState<Read | null>(null)
  const [own, setOwn] = useState(0)
  const [connects, setConnects] = useState(0)
  const [open, setOpen] = useState<{ owner: Owner; purchase: WalletPurchase } | null>(null)
  // What Apple's sheet answered in this session, by purchase, for the line under a requested one.
  const [sheets, setSheets] = useState<Record<string, RefundSheetResult | 'opening'>>({})
  const reads = useRef(0)
  // The wallet connected when the latest read started.
  const readFor = useRef<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // Only the latest read lands, so an earlier one that answers late never puts back a row a newer
  // read took away.
  useEffect(() => {
    const at = ++reads.current
    readFor.current = sparkConnectedWalletId()
    readPurchases()
      .catch(() => null)
      .then(next => {
        if (alive.current && reads.current === at) {
          setRead(next)
        }
      })
  }, [readKey, own, connects])

  // A focus right after a switch can land before the SDK reconnects, when the connection is still on
  // the wallet switched from and the read shows nothing; so the connection reaching another wallet
  // than the one last read for reads again, and drops at once a list read for any other wallet.
  useEffect(
    () =>
      onSparkConnected(() => {
        const connected = sparkConnectedWalletId()
        setRead(current => (current && current.owner.walletId !== connected ? null : current))
        if (connected !== readFor.current) {
          setConnects(n => n + 1)
        }
      }),
    [],
  )

  const itemOf: ItemOf = purchase =>
    purchase.kind === 'name'
      ? t('withdrawal.itemName', { name: `${purchase.subject}@${purchase.domain}` })
      : t('withdrawal.itemYear', { host: purchase.subject })

  // Apple's sheet answers the same purchase whether the receipt or the section opened it, so the
  // section keeps the last answer either way, for the line under a withdrawal waiting on Apple.
  const noteSheet = (paymentRef: string, result: RefundSheetResult | 'opening'): void => {
    if (alive.current) {
      setSheets(current => ({ ...current, [paymentRef]: result }))
    }
  }

  const openApple = (paymentRef: string, transactionId: string): void => {
    noteSheet(paymentRef, 'opening')
    requestStoreRefund(transactionId).then(result => noteSheet(paymentRef, result))
  }

  // The answer is the gateway's, so the row goes at once and the state that replaces it is the one the
  // answer carries, never a step past it, until the list read after it says what became of it.
  const received = (receipt: WithdrawReceipt): void => {
    const withdrawal = { state: receipt.state, requestedAt: receipt.requestedAt, outcomeAt: receipt.outcomeAt }
    setRead(current =>
      current && {
        ...current,
        purchases: current.purchases.map(p => (p.paymentRef === receipt.paymentRef ? { ...p, withdrawable: false, withdrawal } : p)),
      },
    )
    setOwn(n => n + 1)
  }

  const shown = read ? shownPurchases(read.purchases, kind) : []
  if (shown.length === 0 && open === null) {
    return null
  }

  return (
    <View style={styles.section}>
      {shown.map(purchase => {
        const item = itemOf(purchase)
        const format = { item, date: (s: number) => formatDate(s, prefs), time: (s: number) => formatTime(s, prefs) }
        if (purchase.withdrawal === null) {
          return (
            <View key={purchase.paymentRef} style={styles.group}>
              <Txt role="caption" tone="muted">
                {t('withdrawal.purchase', { item, date: formatDate(purchase.purchasedAt, prefs) })}
              </Txt>
              {needsAppleSheet(purchase, appleSheet) ? (
                <AppleElsewhere />
              ) : (
                <MenuRow
                  bleed
                  divider={false}
                  icon="close"
                  label={t('withdrawal.row')}
                  onPress={() => read && setOpen({ owner: read.owner, purchase })}
                />
              )}
            </View>
          )
        }
        const line = stateLine(purchase.withdrawal, purchase.channel, format)
        const appleWaiting = purchase.channel === 'apple' && purchase.withdrawal.state === 'requested'
        const sheet = sheets[purchase.paymentRef]
        return (
          <View key={purchase.paymentRef} style={styles.group} testID="withdrawal-state">
            <Txt role="caption" tone="default">
              {t(line.key, line.params)}
            </Txt>
            {appleWaiting && sheet !== undefined && sheet !== 'opening' && (
              <Txt role="caption" tone="muted">
                {t(APPLE_LINES[sheet])}
              </Txt>
            )}
            {/* Apple has a request only once its own sheet was sent, so a withdrawal waiting on Apple
                keeps the way back to that sheet; asking twice is answered as a duplicate. */}
            {appleWaiting && !appleSheet && <AppleElsewhere />}
            {appleWaiting && appleSheet && purchase.transactionId !== null && (
              <MenuRow
                bleed
                divider={false}
                icon="refresh"
                label={t('withdrawal.appleOpen')}
                disabled={sheet === 'opening'}
                onPress={() => openApple(purchase.paymentRef, purchase.transactionId!)}
              />
            )}
          </View>
        )
      })}
      <WithdrawalSheet
        target={open}
        itemOf={itemOf}
        onClose={() => {
          setOpen(null)
          setOwn(n => n + 1)
        }}
        onReceived={received}
        onAppleSheet={noteSheet}
      />
    </View>
  )
}

const APPLE_LINES: Record<RefundSheetResult, string> = {
  sent: 'withdrawal.appleSent',
  closed: 'withdrawal.appleClosed',
  duplicate: 'withdrawal.appleDuplicate',
  failed: 'withdrawal.appleFailed',
}

type SheetProps = {
  target: { owner: Owner; purchase: WalletPurchase } | null
  itemOf: ItemOf
  onClose: () => void
  onReceived: (receipt: WithdrawReceipt) => void
  onAppleSheet: (paymentRef: string, result: RefundSheetResult | 'opening') => void
}

// The confirmation, then the receipt. Opened with the purchase and the wallet that read it; a
// request is signed by that wallet or not at all.
function WithdrawalSheet({ target, itemOf, onClose, onReceived, onAppleSheet }: SheetProps): React.JSX.Element {
  const { t } = useTranslation()
  const prefs = useMemo(() => deviceDateTimePrefs(), [])
  // Unchecked on every opening; only a tick sends 1.
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<WithdrawReceipt | null>(null)
  const [apple, setApple] = useState<RefundSheetResult | 'opening' | null>(null)
  const opening = useRef(0)

  // Each opening starts clean, so nothing ticked or answered for one purchase reaches another.
  const key = target?.purchase.paymentRef ?? null
  useEffect(() => {
    opening.current += 1
    setConsent(false)
    setBusy(false)
    setError(null)
    setReceipt(null)
    setApple(null)
  }, [key])

  if (target === null) {
    return <Sheet visible={false} onClose={onClose} closeLabel={t('common.close')}>{null}</Sheet>
  }
  const { owner, purchase } = target
  const item = itemOf(purchase)

  const showApple = (transactionId: string): void => {
    const at = opening.current
    const { paymentRef } = purchase
    setApple('opening')
    onAppleSheet(paymentRef, 'opening')
    requestStoreRefund(transactionId).then(result => {
      onAppleSheet(paymentRef, result)
      if (opening.current === at) {
        setApple(result)
      }
    })
  }

  const confirm = async (): Promise<void> => {
    const at = opening.current
    setBusy(true)
    setError(null)
    try {
      // The active wallet is the one the screen shows; the connected one is checked again inside,
      // right before each signature, and the signer refuses any identity but the list's.
      const active = await getActiveWalletId().catch(() => null)
      const result =
        active !== owner.walletId
          ? ({ kind: 'otherWallet' } as const)
          : await requestWithdrawal(
              {
                ...owner.deps,
                walletId: owner.walletId,
                connectedWalletId: sparkConnectedWalletId,
                refundAddress: sparkOwnSparkAddress,
              },
              { purchase, consent },
            )
      if (opening.current !== at) {
        return
      }
      if (result.kind === 'received') {
        setReceipt(result.receipt)
        onReceived(result.receipt)
        // Apple's sheet opens only on the gateway's answer, for the transaction it named, and only while
        // that answer says the withdrawal waits on Apple.
        if (result.receipt.channel === 'apple' && result.receipt.state === 'requested') {
          if (result.receipt.transactionId !== null) {
            showApple(result.receipt.transactionId)
          } else {
            setApple('failed')
            onAppleSheet(purchase.paymentRef, 'failed')
          }
        }
        return
      }
      setError(t(refusalKey(result)))
    } finally {
      if (opening.current === at) {
        setBusy(false)
      }
    }
  }

  const receiptLine = receipt
    ? t('withdrawal.receipt', {
        date: formatDate(receipt.requestedAt, prefs),
        time: formatTime(receipt.requestedAt, prefs),
      })
    : ''

  const format = { item, date: (s: number) => formatDate(s, prefs), time: (s: number) => formatTime(s, prefs) }
  const next = receipt ? receiptNextLine(receipt, format) : null
  const nextText = next ? t(next.key, next.params) : ''
  // Apple's sheet is the way to Apple only while the withdrawal waits on Apple; a repeat that answers
  // an ended one opens nothing.
  const appleRequested = receipt !== null && receipt.channel === 'apple' && receipt.state === 'requested'
  const confirmLine = purchaseLine(purchase, { ...format, sats: amount => t('home.sats', { amount: formatSats(amount) }) })

  const save = (): void => {
    if (!receipt) {
      return
    }
    const message = [receiptLine, item, nextText, t('withdrawal.receiptRef', { ref: receipt.paymentRef })].join('\n')
    Share.share({ message }).catch(() => undefined)
  }

  return (
    <Sheet visible onClose={onClose} closeLabel={t('common.close')}>
      {receipt === null ? (
        <>
          <Txt role="subheading">{t('withdrawal.confirm')}</Txt>
          <Txt role="body" tone="muted" testID="withdrawal-purchase">
            {t(confirmLine.key, confirmLine.params)}
          </Txt>
          {purchase.channel === 'apple' && (
            <Touch
              onPress={() => setConsent(v => !v)}
              role="checkbox"
              state={{ checked: consent }}
              feedback="link"
              style={styles.consent}
              testID="withdrawal-consent">
              <CheckBox on={consent} />
              <Txt role="caption" style={styles.consentText}>
                {t('withdrawal.consent')}
              </Txt>
            </Touch>
          )}
          <ErrorBox message={error} />
          <GradientButton label={t('withdrawal.confirm')} onPress={() => confirm().catch(() => undefined)} loading={busy} />
          <GradientButton variant="secondary" label={t('common.cancel')} onPress={onClose} />
        </>
      ) : (
        <>
          <Txt role="bodyStrong" testID="withdrawal-receipt">
            {receiptLine}
          </Txt>
          <Txt role="body" tone="muted" testID="withdrawal-next">
            {nextText}
          </Txt>
          {appleRequested && apple !== null && apple !== 'opening' && (
            <Txt role="caption" tone="default">
              {t(APPLE_LINES[apple])}
            </Txt>
          )}
          {appleRequested && receipt.transactionId !== null && (apple === 'closed' || apple === 'failed') && (
            <GradientButton label={t('withdrawal.appleOpen')} onPress={() => showApple(receipt.transactionId!)} />
          )}
          <GradientButton variant="secondary" label={t('withdrawal.saveReceipt')} onPress={save} />
          <GradientButton variant="secondary" label={t('common.close')} onPress={onClose} />
        </>
      )}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  section: { gap: space.lg },
  group: { gap: space.sm },
  // A full-width target, so the box and its sentence stay on the leading edge.
  consent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
    gap: space.sm,
  },
  consentText: { flex: 1 },
})
