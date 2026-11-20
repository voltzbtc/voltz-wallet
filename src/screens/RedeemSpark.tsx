import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import {
  sparkParseLnurlWithdraw,
  sparkConfirmLnurlWithdraw,
  sparkGetFiatRates,
  type SparkLnurlWithdraw,
} from '../wallet/spark'
import { classifyWalletError, walletErrorKey } from '../wallet/errors'
import { formatSats, parseAmountSat } from '../wallet/amount'
import { satsToFiat, formatFiat, type FiatCurrency } from '../wallet/fiat'
import { resolveDefaultFiat } from '../wallet/deviceLocale'
import { resolveDisplayCurrency } from '../wallet/fiatDisplay'
import { AmountSheet } from '../components/AmountSheet'
import { GradientButton } from '../components/GradientButton'
import { Skeleton } from '../components/Skeleton'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { alpha, colors, font, radius, rhythm, space } from '../theme'
import { Screen } from '../components/Screen'
import { ErrorBox } from '../components/ErrorBox'
import { SectionLabel } from '../components/SectionLabel'
import { Txt } from '../components/Txt'
import { Amount } from '../components/Amount'
import { TabIcon } from '../components/TabIcon'
import { Touch } from '../components/Touch'
import { useAccent } from '../wallet/dollarMode'
import { joinLabels } from '../i18n/join'

type Nav = NativeStackNavigationProp<RootStackParamList, 'Redeem'>

