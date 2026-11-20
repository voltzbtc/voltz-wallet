import { StyleSheet } from 'react-native'
import { colors, radius, space, touch } from '../theme'

// The QR's side on every receive rail.
export const RECEIVE_QR_SIZE = 180

// Shared by the receive rails, which draw the same picker row, amount link and copy hint.
export const receiveStyles = StyleSheet.create({
  // The app's field shape, since the row is a control that opens a picker rather than a card.
  pickerRow: {
    flexDirection: 'row',
    minHeight: touch.selector,
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceVariant,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  addAmount: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: space.md,
  },
  copyHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  // The floor keeps the ready, loading and failed states of the card the same height.
  card: {
    justifyContent: 'center',
    minHeight: RECEIVE_QR_SIZE + space.lg * 2,
  },
  addressBlock: {
    marginTop: space.md,
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm,
  },
})
