import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import type Svg from 'react-native-svg'
import { useTranslation } from 'react-i18next'
import { answerWithin } from '../wallet/answerWithin'
import { cardExportSize, shareAddressText, shareCardImage } from '../wallet/addressCard'
import { colors, space } from '../theme'
import { AddressCard } from './AddressCard'
import { ErrorBox } from './ErrorBox'
import { GradientButton } from './GradientButton'
import { Sheet } from './Sheet'
import { TabIcon } from './TabIcon'
import { Txt } from './Txt'

// The address as the screen drew it when Share was pressed. The sheet draws and sends this one, never
// a newer or an older read, and the screen closes the sheet when its address moves away from it.
export type CardAddress = { address: string; lnurl: string }

// toDataURL answers through a callback that a view torn down mid draw never calls.
const RENDER_WAIT_MS = 5_000
// The card is never drawn wider than this, so it stays a preview beside the buttons.
const PREVIEW_MAX = 280

type Props = {
  card: CardAddress | null
  onClose: () => void
  // Asks again whether an emergency exit holds the wallet, before anything leaves the screen; true
  // when it holds, and the screen then says why and closes this sheet.
  heldAtPress: () => Promise<boolean>
}

export function AddressShareSheet({ card, onClose, heldAtPress }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const window = useWindowDimensions()
  const svg = useRef<Svg>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const size = Math.min(window.width - space.lg * 2, PREVIEW_MAX)

  // A sheet opened for another address starts clean.
  useEffect(() => {
    setFailure(null)
    setBusy(false)
  }, [card])

  async function send(shown: CardAddress, asImage: boolean): Promise<void> {
    const message = t('receive.lnShareMessage', { address: shown.address })
    if (await heldAtPress()) {
      return
    }
    if (!asImage) {
      await shareAddressText(message)
      return
    }
    const drawn = svg.current
    if (!drawn) {
      throw new Error('card not drawn')
    }
    const png = await answerWithin(
      new Promise<string>(resolve => drawn.toDataURL(resolve, cardExportSize())),
      RENDER_WAIT_MS,
    )
    if (!png) {
      throw new Error('card not drawn')
    }
    await shareCardImage(png, message, t('receive.lnShareTitle'))
  }

  function press(asImage: boolean): void {
    if (!card || busy) {
      return
    }
    const shown = card
    setFailure(null)
    setBusy(true)
    send(shown, asImage)
      // Only the kind of failure is logged, since the platform's message can carry the file's path.
      .catch((err: unknown) => {
        console.warn(`address card share failed: ${(err as Error | null)?.name ?? 'unknown'}`)
        setFailure(t('receive.lnShareFailed'))
      })
      .finally(() => setBusy(false))
  }

  return (
    <Sheet visible={card !== null} onClose={onClose} closeLabel={t('common.close')}>
      <Txt role="subheading">{t('receive.lnShareTitle')}</Txt>
      {card && (
        <View style={styles.preview}>
          <AddressCard
            ref={svg}
            address={card.address}
            qrValue={card.lnurl}
            invite={t('receive.lnShareInvite')}
            size={size}
            label={t('receive.lnShareCardLabel', { address: card.address })}
          />
        </View>
      )}
      <ErrorBox message={failure} />
      <GradientButton
        label={t('receive.lnShareCard')}
        loading={busy}
        disabled={busy}
        icon={<TabIcon name="share" color={colors.onPrimary} size={18} />}
        onPress={() => press(true)}
      />
      <GradientButton
        label={t('receive.lnShareText')}
        variant="secondary"
        disabled={busy}
        onPress={() => press(false)}
      />
    </Sheet>
  )
}

const styles = StyleSheet.create({
  preview: {
    alignItems: 'center',
  },
})
