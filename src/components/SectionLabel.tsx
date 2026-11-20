import React from 'react'
import { type StyleProp, type TextStyle } from 'react-native'
import { Txt } from './Txt'

type Props = {
  children: React.ReactNode
  // Where the label sits against the card under it, which belongs to the screen.
  style?: StyleProp<TextStyle>
}

// The muted title over a card of rows, such as Home's assets, the asset screen's activity and
// History's days. It starts on the card's edge, as a field's label does, and the space around it
// belongs to the caller, as layout does for every primitive.
export function SectionLabel({ children, style }: Props): React.JSX.Element {
  return (
    <Txt role="section" tone="muted" style={style}>
      {children}
    </Txt>
  )
}
