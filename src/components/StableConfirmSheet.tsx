import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GradientButton } from './GradientButton'
import { Sheet } from './Sheet'
import { Skeleton } from './Skeleton'
import { Txt } from './Txt'
import { formatSats } from '../wallet/amount'
import { localizeAmount } from '../wallet/fiat'
import { formatCostPct, fromBaseUnits } from '../wallet/sparkConvert'
import { estimateSwitchCost, type SwitchCost } from '../wallet/stableCost'
import { USDB } from '../wallet/tokens'
import { font } from '../theme'

type Props = {
  // The direction asked about, or null with the sheet closed.
  pending: boolean | null
  onConfirm: () => void
  onClose: () => void
}

// The sheet in front of either direction of the dollar mode. It only looks: the cost comes from a
// quote that is dropped on arrival, and the one way to move money from here is the button, which stays
// whatever became of the estimate.
export function StableConfirmSheet({ pending, onConfirm, onClose }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [cost, setCost] = useState<SwitchCost | null>(null)

  // Read once per opening, so a background sync never moves the figure under a thumb.
  useEffect(() => {
    if (pending === null) {
      setCost(null)
      return
    }
    let alive = true
    setCost(null)
    estimateSwitchCost(pending).then(answer => alive && setCost(answer))
    return () => {
      alive = false
    }
  }, [pending])

  function costLine(known: SwitchCost): string {
    if (known.kind === 'cost') {
      return t('stable.costEstimate', { pct: formatCostPct(known.pct) })
    }
    if (known.kind === 'unknown') {
      return t('stable.costUnknown')
    }
    if (known.minBase === undefined) {
      return t('stable.belowMinimum')
    }
    return t('stable.belowMinimumAmount', {
      min: pending
        ? t('stable.sats', { amount: formatSats(known.minBase) })
        : t('stable.usdbBalance', {
            amount: localizeAmount(fromBaseUnits(known.minBase, USDB.decimals)),
            ticker: USDB.ticker,
          }),
    })
  }

  return (
    <Sheet visible={pending !== null} onClose={onClose} closeLabel={t('stable.confirmCancel')}>
      <Txt role="subheading">{t(pending ? 'stable.confirmOnTitle' : 'stable.confirmOffTitle')}</Txt>
      <Txt role="body" tone="muted">
        {t(pending ? 'stable.confirmOnBody' : 'stable.confirmOffBody', { ticker: USDB.ticker })}
      </Txt>
      {cost === null ? (
        <Skeleton width="50%" height={font.leading.sm} />
      ) : (
        <Txt role="caption" tone="muted">
          {costLine(cost)}
        </Txt>
      )}
      <GradientButton
        label={t(pending ? 'stable.confirmOnCta' : 'stable.confirmOffCta')}
        onPress={onConfirm}
        disabled={cost === null}
      />
      <GradientButton label={t('stable.confirmCancel')} variant="secondary" onPress={onClose} />
    </Sheet>
  )
}
