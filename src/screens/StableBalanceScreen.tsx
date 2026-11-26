import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useTranslation } from 'react-i18next'
import { MenuRow } from '../components/MenuRow'
import { Toggle } from '../components/Toggle'
import { Skeleton } from '../components/Skeleton'
import { connectActiveSpark, sparkGetIdentityPubkey, sparkGetStableBalance } from '../wallet/spark'
import {
  fetchUsdbPayouts,
  fetchUsdbRewards,
  type UsdbPayout,
  type UsdbRewards,
} from '../wallet/rewards'
import { classifyWalletError } from '../wallet/errors'
import { formatSats } from '../wallet/amount'
import { formatDate, type DateTimePrefs } from '../wallet/history'
import { deviceDateTimePrefs } from '../wallet/deviceLocale'
import { USDB } from '../wallet/tokens'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { dividerBottom, font, radius, rhythm, space } from '../theme'
import { Screen } from '../components/Screen'
import { Card } from '../components/Card'
import { Row } from '../components/Row'
import { SectionLabel } from '../components/SectionLabel'
import { ErrorBox } from '../components/ErrorBox'
import { Txt } from '../components/Txt'
import { Figure } from '../components/Amount'
import { FigureRow } from '../components/FigureRow'
import { Touch } from '../components/Touch'
import { StableConfirmSheet } from '../components/StableConfirmSheet'
import { useStableSwitch } from '../hooks/useStableSwitch'

// A preview only. The full record lives in the history, where the rewards land as received payments
// and the list pages through everything.
const PAYOUT_PREVIEW = 5

// About what the skeletons stand in for: a switch's own size, a label, and a figure.
const SWITCH_WIDTH = 51
const SWITCH_HEIGHT = 31
const LABEL_WIDTH = 180
const FIGURE_WIDTH = 120

// Built in local time, since parsing YYYY-MM-DD as UTC lands a day early west of Greenwich.
function formatDay(day: string, prefs: DateTimePrefs): string {
  // The API sends a bare YYYY-MM-DD or a full ISO timestamp, so only the date part is read.
  const [year, month, date] = day.slice(0, 10).split('-').map(Number)
  if (!year || !month || !date) {
    return day
  }
  return formatDate(new Date(year, month - 1, date).getTime() / 1000, prefs)
}

// Sats are indivisible, so a fractional estimate is rounded for display.
function satsAmount(sats: number): string {
  return formatSats(Math.round(sats))
}

