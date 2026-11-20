import React, { createContext, useContext, useState } from 'react'
// The one module that draws React Native's Text and TextInput directly; every other text and field
// goes through this one.
// eslint-disable-next-line no-restricted-imports
import { StyleSheet, Text as NativeText, TextInput as NativeTextInput, useWindowDimensions } from 'react-native'
import type { NativeSyntheticEvent, TextLayoutEventData } from 'react-native'

const FontScaleContext = createContext(1)

// The system text size, read once at the root and handed down, so a size chosen in the settings
// while the app is open reaches every text without one listener per text.
export function FontScaleProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { fontScale } = useWindowDimensions()
  return <FontScaleContext.Provider value={fontScale}>{children}</FontScaleContext.Provider>
}

export function useFontScale(): number {
  return useContext(FontScaleContext)
}

type TextProps = React.ComponentPropsWithRef<typeof NativeText> & {
  // A label that never breaks inside a word. It wraps at spaces like any text, and a word wider than
  // a whole line on its own makes the label scale itself down until that word fits, never below the
  // default size. For words people
  // read, never for an address or a hash, which can only fit by breaking.
  wholeWords?: boolean
}

// React Native's Text, mounted afresh at each system text size. The native side measures every text
// again when the size changes, but the next commit React makes carries the measurements it holds for
// every text it did not render again, so the old boxes come back around glyphs drawn at the new size
// and the text is cut until the app is reopened. Keyed by the font scale, a text is a new one at each
// size and is measured at the size it draws.
export function Text({ wholeWords = false, ...props }: TextProps): React.JSX.Element {
  const fontScale = useFontScale()
  return wholeWords ? (
    <WholeWordsText key={fontScale} fontScale={fontScale} {...props} />
  ) : (
    <NativeText key={fontScale} {...props} />
  )
}

// What a ref to a field holds.
export type TextInputRef = React.ComponentRef<typeof NativeTextInput>

// The same for a field, which measures its text as a Text does. Remounting a field drops its focus,
// so a size change made while typing closes the keyboard; the value is the caller's state and stays.
export function TextInput(
  props: React.ComponentPropsWithRef<typeof NativeTextInput>,
): React.JSX.Element {
  const fontScale = useFontScale()
  return <NativeTextInput key={fontScale} {...props} />
}

// Characters a line may end on without breaking a word: a space, or the hyphen, dash or slash that a
// line break may follow.
const BREAKABLE = /[\s\u00AD\u2010-\u2014/-]/

// How much of the first word broken across a line fits on its line, as a share of the word, or null
// when every line ends between words. A word is pushed whole to a new line before it is broken, so the
// part that fits is the whole width of a line, and the share is how far the type has to shrink. Lines
// that do not add up to the text are not read, since their ends would not be where the text breaks.
export function brokenWordShare(text: string, lines: readonly string[]): number | null {
  const joined = lines.join('')
  if (joined !== text) {
    return null
  }
  let at = 0
  for (let i = 0; i < lines.length - 1; i += 1) {
    at += lines[i].length
    if (BREAKABLE.test(joined[at - 1] ?? ' ') || BREAKABLE.test(joined[at] ?? ' ')) {
      continue
    }
    let start = at
    while (start > 0 && !BREAKABLE.test(joined[start - 1])) start -= 1
    let end = at
    while (end < joined.length && !BREAKABLE.test(joined[end])) end += 1
    return (at - start) / (end - start)
  }
  return null
}

// A little under the share, since letters are not all one width and the part that fit is not quite a
// full line.
const SHRINK_MARGIN = 0.95

// React Native's default text size, for a label whose style names none.
const DEFAULT_SIZE = 14

function WholeWordsText({
  fontScale,
  maxFontSizeMultiplier,
  onTextLayout,
  style,
  ...props
}: React.ComponentPropsWithRef<typeof NativeText> & { fontScale: number }): React.JSX.Element {
  const text = plainText(props.children)
  // The multiplier the system text size gives the label, and the one it draws at. Neither goes
  // below 1, so a label never shrinks under the default size.
  const own =
    maxFontSizeMultiplier != null && maxFontSizeMultiplier >= 1
      ? Math.min(fontScale, maxFontSizeMultiplier)
      : fontScale
  const [drawn, setDrawn] = useState(own)
  function measured(event: NativeSyntheticEvent<TextLayoutEventData>) {
    onTextLayout?.(event)
    const share =
      text === null
        ? null
        : brokenWordShare(
            text,
            event.nativeEvent.lines.map(line => line.text),
          )
    if (share !== null && drawn > 1) {
      setDrawn(Math.max(1, drawn * share * SHRINK_MARGIN))
    }
  }
  // Shrunk by its size rather than by maxFontSizeMultiplier. The text measure cache tells layouts
  // apart by size and multiplier but not by that cap (TextMeasureCache.h), so a cap alone draws the
  // smaller glyphs in the box measured for the larger ones.
  const flat = StyleSheet.flatten(style) ?? {}
  const shrink = drawn / own
  const smaller = shrink < 1 && {
    fontSize: (flat.fontSize ?? DEFAULT_SIZE) * shrink,
    ...(flat.lineHeight != null && { lineHeight: flat.lineHeight * shrink }),
  }
  return (
    <NativeText
      {...props}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[style, smaller]}
      onTextLayout={measured}
    />
  )
}

// The text of a label written as strings and numbers, or null when it holds a nested run.
function plainText(children: React.ReactNode): string | null {
  const parts = Array.isArray(children) ? children : [children]
  return parts.every(part => typeof part === 'string' || typeof part === 'number')
    ? parts.join('')
    : null
}
