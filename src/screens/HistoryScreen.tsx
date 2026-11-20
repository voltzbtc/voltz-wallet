import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs'
import { useTranslation } from 'react-i18next'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import {
  SYNC_WAIT_MS,
  connectActiveSpark,
  onSparkConnected,
  sparkListHistory,
  sparkRefreshWallet,
  sparkSubscribeToPayments,
  sparkSyncState,
  type BalanceSync,
  type SparkDeposit,
} from '../wallet/spark'
import { answerWithin } from '../wallet/answerWithin'
import { onActiveWalletChanged } from '../wallet/wallet'
import { useFreshLines } from '../hooks/useFreshLines'
import { usePullFeedback } from '../hooks/usePullFeedback'
import { Reenter } from '../components/Reenter'
import { usePullRefresh } from '../hooks/usePullRefresh'
import { useSyncRefresh } from '../hooks/useSyncRefresh'
import { useContactNames } from '../hooks/useContactNames'
import { useSelectedItem } from '../hooks/useSelectedItem'
import { usePendingDeposits } from '../hooks/usePendingDeposits'
import type { RootStackParamList } from '../navigation/RootNavigator'
import type { HistoryItem } from '../wallet/payment'
import {
  assetHistoryFilter,
  isAssetMovement,
  groupHistory,
  flattenHistory,
  formatTime,
  formatDate,
  conversionLeft,
  directionLabel,
  historyStatusText,
  rowAmountText,
  type HistoryGroup,
  type HistoryRow,
  type DateTimePrefs,
} from '../wallet/history'
import { deviceDateTimePrefs } from '../wallet/deviceLocale'
import { DirectionBadge } from '../components/DirectionBadge'
import { Skeleton } from '../components/Skeleton'
import { TabIcon } from '../components/TabIcon'
import { PendingDepositRows } from '../components/PendingDepositRows'
import { DepositDetailSheet, TransactionDetailSheet } from '../components/TransactionDetailSheet'
import { colors, dividerBottom, font, radius, rhythm, space } from '../theme'
import { CenterStack, Screen } from '../components/Screen'
import { Txt } from '../components/Txt'
import { Touch } from '../components/Touch'
import { EmptyState } from '../components/EmptyState'
import { FadeInLine } from '../components/FadeInLine'
import { ErrorBox } from '../components/ErrorBox'
import { GradientButton } from '../components/GradientButton'
import { SectionLabel } from '../components/SectionLabel'
import { Figure } from '../components/Amount'
import { FigureRow } from '../components/FigureRow'
import { classifyWalletError, type WalletErrorCode } from '../wallet/errors'

type State =
  | { status: 'loading' }
  // `sync` is the connection's standing when the read went out, as on a balance.
  // `fetched` counts the rows the query gave, which is where the next page starts. It can pass
  // `items.length` when the filter by asset dropped some.
  | { status: 'ready'; items: HistoryItem[]; fetched: number; exhausted: boolean; sync: BalanceSync }
  | { status: 'error'; code: WalletErrorCode }

// One screenful and some, so the first page fills the list without asking for a second right away.
const PAGE = 30

const awaitingSync = (state: Extract<State, { status: 'ready' }>): boolean =>
  state.items.length === 0 && state.sync === 'waiting'

// A conversion stays inside the wallet, so it is neither gain nor loss and carries no sign. A sent
// amount takes the minus sign (U+2212), as wide as the plus, not the hyphen.
function signedAmount(
  item: HistoryItem,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const amount = rowAmountText(item, t)
  if (item.direction === 'converted') {
    return amount
  }
  return t(item.direction === 'received' ? 'history.amountIn' : 'history.amountOut', { amount })
}

function groupLabel(group: HistoryGroup, t: (key: string) => string, prefs: DateTimePrefs): string {
  if (group.kind === 'today') {
    return t('history.today')
  }
  if (group.kind === 'yesterday') {
    return t('history.yesterday')
  }
  return formatDate(group.ts, prefs)
}

// A failed amount also carries a strike, which is the only decoration left in a style block.
function amountTone(item: HistoryItem): 'danger' | 'muted' | 'success' | 'default' {
  if (item.status === 'failed') {
    return 'danger'
  }
  if (item.status === 'pending') {
    return 'muted'
  }
  return item.direction === 'received' ? 'success' : 'default'
}

