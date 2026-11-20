import React from 'react'
import { type StyleProp, type ViewStyle } from 'react-native'
import { useTranslation } from 'react-i18next'
import { formatSats } from '../wallet/amount'
import type { BalanceSync } from '../wallet/spark'
import type { ExitOnItsWay } from '../wallet/exitQuote'
import { Card } from './Card'
import { Touch } from './Touch'
import { Txt } from './Txt'
import { joinLabels, joinSentences } from '../i18n/join'

type Props = {
  recoverableSat: number
  sync: BalanceSync
  // The funds are the person's money, so a hidden balance hides their amount too.
  hidden?: boolean
  // An exit under way owns these funds. Preparing them again would race it, so the card only leads to it.
  exitUnderWay?: boolean
  // The latest pass of that exit cannot go on without the person, whose answer is on its follow-up.
  exitWaits?: boolean
  // What the live exit is moving, from exitOnItsWay, or 'unread' when its plan could not be read.
  exit?: ExitOnItsWay | 'unread' | null
  // Absent, the card is a notice with no action.
  onOpen?: () => void
  style?: StyleProp<ViewStyle>
}

// Funds that left the balance for the chain. The SDK's figure counts leaves too small to be worth
// recovering, leaves it never checks on chain and, on a restored wallet, funds already recovered
// (recover_funds.md), so no read proves they can still be had and the card only says there may be
// that much. Before the first sync there is nothing to state.
export function RecoverableFundsCard({
  recoverableSat,
  sync,
  hidden = false,
  exitUnderWay = false,
  exitWaits = false,
  exit = null,
  onOpen,
  style,
}: Props): React.JSX.Element | null {
  const { t } = useTranslation()

  if (!exitUnderWay && (sync === 'waiting' || !(recoverableSat > 0))) {
    return null
  }
  const amount = hidden ? '••••' : formatSats(recoverableSat)
  const hedged =
    sync === 'stale' ? t('recoverableFunds.staleBody', { amount }) : t('recoverableFunds.body', { amount })
  const title = t(exitUnderWay ? 'emergencyExit.title' : 'recoverableFunds.title')
  // What arrives and never the value before fees, from the one figure the exit's screens read too, and
  // nothing when the plan states none.
  const arriving = exit !== null && exit !== 'unread' ? exit.arriving : null
  const leaving =
    arriving !== null && arriving.sat > 0
      ? t(arriving.floor ? 'emergencyExit.homeArrivesAtLeast' : 'emergencyExit.homeArrives', {
          amount: t('send.sats', { amount: hidden ? '••••' : formatSats(arriving.sat) }),
        })
      : null
  // A plan that could not be read is not known to be under way, only that the balance may count it. An
  // exit that waits on the person states no figure, since what arrives is what the person decides.
  const line =
    exit === 'unread'
      ? t('emergencyExit.balanceUnread')
      : exitWaits
      ? t('emergencyExit.homeWaits')
      : exitUnderWay
      ? joinSentences(t, [t('emergencyExit.homeUnderWay'), leaving])
      : hedged
  const body = (
    <Card gap="sm" style={style}>
      <Txt role="bodyBold">{title}</Txt>
      <Txt role="caption" tone="muted">
        {line}
      </Txt>
    </Card>
  )
  // The label replaces what the card draws, so it carries the amount and its hedge with the title.
  return onOpen ? (
    <Touch onPress={onOpen} feedback="surface" label={joinLabels(t, [title, line])}>
      {body}
    </Touch>
  ) : (
    body
  )
}
