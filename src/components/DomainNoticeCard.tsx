import React from 'react'
import { StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { TabIcon } from './TabIcon'
import { GradientButton } from './GradientButton'
import { formatDate, type DateTimePrefs } from '../wallet/history'
import type { DomainPhase } from '../wallet/domainTier'
import { colors, dangerSoftSurface, primarySoftSurface, space } from '../theme'
import { Card } from './Card'
import { Row } from './Row'
import { Txt } from './Txt'
import { Touch } from './Touch'

type Props = {
  phase: DomainPhase
  domain: string
  /** Unix seconds the paid year ends. Named by every phase but the frozen one. */
  expiresAt: number | null
  /** Unix seconds the hostname was taken off the edge. Named by the frozen copy. */
  frozenAt: number | null
  prefs: DateTimePrefs
  onRenew: () => void
  /**
   * Offered only while the domain is frozen, and only as a second choice under the renewal. Somebody
   * whose year lapsed can receive again right away, at no cost, by going back to the shared domain,
   * so the card offers more than paying or nothing. Undefined leaves it out, so a caller with
   * nowhere to send them shows one action rather than a dead button.
   */
  onUseShared?: (() => void) | undefined
  /** The build's own domain, named so the offer says where they are going. */
  sharedDomain?: string | undefined
}

// One key pair per phase, exhaustive over the phases that draw anything, so adding a phase to
// domainTier.ts fails the build here instead of rendering a card with no words in it.
const COPY: Record<Exclude<DomainPhase, 'fine'>, { title: string; body: string }> = {
  ending: { title: 'domain.noticeEndingTitle', body: 'domain.noticeEndingBody' },
  lastDay: { title: 'domain.noticeLastDayTitle', body: 'domain.noticeLastDayBody' },
  expired: { title: 'domain.noticeExpiredTitle', body: 'domain.noticeExpiredBody' },
  frozen: { title: 'domain.noticeFrozenTitle', body: 'domain.noticeFrozenBody' },
}

// The phase is derived elsewhere (wallet/domainTier.ts) and the renewal is run by the caller, so
// this file can be exercised without a clock, a network or a navigator.
export function DomainNoticeCard({
  phase,
  domain,
  expiresAt,
  frozenAt,
  prefs,
  onRenew,
  onUseShared,
  sharedDomain,
}: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  if (phase === 'fine') {
    return null
  }
  const copy = COPY[phase]
  // Orange while a date is still ahead, red once the next thing to happen is money not arriving.
  // The last day counts as red: after it there is no further warning to escalate to.
  const alarming = phase !== 'ending'
  // A frozen card dates the pause, since the expiry it was derived from is by then the wrong fact
  // to put in front of the owner.
  const stamp = phase === 'frozen' ? frozenAt : expiresAt
  const values = { domain, date: typeof stamp === 'number' ? formatDate(stamp, prefs) : '' }

  return (
    <>
      <Card gap="sm" style={alarming ? styles.alarming : styles.soon}>
        {/* A plain row, which forceRTL mirrors on its own. The globe carries no direction, unlike the
            chevrons in TabIcon, so nothing here is flipped by hand. */}
        <Row gap="sm">
          <TabIcon
            name="globe"
            color={alarming ? colors.danger : colors.primary}
            size={20}
            strokeWidth={2.5}
          />
          <Txt role="bodyBold" tone="default" style={[styles.title, alarming && styles.alarmingTitle]}>
            {t(copy.title, values)}
          </Txt>
        </Row>

        <Txt role="caption" tone="muted">
          {t(copy.body, values)}
        </Txt>
      </Card>

      {/* Outside the card, since the card states a condition and the button is what to do about it.
          Inside, an alarm-coloured box reads as containing the action, which made the fee note above
          it look like the price of the button under it. */}
      <GradientButton label={t('domain.renew')} onPress={onRenew} />
      {/* Only when frozen. Before that the addresses still work, so pointing somebody at another
          domain would be talking them out of what they already paid for. */}
      {phase === 'frozen' && onUseShared && sharedDomain && (
        <Touch onPress={onUseShared} feedback="link" style={styles.secondary}>
          <Txt role="label" tone="muted">
            {t('domain.useShared', { domain: sharedDomain })}
          </Txt>
        </Touch>
      )}
    </>
  )
}

const styles = StyleSheet.create({
  // Touch gives it the 44pt floor, so only the sides are padded here.
  secondary: { alignSelf: 'center', paddingHorizontal: space.md },
  soon: primarySoftSurface,
  alarming: dangerSoftSurface,
  // The title carries the alarm colour, matching the icon beside it. White reads as ordinary news,
  // and a domain that stopped receiving is not ordinary news.
  alarmingTitle: { color: colors.danger },
  // Takes the row's remaining width, so a long title wraps beside the icon instead of running past
  // the card. The type comes from the bodyBold role.
  title: {
    flex: 1,
  },
})