// A row's contents while loading, with the ready row's line heights (the direction and the amount on
// the body line, the time and status on the caption line under it), so the list does not grow when
// the rows arrive.
function RowSkeleton(): React.JSX.Element {
  return (
    <>
      <Skeleton width={40} height={40} borderRadius={radius.full} />
      <View style={styles.rowText}>
        <Skeleton width={96} height={font.leading.base} />
        <Skeleton width={72} height={font.leading.sm} />
      </View>
      <Skeleton width={80} height={font.leading.base} />
    </>
  )
}

// `assetId` narrows it to one asset, for the list the asset screen opens. Without it, every payment.
export function HistoryScreen({ assetId }: { assetId?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const names = useContactNames()
  // Read here rather than taken from Screen, because the bottom of a list belongs inside its
  // content container, so the last row scrolls clear of the indicator instead of stopping above it.
  // As a tab the bar below holds the inset, as it does under Home, so only the asset's own list,
  // pushed on the stack, adds it.
  const insets = useSafeAreaInsets()
  const inTab = useContext(BottomTabBarHeightContext) !== undefined
  const bottom = { paddingBottom: space.xl + (inTab ? 0 : insets.bottom) }
  // No time zone handling is needed, since Intl and the day grouping both work in the device zone.
  const prefs = useMemo(() => deviceDateTimePrefs(), [])
  const [state, setState] = useState<State>({ status: 'loading' })
  const [selected, select] = useSelectedItem(state.status === 'ready' ? state.items : null)
  const { deposits, standing: depositsStanding, read: readDeposits } = usePendingDeposits()
  // By its outpoint, so the detail follows each read. A read that no longer lists it forgets it, as
  // a wallet switch does by emptying the list, so a later read listing it again never reopens it.
  const [openDeposit, setOpenDeposit] = useState<string | null>(null)
  const openDeposits = deposits.filter(d => `${d.txid}:${d.vout}` === openDeposit)
  const openListed = openDeposits.length > 0
  useEffect(() => {
    if (openDeposit !== null && !openListed) {
      setOpenDeposit(null)
    }
  }, [openDeposit, openListed])
  const showDeposit = (deposit: SparkDeposit) => setOpenDeposit(`${deposit.txid}:${deposit.vout}`)
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const refundDeposit = (deposit: SparkDeposit) =>
    navigation.navigate('RefundDeposit', { txid: deposit.txid, vout: deposit.vout })
  const filter = useMemo(() => (assetId === undefined ? undefined : assetHistoryFilter(assetId)), [assetId])
  const keep = useCallback(
    (items: HistoryItem[]) => (assetId === undefined ? items : items.filter(item => isAssetMovement(item, assetId))),
    [assetId],
  )

  // How many rows the query has given, which is how many a refresh reads again.
  const shown = useRef(0)
  shown.current = state.status === 'ready' ? state.fetched : 0
  // A list at its end asks for one row past it, since a read of exactly the rows on screen cannot tell
  // the end from a full page, and the footer would come back until the next scroll.
  const atEnd = useRef(false)
  atEnd.current = state.status === 'ready' && state.exhausted

  // Guards the tail fetch so a fast scroll cannot fire several at once, and survives re-renders.
  const loadingMore = useRef(false)
  // The number of the last next-page read, which is the only one whose answer lands. A first-page read
  // starts a new count and clears the guard, so a read that never answers stops paging only until the
  // tab is shown again, and an abandoned read answering later appends nothing.
  const pageRead = useRef(0)
  // The last next-page read failed. The footer skeleton is hidden so the list does not promise rows
  // that are not coming, and stays hidden through the retry, so a list that shrinks back into reach of
  // the end retries once rather than in a loop.
  const [pageFailed, setPageFailed] = useState(false)

  // Whether the screen is focused, read by loads that resolve after a blur.
  const focused = useRef(false)
  // The number of the last first-page read started, which is the only one whose answer lands. Focus
  // and Try again always start a new read, so a read that never answers cannot hold the skeleton or
  // swallow the refocus that would show a payment made while the tab was away.
  const latest = useRef(0)
  // The answer of the read started last, set as it starts.
  const newestRead = useRef<Promise<boolean>>(Promise.resolve(false))
  // Whether that last read is still unanswered. A payment that lands meanwhile is queued behind it
  // rather than run alongside it, since the read in flight may have started before the payment existed.
  const latestPending = useRef(false)
  const readAgain = useRef(false)
  const unsubscribe = useRef<Promise<() => void> | null>(null)
  // Bumped by a wallet switch, so a pull the previous wallet started reads nothing for it.
  const epoch = useRef(0)

  const loadMore = useCallback(async () => {
    // A first-page read replaces the whole list, so a page counted from the list it replaces would
    // land out of step with it, one row short or one repeated when a payment moved the rows down.
    if (
      loadingMore.current ||
      latestPending.current ||
      state.status !== 'ready' ||
      state.exhausted
    ) {
      return
    }
    loadingMore.current = true
    const mine = ++pageRead.current
    const offset = state.fetched
    try {
      const next = await sparkListHistory(PAGE, filter, offset)
      if (mine !== pageRead.current) {
        return
      }
      setPageFailed(false)
      setState(prev =>
        prev.status === 'ready'
          ? {
              ...prev,
              items: [...prev.items, ...keep(next)],
              fetched: prev.fetched + next.length,
              exhausted: next.length < PAGE,
            }
          : prev,
      )
    } catch {
      // Leaves the rows on screen alone, since the next scroll to the end retries.
      if (mine === pageRead.current) {
        setPageFailed(true)
      }
    } finally {
      if (mine === pageRead.current) {
        loadingMore.current = false
      }
    }
  }, [filter, keep, state])

  const { fresh, pullStarted, readLanded, pullEnded } = useFreshLines()
  const feedback = usePullFeedback()
  const dropFeedback = feedback.drop

  // Answers whether lines landed. A replaced read lands nothing, so its own answer says nothing about
  // what is on screen, and it hands on the answer of the read that replaced it. A read that answers on
  // a blurred tab lands nowhere.
  const loadFirstPage = useCallback((): Promise<boolean> => {
    const mine = ++latest.current
    latestPending.current = true
    pageRead.current += 1
    loadingMore.current = false
    const read = async (): Promise<boolean> => {
      try {
        // Before the read, since the tab can gain focus with the wallet just switched and no other
        // screen reconnecting, and with the app just opened and nothing connected yet.
        await connectActiveSpark()
        // Its own read, so a list never waits for it or falls with it. Bitcoin on its way belongs to the
        // wallet and not to one asset, so an asset's list never reads it and shows no row of it.
        if (assetId === undefined) {
          readDeposits()
        }
        // Every row on screen, in one read that replaces them. Rows kept from an earlier read could
        // belong to another wallet, would shift out of step with a new payment on top, and would stay
        // pending after they settled.
        const count = Math.max(PAGE, shown.current + (atEnd.current ? 1 : 0))
        // Taken before the read, so a sync landing while it runs leaves this answer unsynced and the
        // sync's own notice brings the read again.
        const sync = sparkSyncState()
        const items = await sparkListHistory(count, filter)
        if (mine !== latest.current) {
          return newestRead.current
        }
        if (!focused.current) {
          return false
        }
        const kept = keep(items)
        readLanded(kept.map(item => item.id))
        setState({
          status: 'ready',
          items: kept,
          fetched: items.length,
          exhausted: items.length < count,
          sync,
        })
        // Registered only after a read succeeds, since a read that throws means the SDK is not there to
        // subscribe to, and only once per focus however many reads follow.
        if (!unsubscribe.current) {
          const sub = sparkSubscribeToPayments(() => {
            if (!focused.current) {
              return
            }
            if (latestPending.current) {
              readAgain.current = true
            } else {
              loadFirstPage()
            }
          })
          unsubscribe.current = sub
          sub.catch(() => {
            if (unsubscribe.current === sub) {
              unsubscribe.current = null
            }
          })
        }
        return true
      } catch (cause) {
        if (mine !== latest.current) {
          return newestRead.current
        }
        // A connect a newer request replaced is no failure: that request's connect, or the switch it
        // came with, brings the next read. Matched by name, as HomeScreen does.
        if ((cause as Error | null)?.name === 'SparkConnectSuperseded') {
          return false
        }
        // A live refresh keeps whatever is shown. Only a screen with nothing read yet turns into the
        // error, and never into the empty state, which would say there is no transaction. A skeleton
        // over an empty list is nothing read yet too, and it has no pull to get out by.
        if (mine === latest.current && focused.current) {
          const code = classifyWalletError(cause)
          setState(prev => (prev.status === 'ready' && !awaitingSync(prev) ? prev : { status: 'error', code }))
        }
        return false
      } finally {
        // A superseded read leaves the queue to the read that replaced it.
        if (mine === latest.current) {
          latestPending.current = false
          if (readAgain.current && focused.current) {
            readAgain.current = false
            loadFirstPage()
          }
        }
      }
    }
    newestRead.current = read()
    return newestRead.current
  }, [assetId, filter, keep, readDeposits, readLanded])

  useFocusEffect(
    useCallback(() => {
      focused.current = true
      loadFirstPage()
      return () => {
        focused.current = false
        readAgain.current = false
        const sub = unsubscribe.current
        unsubscribe.current = null
        sub?.then(fn => fn()).catch(() => undefined)
      }
    }, [loadFirstPage]),
  )

  // The first sync, or the end of the wait for it, is what turns a skeleton into the list, and an empty
  // list into the line that says so. A blurred tab reads when it comes back.
  useSyncRefresh(() => {
    if (focused.current) {
      loadFirstPage()
    }
  })

  // A switch fires before the reconnect, so the previous wallet's rows go at once. The tab stays mounted
  // and can be the focused one, as under the drawer; a read still out lands nothing, since the read
  // started here or by the next focus replaces it and a blurred one lands nowhere.
  useEffect(
    () =>
      onActiveWalletChanged(() => {
        epoch.current += 1
        setPageFailed(false)
        select(null)
        pullEnded()
        dropFeedback()
        setState({ status: 'loading' })
        if (focused.current) {
          loadFirstPage()
        }
      }),
    [loadFirstPage, select, pullEnded, dropFeedback],
  )

  // A new connection brings the read a connect in progress held back, and the payment listener goes
  // with it, since a listener belongs to the instance it was added on. Skipped as it registers, when
  // the focus read of this same commit covers a connection already up.
  useEffect(() => {
    let registering = true
    const off = onSparkConnected(() => {
      if (registering) {
        return
      }
      const sub = unsubscribe.current
      unsubscribe.current = null
      sub?.then(fn => fn()).catch(() => undefined)
      if (focused.current) {
        loadFirstPage()
      }
    })
    registering = false
    return off
  }, [loadFirstPage])

  // Syncs first and reads after, so no line moves before the sync answers. The mark goes up ahead of the
  // read, which can fail or never answer. Only the mark: a list that synced shows nothing new until the
  // read lands, or an empty list would say there are no transactions before anything was read.
  const refreshControl = usePullRefresh(async () => {
    const run = epoch.current
    pullStarted(state.status === 'ready' ? state.items.map(item => item.id) : [])
    await sparkRefreshWallet()
    if (run !== epoch.current) {
      return
    }
    const sync = sparkSyncState()
    if (sync === 'stale') {
      setState(prev => (prev.status === 'ready' ? { ...prev, sync: 'stale' } : prev))
    }
    // Bounded, since the read the answer comes from can be one that never answers.
    const landed = await answerWithin(loadFirstPage(), SYNC_WAIT_MS)
    if (run === epoch.current) {
      pullEnded()
      feedback.pulled(sync === 'synced' && landed === true)
    }
  })

  const retry = (): void => {
    setState({ status: 'loading' })
    loadFirstPage()
  }

  // An empty read says something about the wallet only on a connection that synced, and
  // about the wallet list only once its deposits answered, since bitcoin on its way draws rows there.
  // That read is bounded, and only the first one holds the screen, so a pull never brings this back.
  const depositsUnread = assetId === undefined && depositsStanding === 'unread'
  const nothingYet =
    state.status === 'ready' && state.items.length === 0 && (awaitingSync(state) || depositsUnread)

  if (state.status === 'loading' || nothingYet) {
    return (
      <Screen scroll layout="padded" contentStyle={bottom}>
        {/* The day's label too, since the ready list opens with one and would otherwise drop 32pt. */}
        <Skeleton width={90} height={font.leading.sm} style={styles.skeletonLabel} />
        <View style={styles.card}>
          {Array.from({ length: SKELETON_ROWS }).map((_, index) => (
            <View key={index} style={[styles.row, index < SKELETON_ROWS - 1 && styles.rowDivided]}>
              <RowSkeleton />
            </View>
          ))}
        </View>
      </Screen>
    )
  }

  if (state.status === 'error') {
    return (
      <Screen layout="center" contentStyle={bottom}>
        <CenterStack>
          <ErrorBox message={state.code === 'offline' ? t('errors.offline') : t('history.loadFailed')} />
          <GradientButton label={t('common.retry')} variant="secondary" onPress={retry} />
        </CenterStack>
      </Screen>
    )
  }

  // One sheet, second after either the empty screen or the list, so the first payment that swaps one
  // for the other under an open detail keeps the sheet and its state rather than mounting a new one.
  const depositSheet = (
    <DepositDetailSheet deposits={openDeposits} onClose={() => setOpenDeposit(null)} />
  )

  // Only a read that resolved with nothing on a synced connection says there is nothing. Past the wait
  // for a sync the screen says the same as a balance: not updated, and nothing about the wallet.
  // Scrolling, or there would be nothing to pull.
  if (state.items.length === 0) {
    return (
      <>
        <View style={styles.list} {...feedback.touch}>
          {deposits.length > 0 ? (
            <Screen
              scroll
              layout="padded"
              contentStyle={bottom}
              refreshControl={refreshControl}
              scrollGesture={feedback.scroll}>
              <Reenter beat={feedback.beat} order={0}>
                <PendingDepositRows
                  deposits={deposits}
                  stale={state.sync === 'stale'}
                  onRefund={refundDeposit}
                  onOpen={showDeposit}
                />
              </Reenter>
            </Screen>
          ) : (
            <Screen
              scroll
              layout="center"
              contentStyle={bottom}
              refreshControl={refreshControl}
              scrollGesture={feedback.scroll}>
              <Reenter beat={feedback.beat} order={0}>
                {state.sync === 'synced' && (assetId !== undefined || depositsStanding === 'read') ? (
                  // A wallet with nothing in it yet has one thing to do next, so the empty list leads there.
                  <EmptyState
                    icon="history"
                    message={t('history.empty')}
                    action={
                      <CenterStack>
                        <GradientButton
                          label={t('home.receive')}
                          icon={<TabIcon name="receive" color={colors.onPrimary} size={22} strokeWidth={3} />}
                          onPress={() => navigation.navigate('Receive', assetId === undefined ? undefined : { assetId })}
                        />
                      </CenterStack>
                    }
                  />
                ) : (
                  // Nothing is known about the wallet yet, so there is nothing to point at.
                  <EmptyState message={t('home.notUpdated')} />
                )}
              </Reenter>
            </Screen>
          )}
        </View>
        {depositSheet}
      </>
    )
  }

  const rows = flattenHistory(groupHistory(state.items, Date.now()))

  const renderRow = ({ item: row, index }: { item: HistoryRow; index: number }) => {
    if (row.kind === 'header') {
      return (
        <Reenter beat={feedback.beat} order={index}>
          <SectionLabel style={styles.groupLabel}>{groupLabel(row.group, t, prefs)}</SectionLabel>
        </Reenter>
      )
    }
    const { item } = row
    const left = conversionLeft(item, t)
    return (
      <FadeInLine
        fresh={fresh.has(item.id)}
        style={[
          styles.cardRow,
          row.firstInGroup && styles.cardFirst,
          row.lastInGroup && styles.cardLast,
        ]}>
        {/* The fill stays, so a card's corners never leave with its row. */}
        <Reenter beat={feedback.beat} order={index}>
          <Touch
            onPress={() => select(item)}
            feedback="row"
            style={[styles.row, !row.lastInGroup && styles.rowDivided]}>
            <DirectionBadge direction={item.direction} size={40} />
            {/* The figure goes under the labels at a large text size, by the rule every label and
                figure share, since beside them it would leave the labels no width at all. */}
            <FigureRow
              label={
                <View style={styles.rowText}>
                  <View style={styles.directionRow}>
                    {item.zap ? <TabIcon name="bolt" color={colors.textSecondary} size={14} /> : null}
                    <Txt role="bodyStrong" wholeWords style={styles.label}>
                      {item.zap ? t('history.zap') : directionLabel(item, t, names)}
                    </Txt>
                  </View>
                  <Txt role="caption" tone="muted" wholeWords>
                    {t('history.rowMeta', {
                      time: formatTime(item.timestamp, prefs),
                      status: historyStatusText(item, t),
                    })}
                  </Txt>
                </View>
              }>
              <Figure
                role="bodyBold"
                tone={amountTone(item)}
                tabular
                style={item.status === 'failed' && styles.failed}>
                {signedAmount(item, t)}
              </Figure>
              {left ? (
                <Figure role="caption" tone="muted" tabular>
                  {left}
                </Figure>
              ) : null}
            </FigureRow>
          </Touch>
        </Reenter>
      </FadeInLine>
    )
  }

  return (
    // The list scrolls itself, so it owns its own bottom: a wrapper cannot pad the inside of a
    // FlatList, and padding the wrapper instead stops the list short of the screen edge.
    <>
      <Screen contentStyle={styles.listHost}>
        <FlatList
          {...feedback.touch}
          {...feedback.scroll}
          data={rows}
          extraData={feedback.beat}
          keyExtractor={row => row.key}
          renderItem={renderRow}
          style={styles.list}
          contentContainerStyle={[styles.container, bottom]}
          onEndReached={loadMore}
          onEndReachedThreshold={0.6}
          refreshControl={refreshControl}
          ListHeaderComponent={
            <>
              {state.sync === 'stale' ? (
                <Txt role="caption" tone="muted" style={styles.staleMark}>
                  {t('home.notUpdated')}
                </Txt>
              ) : null}
              <PendingDepositRows
                deposits={deposits}
                onRefund={refundDeposit}
                onOpen={showDeposit}
                style={styles.deposits}
              />
            </>
          }
          ListFooterComponent={
            state.exhausted || pageFailed ? null : (
              <View style={[styles.cardRow, styles.cardFirst, styles.cardLast, styles.row]}>
                <RowSkeleton />
              </View>
            )
          }
        />

        <TransactionDetailSheet item={selected} names={names} onClose={() => select(null)} />
      </Screen>
      {depositSheet}
    </>
  )
}

const SKELETON_ROWS = 6

const styles = StyleSheet.create({
  container: {
    padding: space.xl,
  },
  // Nothing at all, because the FlatList below is the scrolling surface and pads its own content, so
  // any padding here would stop the list short of the screen edge and leave background under it.
  listHost: {
    paddingBottom: 0,
  },
  list: {
    flex: 1,
  },
  // The same air under a section label as the asset screen's, so the label reads as the card's title
  // rather than as part of its first row.
  groupLabel: {
    marginBottom: rhythm.sectionLabelToList,
  },
  skeletonLabel: {
    marginBottom: rhythm.sectionLabelToList,
    marginHorizontal: space.xs,
  },
  // The rows are list items, so a group's card is drawn by its first and last row's corners.
  cardRow: {
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  cardFirst: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderCurve: 'continuous',
  },
  cardLast: {
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
    borderCurve: 'continuous',
    marginBottom: rhythm.section,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  // Laid across by the style, since a Touch is a column and would stack badge, text and amount.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  // Every row of a group but its last, because iOS grouped lists end flush at the card edge.
  rowDivided: dividerBottom,
  rowText: {
    gap: space.xs,
  },
  directionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  // Gives way to the labels before it reaches them, so they always keep a share of the row.
  // Wraps between words beside the zap mark rather than running past the row.
  label: {
    flexShrink: 1,
  },
  failed: {
    textDecorationLine: 'line-through',
  },
  staleMark: {
    textAlign: 'center',
    marginBottom: space.lg,
  },
  // Above the first day's label, at the distance the stale mark keeps from what follows it.
  deposits: {
    marginBottom: space.lg,
  },
})
