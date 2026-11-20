import React from 'react'
import Svg, { Circle } from 'react-native-svg'

type Props = {
  size: number
  color: string
  width: number
  // Which share of the ring to draw from its start, for a spinner's head. Whole by default.
  arc?: number
}

// A ring drawn as a shape, for what is a graphic and has no container to outline: a spinner, the pulse
// of the NFC sheet, the received overlay. The stroke sits inside the box, as a view's edge did.
export function Ring({ size, color, width, arc = 1 }: Props): React.JSX.Element {
  const r = (size - width) / 2
  const length = 2 * Math.PI * r
  return (
    <Svg width={size} height={size}>
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth={width}
        fill="none"
        strokeDasharray={arc < 1 ? [length * arc, length] : undefined}
      />
    </Svg>
  )
}
