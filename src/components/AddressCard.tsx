import React, { forwardRef } from 'react'
import Svg, { G, Path, Rect, Text as SvgText } from 'react-native-svg'
import { colors, font, radius, space } from '../theme'
import { CARD_SIZE, cardAddressFontSize, cardQrPath } from '../wallet/addressCard'
import { BOLT_D, GROUP_TRANSLATE, LETTERS_D, VB_H, VB_W } from './wordmark'

type Props = {
  // The address drawn in type, and the text the code encodes: the screen's own QR text for it.
  address: string
  qrValue: string
  // The line that asks for a payment in bitcoin.
  invite: string
  // The side it is drawn at on screen. The PNG is drawn from the same viewBox at CARD_SIZE.
  size: number
  label: string
}

// One Svg, so react-native-svg's toDataURL turns exactly what is on screen into the PNG. Laid out as a
// 360 point screen drawn at 3x, so its measures come from the app's tokens.
const UNIT = CARD_SIZE / 360
const PAD = space.xl * UNIT
const MARK_W = 100 * UNIT
const MARK_H = (MARK_W * VB_H) / VB_W
const INVITE_SIZE = font.size.lg * UNIT
const ADDRESS_MAX = font.size.xxl * UNIT
const GAP = space.md * UNIT
const FRAME_PAD = space.lg * UNIT

const INVITE_BASELINE = PAD + MARK_H + GAP + INVITE_SIZE
const ADDRESS_BASELINE = CARD_SIZE - PAD - ADDRESS_MAX * 0.25
const FRAME_TOP = INVITE_BASELINE + GAP + INVITE_SIZE * 0.25
const FRAME_SIDE = ADDRESS_BASELINE - ADDRESS_MAX - GAP - FRAME_TOP
const FRAME_LEFT = (CARD_SIZE - FRAME_SIDE) / 2
const QR_SIDE = FRAME_SIDE - FRAME_PAD * 2

export const AddressCard = forwardRef<Svg, Props>(function DrawnCard(
  { address, qrValue, invite, size, label },
  ref,
) {
  const addressSize = cardAddressFontSize(address, CARD_SIZE - PAD * 2, ADDRESS_MAX)
  return (
    <Svg
      ref={ref}
      width={size}
      height={size}
      viewBox={`0 0 ${CARD_SIZE} ${CARD_SIZE}`}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}>
      <Rect x={0} y={0} width={CARD_SIZE} height={CARD_SIZE} fill={colors.background} />
      {/* The mark is the brand orange whatever the wallet's accent, since the card speaks for Voltz. */}
      <G transform={`translate(${(CARD_SIZE - MARK_W) / 2} ${PAD}) scale(${MARK_W / VB_W})`}>
        <G transform={GROUP_TRANSLATE}>
          <Path d={LETTERS_D} fill={colors.primary} />
          <Path d={BOLT_D} fill={colors.primary} />
        </G>
      </G>
      <SvgText
        x={CARD_SIZE / 2}
        y={INVITE_BASELINE}
        fontSize={INVITE_SIZE}
        fontWeight={font.weight.medium}
        fill={colors.textSecondary}
        textAnchor="middle">
        {invite}
      </SvgText>
      <Rect
        x={FRAME_LEFT}
        y={FRAME_TOP}
        width={FRAME_SIDE}
        height={FRAME_SIDE}
        rx={radius.lg * UNIT}
        fill={colors.qrSurface}
      />
      {/* Dark modules on the white frame, which is the quiet zone the screen's code sits in too. */}
      <G transform={`translate(${FRAME_LEFT + FRAME_PAD} ${FRAME_TOP + FRAME_PAD})`}>
        <Path d={cardQrPath(qrValue, QR_SIDE)} fill={colors.background} testID="address-card-qr" />
      </G>
      <SvgText
        x={CARD_SIZE / 2}
        y={ADDRESS_BASELINE}
        fontSize={addressSize}
        fontWeight={font.weight.semibold}
        fill={colors.text}
        textAnchor="middle">
        {address}
      </SvgText>
    </Svg>
  )
})
