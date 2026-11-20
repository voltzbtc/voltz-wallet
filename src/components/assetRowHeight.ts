import { font, space } from '../theme'

const ROW_HEIGHT = 60
// A stacked row holds a name of up to two lines over its figure, each line at the body leading, which
// the platform scales with the text size as it does the type.
export const NAME_LINES = 2

// Every row is as tall as the tallest, since the drag moves rows by whole slots. Side by side that is
// the fixed 60; stacked it is the name's two lines and the figure's one, at the current text size.
export function assetRowHeight(sideBySide: boolean, fontScale: number): number {
  return sideBySide
    ? ROW_HEIGHT
    : 2 * space.md + space.xs + (NAME_LINES + 1) * font.leading.base * fontScale
}