// Framed as protection from volatility, never as an investment. Flashnet pays the rewards straight
// to the holder's wallet, with Voltz neither holding funds nor taking a cut.
export function StableBalanceScreen(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const prefs = useMemo(() => deviceDateTimePrefs(), [])
  const fmtNum = (n: number) => new Intl.NumberFormat(i18n.language).format(n)

  const [active, setActive] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)

  // Bumped to ask the SDK for the mode again, after a switch that never reached it.
  const [modeReads, setModeReads] = useState(0)
  const stable = useStableSwitch({ onShown: setActive, reread: () => setModeReads(n => n + 1) })
  const { switching, error: switchError, noteError } = stable

  useEffect(() => {
    let alive = true
    // The connection an ended exit leaves reads the mode as off until the next connection request
    // replaces it, so the read asks for one first. A request that fails reads what is connected.
    connectActiveSpark()
      .catch(() => undefined)
      .then(() => sparkGetStableBalance())
      .then(on => alive && setActive(on))
      .catch(cause => {
        if (alive) {
          const code = classifyWalletError(cause)
          noteError(code === 'unknown' ? t('stable.failed') : t(`errors.${code}`))
        }
      })
      .finally(() => alive && setSettingsLoaded(true))
    return () => {
      alive = false
    }
  }, [t, modeReads, noteError])

  const [rewards, setRewards] = useState<UsdbRewards | null>(null)
  const [payouts, setPayouts] = useState<UsdbPayout[]>([])
  const [rewardsLoaded, setRewardsLoaded] = useState(false)
  const [rewardsError, setRewardsError] = useState<string | null>(null)

  // The number of the last rewards read, the only one whose answer lands. Try again starts a new one,
  // and leaving the screen ends them all.
  const rewardsRead = useRef(0)
  const loadRewards = useCallback(async () => {
    const mine = ++rewardsRead.current
    setRewardsError(null)
    setRewardsLoaded(false)
    let pubkey: string
    try {
      pubkey = await sparkGetIdentityPubkey()
    } catch (cause) {
      if (mine === rewardsRead.current) {
        const code = classifyWalletError(cause)
        setRewardsError(code === 'unknown' ? t('stable.failed') : t(`errors.${code}`))
        setRewardsLoaded(true)
      }
      return
    }
    // Both lookups swallow their own failures, so a rewards outage never blocks the switch above.
    const [standing, history] = await Promise.all([
      fetchUsdbRewards(pubkey),
      fetchUsdbPayouts(pubkey, PAYOUT_PREVIEW),
    ])
    if (mine === rewardsRead.current) {
      setRewards(standing)
      setPayouts(history.slice(0, PAYOUT_PREVIEW))
      setRewardsLoaded(true)
    }
  }, [t])

  useEffect(() => {
    loadRewards()
    return () => {
      rewardsRead.current += 1
    }
  }, [loadRewards])

  // Either direction converts the whole balance, so both ask first through the confirmation sheet.
  function toggle(next: boolean) {
    if (!switching) {
      stable.ask(next)
    }
  }

  return (
    <Screen scroll layout="padded" contentStyle={styles.container}>
      <Txt role="caption" tone="muted">
        {t('stable.intro', { ticker: USDB.ticker })}
      </Txt>

      <View style={styles.section}>
        <Card padding="inset" style={styles.card}>
          {settingsLoaded ? (
            <MenuRow
              divider={false}
              label={t('stable.toggle')}
              onPress={() => toggle(!active)}
              disabled={switching}
              right={
                // No label of its own: the row's text already names it, and a second one made the
                // same name read twice.
                <Toggle value={active} onValueChange={toggle} disabled={switching} />
              }
            />
          ) : (
            <View style={[styles.skeletonRow, styles.toggleSkeleton]}>
              <Skeleton width={LABEL_WIDTH} height={font.leading.base} />
              <Skeleton width={SWITCH_WIDTH} height={SWITCH_HEIGHT} borderRadius={radius.full} />
            </View>
          )}
        </Card>
        {/* Out of the card, which holds the one thing to act on. */}
        <Txt role="caption" tone="muted">
          {t('stable.toggleHint')}
        </Txt>
        <Txt role="caption" tone="muted">
          {t('stable.deviceOnly')}
        </Txt>
        <ErrorBox message={switchError} />
      </View>

      <View style={styles.section}>
        <SectionLabel style={styles.label}>{t('stable.how')}</SectionLabel>
        <Txt role="caption">{t('stable.howBody', { ticker: USDB.ticker })}</Txt>
        <Txt role="caption">{t('stable.custody')}</Txt>
      </View>

      <View style={styles.section}>
        <SectionLabel style={styles.label}>{t('stable.rewardsTitle', { ticker: USDB.ticker })}</SectionLabel>
        {!rewardsLoaded ? (
          <Card padding="inset" style={styles.card}>
            <View style={[styles.skeletonRow, styles.divider]}>
              <Skeleton width={FIGURE_WIDTH} height={font.leading.base} />
              <Skeleton width={SWITCH_WIDTH} height={font.leading.base} />
            </View>
            <View style={styles.skeletonRow}>
              <Skeleton width={FIGURE_WIDTH} height={font.leading.base} />
              <Skeleton width={SWITCH_WIDTH} height={font.leading.base} />
            </View>
          </Card>
        ) : rewardsError !== null ? (
          <View>
            <ErrorBox message={rewardsError} />
            <Touch onPress={loadRewards} feedback="link" hitSlop={space.sm} style={styles.seeAll}>
              <Txt role="bodyBold" tone="accent">
                {t('common.retry')}
              </Txt>
            </Touch>
          </View>
        ) : rewards !== null ? (
          // Flashnet sets the rate and its rules and can change or end them, so the card draws no rate
          // and keeps to what this wallet holds, and the line below credits the rest to Flashnet.
          <Card padding="inset" style={styles.card}>
            <FigureRow label={t('stable.rewardsToday')} style={[styles.line, styles.divider]}>
              <Figure role="bodyStrong">
                {t('stable.sats', { amount: satsAmount(rewards.estimatedSatsToday) })}
              </Figure>
            </FigureRow>
            <FigureRow label={t('stable.rewardsBalance')} style={styles.line}>
              <Figure role="bodyStrong">
                {t('stable.usdbBalance', {
                  amount: fmtNum(Number(rewards.balance)),
                  ticker: USDB.ticker,
                })}
              </Figure>
            </FigureRow>
          </Card>
        ) : (
          <Txt role="caption">{t('stable.rewardsEmpty', { ticker: USDB.ticker })}</Txt>
        )}
        <Txt role="micro" tone="muted">
          {t('stable.rewardsIssuer', { ticker: USDB.ticker })}
        </Txt>
      </View>

      {payouts.length > 0 && (
        <View style={styles.section}>
          <SectionLabel style={styles.label}>{t('stable.payouts')}</SectionLabel>
          <Card padding="inset" style={styles.card}>
            {payouts.map((payout, index) => (
              <FigureRow
                key={payout.day}
                label={
                  <Row gap="sm">
                    <Txt role="body" tone="muted" wholeWords style={styles.rowLabel}>
                      {formatDay(payout.day, prefs)}
                    </Txt>
                    {!payout.paid && (
                      <Txt role="micro" tone="muted">
                        {t('stable.payoutPending')}
                      </Txt>
                    )}
                  </Row>
                }
                style={[styles.line, index < payouts.length - 1 && styles.divider]}>
                <Figure role="bodyStrong">{t('stable.sats', { amount: satsAmount(payout.sats) })}</Figure>
              </FigureRow>
            ))}
          </Card>
          <Touch
            onPress={() =>
              navigation.navigate('Main', { screen: 'Tabs', params: { screen: 'History' } })
            }
            feedback="link"
            hitSlop={space.sm}
            style={styles.seeAll}>
            <Txt role="bodyBold" tone="accent">
              {t('stable.seeAll')}
            </Txt>
          </Touch>
        </View>
      )}
      <StableConfirmSheet pending={stable.pending} onConfirm={stable.confirm} onClose={stable.cancel} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  container: {
    gap: rhythm.section,
  },
  section: {
    gap: space.sm,
  },
  // With the section's gap, the space a label keeps from its list.
  label: {
    marginBottom: rhythm.sectionLabelToList - space.sm,
  },
  // Clips the last row's divider to the rounded corner, which Card does not do because most cards
  // hold no rows.
  card: {
    overflow: 'hidden',
  },
  divider: {
    ...dividerBottom,
  },
  // Same height as the MenuRow it stands in for, so the layout doesn't jump when the SDK answers.
  toggleSkeleton: {
    paddingVertical: space.lg,
  },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.md,
  },
  // The day gives way to the pending mark beside it.
  rowLabel: {
    flexShrink: 1,
  },
  // The padding of the app's list rows.
  line: {
    paddingVertical: space.md,
  },
  seeAll: {
    alignSelf: 'flex-start',
    paddingVertical: space.sm,
  },
})
