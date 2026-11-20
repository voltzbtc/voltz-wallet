import React, { useEffect, useState } from 'react'
import {
  Dimensions,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { useTranslation } from 'react-i18next'
import { Row } from './Row'
import { Txt } from './Txt'
import { Skeleton } from './Skeleton'
import { colors, font, radius, space } from '../theme'

type Props = {
  // Null while the parent draws the phrase, which shows `length` placeholders instead.
  words: readonly string[] | null
  length?: number
  style?: StyleProp<ViewStyle>
}

// Three columns need about 380pt of window per unit of font scale. Below that an eight-letter word
// has less room than its own width, so the grid draws two columns rather than squeezing the word.
const THREE_COLUMNS_FROM = 380

// The least a word shrinks to fit its cell, short of the last column. Below its floor the platform
// cuts the word with an ellipsis.
const WORD_FLOOR = 0.6

// "mushroom", the widest English BIP39 word, in em: 5.06 in SF Pro Semibold and 4.85 in Roboto
// SemiBold (CoreText advance widths). 5.5 leaves room for a wider vendor face and pixel rounding.
const WIDEST_WORD_EM = 5.5

// Spacing around the word, named because the column count is worked out from it.
const CELL_PAD = space.xs
const BOX_PAD = space.md
const INDEX_GAP = 'xs'

// The number's floor grows with the type, so the words still line up down a column at one digit or
// two, and a gap follows it, so a number that outgrows the floor pushes the word along rather than
// touching it. Two digits of the caption measure under 18pt per unit of font scale in SF Pro and
// Roboto, Latin, Arabic and Devanagari alike, so the floor is the width the number takes.
export const indexFloor = (fontScale: number): number => space.xl * fontScale

type Columns = 1 | 2 | 3
type CellWidth = '100%' | '50%' | '33.33%'
const SHARE: Record<Columns, { width: CellWidth; fraction: number }> = {
  1: { width: '100%', fraction: 1 },
  2: { width: '50%', fraction: 0.5 },
  3: { width: '33.33%', fraction: 0.3333 },
}

// The most columns whose cells still hold the widest word at its floor, so no seed word is cut at
// any width or text size. A word written down from a cut cell is a word written down wrong. One
// column is the last step, so where even it falls short (a 320pt iPhone at the largest accessibility
// sizes) the floor drops to what the column holds instead.
function layoutFor(
  gridWidth: number,
  windowWidth: number,
  fontScale: number,
): { columns: Columns; floor: number } {
  const widest = WIDEST_WORD_EM * font.size.base * fontScale
  const room = (columns: Columns): number =>
    gridWidth * SHARE[columns].fraction -
    2 * CELL_PAD -
    2 * BOX_PAD -
    indexFloor(fontScale) -
    space[INDEX_GAP]
  const holds = (columns: Columns): boolean => room(columns) >= widest * WORD_FLOOR
  if (windowWidth / fontScale >= THREE_COLUMNS_FROM && holds(3)) {
    return { columns: 3, floor: WORD_FLOOR }
  }
  if (holds(2)) {
    return { columns: 2, floor: WORD_FLOOR }
  }
  return { columns: 1, floor: Math.min(WORD_FLOOR, room(1) / widest) }
}

// The drawn height of one word cell is 12 above, a 24pt line and 12 below. Named because the loading
// grid has to match it exactly, or every word moves when the phrase arrives.
export const WORD_CELL = 2 * space.md + font.leading.base

// Read from Dimensions and kept current, so a font size change in the system settings regroups the
// grid without leaving the screen.
export function useWindow(): { width: number; fontScale: number } {
  const [win, setWin] = useState(() => Dimensions.get('window'))
  useEffect(() => {
    const sub = Dimensions.addEventListener('change', ({ window }) => setWin(window))
    return () => sub.remove()
  }, [])
  return win
}

// The recovery phrase as numbered cells, drawn the same on the backup and the recovery phrase
// screens, since a person checks one sheet of paper against both. iOS cannot block a recording, so
// every caller withholds the words through useScreenCapture; a test reads the source to hold that.
export function SeedWordGrid({ words, length = 12, style }: Props): React.JSX.Element {
  const { i18n } = useTranslation()
  const { width, fontScale } = useWindow()
  // The padded screen's content width, widened by the grid's outset, until the grid has a layout of
  // its own, which then decides, so a caller that insets the grid further still gets columns its
  // words fit.
  const [laidOut, setLaidOut] = useState<number | null>(null)
  const gridWidth = laidOut ?? width - 2 * space.xl + 2 * CELL_PAD
  const { columns, floor } = layoutFor(gridWidth, width, fontScale)
  const cellWidth = SHARE[columns].width
  const indexWidth = indexFloor(fontScale)
  // Formatted here, once, so a locale with its own digits (such as ar-EG) numbers the cells in them.
  const number = new Intl.NumberFormat(i18n.language)

  return (
    <View
      style={[styles.grid, style]}
      onLayout={(event: LayoutChangeEvent) => {
        // A grid laid out at no width is not on screen, and has no columns to decide.
        const measured = event.nativeEvent.layout.width
        if (measured > 0) {
          setLaidOut(measured)
        }
      }}>
      {words
        ? words.map((word, index) => (
            <WordCell
              key={`${index}-${word}`}
              label={number.format(index + 1)}
              word={word}
              width={cellWidth}
              indexWidth={indexWidth}
              floor={floor}
            />
          ))
        : Array.from({ length }).map((_, index) => (
            <View key={index} style={[styles.cell, { width: cellWidth }]}>
              <Skeleton height={WORD_CELL} borderRadius={radius.md} />
            </View>
          ))}
    </View>
  )
}

// Memoised, so a length toggle or a resolving wallet id does not re-render all 24 cells.
const WordCell = React.memo(function Cell({
  label,
  word,
  width,
  indexWidth,
  floor,
}: {
  label: string
  word: string
  width: CellWidth
  indexWidth: number
  floor: number
}): React.JSX.Element {
  return (
    <View style={[styles.cell, { width }]}>
      <Row pad="default" gap={INDEX_GAP} style={styles.wordBox}>
        <Txt role="caption" tone="muted" style={{ minWidth: indexWidth }}>
          {label}
        </Txt>
        {/* One line that shrinks to its box, since a word broken over two lines or cut at the edge
            is a word written down wrong. The column count keeps the floor inside the box. */}
        <Txt
          role="bodyBold"
          lines={1}
          adjustsFontSizeToFit
          minimumFontScale={floor}
          style={styles.word}>
          {word}
        </Txt>
      </Row>
    </View>
  )
})

const styles = StyleSheet.create({
  // Outset by the cells' own padding, so the word boxes, not the cells around them, meet the gutters
  // the content above them keeps.
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -CELL_PAD,
  },
  cell: {
    padding: CELL_PAD,
  },
  wordBox: {
    backgroundColor: colors.surfaceVariant,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    paddingHorizontal: BOX_PAD,
  },
  word: {
    flexShrink: 1,
  },
})