// A voucher pulls sats in, so the minted invoice goes to its callback and the funds never pass
// through Voltz. The global ReceivedOverlayHost handles the arrival.
export function RedeemSpark(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { accent } = useAccent()
  const navigation = useNavigation<Nav>()
  const route = useRoute<RouteProp<RootStackParamList, 'Redeem'>>()

  const [voucher, setVoucher] = useState<SparkLnurlWithdraw | null>(null)
  const [amountSat, setAmountSat] = useState<number | null>(null)
  const [parsing, setParsing] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fiatRate, setFiatRate] = useState<number | null>(null)
  const [fiatCurrency, setFiatCurrency] = useState<FiatCurrency>(resolveDefaultFiat(i18n.language))

  const destination = route.params?.destination
  // Bumped by Try again, the one thing that reads the voucher a second time.
  const [reads, setReads] = useState(0)
  const [readFailed, setReadFailed] = useState(false)
  const parsed = useRef<number | null>(null)
  useEffect(() => {
    if (parsed.current === reads) {
      return
    }
    parsed.current = reads
    // Opened with no code, there is nothing to parse, and the skeleton would wait forever.
    if (!destination) {
      setParsing(false)
      setError(t('redeem.parseFailed'))
      return
    }
    let alive = true
    sparkParseLnurlWithdraw(destination)
      .then(w => {
        if (!alive) {
          return
        }
        setVoucher(w)
        setParsing(false)
        setSheetOpen(true)
      })
      .catch(cause => {
        if (!alive) {
          return
        }
        setParsing(false)
        setReadFailed(true)
        const code = classifyWalletError(cause)
        setError(code === 'unknown' || code === 'lnurlRefused' ? t('redeem.parseFailed') : t(walletErrorKey(code)))
      })
    return () => {
      alive = false
    }
  }, [destination, reads, t])

  function readAgain() {
    setReadFailed(false)
    setError(null)
    setParsing(true)
    setReads(n => n + 1)
  }

  // Best effort, since the review's approximate line is not required to redeem.
  useEffect(() => {
    let alive = true
    ;(async () => {
      const currency = await resolveDisplayCurrency(i18n.language)
      const rates = await sparkGetFiatRates([currency]).catch(() => ({} as Record<string, number>))
      if (alive && rates[currency] !== undefined) {
        setFiatCurrency(currency)
        setFiatRate(rates[currency])
      }
    })()
    return () => {
      alive = false
    }
  }, [i18n.language])

  // The first sheet is the way in, so leaving it without an amount leaves the screen. Reopened from
  // the review, it changes the amount or leaves the confirmed one as it was.
  function confirmAmount(value: number | undefined) {
    setSheetOpen(false)
    if (value === undefined || value <= 0) {
      if (amountSat === null) {
        navigation.goBack()
      }
      return
    }
    setAmountSat(value)
    // The error belongs to the attempt on the old amount, and beside a new one it reads as its own.
    setError(null)
  }

  async function confirm() {
    if (!voucher || amountSat === null || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const status = await sparkConfirmLnurlWithdraw(voucher.handle, amountSat)
      // The pull is atomic on the endpoint side, so pending means the same as complete.
      if (status === 'failed') {
        setError(t('redeem.failed'))
      } else {
        navigation.goBack()
      }
    } catch (cause) {
      // A voucher's service that refuses is the payer here, and errors.lnurlRefused speaks of a
      // recipient, so the claim reads as failed.
      const code = classifyWalletError(cause)
      setError(code === 'unknown' || code === 'lnurlRefused' ? t('redeem.failed') : t(walletErrorKey(code)))
    } finally {
      setBusy(false)
    }
  }

  const shownSat = amountSat ?? 0
  // Only a voucher with a range has an amount to change; a fixed one pays what it says.
  const ranged = voucher !== null && voucher.minSat < voucher.maxSat
  const fiatLine =
    fiatRate !== null
      ? t('send.approxFiat', { amount: formatFiat(satsToFiat(shownSat, fiatRate), fiatCurrency) })
      : null

  // The footer, as on Send's review, so the action stays in view above the bottom inset on a short
  // screen instead of below the fold under the gesture bar. Given from the voucher on rather than from
  // the amount: a footer arriving changes the screen's structure and remounts the scroll's children,
  // and the render that confirms the amount is the one that closes the amount sheet, which would then
  // be unmounted while still presented instead of sliding away.
  const reviewAction = voucher ? (
    <View style={styles.footer}>
      {amountSat !== null && (
        <GradientButton
          label={busy ? t('redeem.redeeming') : t('redeem.action')}
          onPress={confirm}
          loading={busy}
        />
      )}
    </View>
  ) : undefined

  return (
    <Screen scroll layout="padded" footer={reviewAction}>
      {parsing && (
        // The review's shape, its figure and then the source card, so nothing jumps when the voucher
        // answers.
        <View style={styles.reviewStack}>
          <View style={styles.hero}>
            <Skeleton width="30%" height={font.leading.sm} />
            <Skeleton width="55%" height={font.leading.display} style={styles.heroAmount} />
            <Skeleton width="35%" height={font.leading.sm} style={styles.instant} />
          </View>
          <View>
            <Skeleton width="25%" height={font.leading.sm} style={styles.sectionCap} />
            <Skeleton height={font.leading.base + space.lg * 2} borderRadius={radius.lg} />
          </View>
        </View>
      )}

      <ErrorBox message={error} style={styles.error} />
      {readFailed && <GradientButton label={t('common.retry')} onPress={readAgain} />}

      {amountSat !== null && voucher && (
        <View style={styles.reviewStack}>
          <View style={styles.hero}>
            <Txt role="section" tone="muted">
              {t('redeem.youRedeem')}
            </Txt>
            {ranged ? (
              // Disabled only in what it says and does while the voucher is pulled: `disabled` would dim
              // the figure being redeemed along with the link.
              <Touch
                onPress={() => {
                  if (!busy) {
                    setSheetOpen(true)
                  }
                }}
                feedback="link"
                state={{ disabled: busy }}
                label={joinLabels(t, [`${formatSats(shownSat)} ${t('common.sats')}`, fiatLine, t('redeem.changeAmount')])}>
                <Amount
                  value={formatSats(shownSat)}
                  unit={t('common.sats')}
                  role="display"
                  fiat={fiatLine ?? undefined}
                  style={styles.heroAmount}
                />
                <View style={[styles.change, busy && styles.changeBusy]}>
                  <TabIcon name="edit" color={accent} size={18} />
                  <Txt role="bodyBold" tone="accent">
                    {t('redeem.changeAmount')}
                  </Txt>
                </View>
              </Touch>
            ) : (
              <Amount
                value={formatSats(shownSat)}
                unit={t('common.sats')}
                role="display"
                fiat={fiatLine ?? undefined}
                style={styles.heroAmount}
              />
            )}
            <Txt role="label" tone="success" style={styles.instant}>
              {t('redeem.instant')}
            </Txt>
          </View>

          {voucher.description.trim().length > 0 && (
            <View>
              <SectionLabel style={styles.sectionCap}>{t('redeem.source')}</SectionLabel>
              <View style={styles.para}>
                <Txt role="body" style={styles.sourceText}>
                  {voucher.description}
                </Txt>
              </View>
            </View>
          )}
        </View>
      )}

      {voucher && (
        <AmountSheet
          visible={sheetOpen}
          unit="sats"
          allowDecimal={false}
          min={voucher.minSat}
          max={voucher.maxSat}
          satsBtcToggle
          fiatRate={fiatRate ?? undefined}
          fiatCurrency={fiatCurrency}
          initial={
            amountSat !== null
              ? String(amountSat)
              : voucher.minSat === voucher.maxSat
                ? String(voucher.minSat)
                : ''
          }
          parse={parseAmountSat}
          onConfirm={confirmAmount}
          onClose={() => confirmAmount(undefined)}
        />
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  error: {
    marginBottom: space.md,
  },
  reviewStack: {
    gap: rhythm.section,
  },
  hero: {
    alignItems: 'center',
  },
  // The roles carry no spacing, so the gap above the figure, its centring and the gap above the
  // "instant" line live here.
  heroAmount: {
    marginTop: space.sm,
    alignItems: 'center',
  },
  instant: {
    marginTop: space.sm,
  },
  change: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: space.xs,
    marginTop: space.sm,
  },
  changeBusy: {
    opacity: alpha.disabled,
  },
  sectionCap: {
    marginBottom: rhythm.sectionLabelToList,
  },
  sourceText: {
    textAlign: 'center',
  },
  para: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    padding: space.lg,
  },
  footer: {
    padding: space.xl,
  },
})
