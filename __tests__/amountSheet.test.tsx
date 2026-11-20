import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import {
  AccessibilityInfo,
  Dimensions,
  I18nManager,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput as NoteInput,
  View,
} from 'react-native'
import i18n from '../src/i18n'
import { getCurrencies } from 'react-native-localize'
import { AmountSheet, type TokenBounds } from '../src/components/AmountSheet'
import { GradientButton } from '../src/components/GradientButton'
import { Txt, roles } from '../src/components/Txt'
import { FontScaleProvider } from '../src/components/Text'
import { Touch } from '../src/components/Touch'
import { formatSats, parseAmountSat, parseConvertAmount } from '../src/wallet/amount'
import { configureFiatFormats, fiatSymbol, formatFiat, formatFiatGeneric, setLocalCurrency, type FiatCurrency } from '../src/wallet/fiat'
import { colors, font, radius, space, textScale, touch } from '../src/theme'
import { SegmentedControl } from '../src/components/SegmentedControl'
import { figuresHeldOut, figuresIn, textOf } from './support/figureFit'

// The sheet as every caller but a token's draws it, whose confirm hands on a double.
type SheetProps = Extract<React.ComponentProps<typeof AmountSheet>, { tokenBounds?: undefined }>

jest.mock('react-native-safe-area-context', () => ({
  // A device with a home indicator. With zero, a sheet that forgot the inset would pass.
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}))

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

function button(tree: ReactTestRenderer.ReactTestRenderer, label: string) {
  const found = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === label))
  if (!found) {
    throw new Error(`button not found: ${label}`)
  }
  return found
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    button(tree, label).props.onPress()
  })
}

async function keypad(tree: ReactTestRenderer.ReactTestRenderer, value: string): Promise<void> {
  for (const char of value) {
    await press(tree, char)
  }
}

function renderSheet(
  onConfirm: (v: number | undefined) => void,
  fiat?: { rate: number; currency: FiatCurrency },
  chargeReceiveToggle?: boolean,
) {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <AmountSheet
        visible
        unit="sats"
        allowDecimal={false}
        satsBtcToggle
        chargeReceiveToggle={chargeReceiveToggle}
        fiatRate={fiat?.rate}
        fiatCurrency={fiat?.currency}
        min={1000}
        max={100000}
        initial=""
        parse={parseAmountSat}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    )
  })
  return tree
}

// At R$500,000 per BTC the fiat assertions below read R$50 as 10,000 sats.
const FIAT = { rate: 500000, currency: 'BRL' as FiatCurrency }

test('sats (default): keypad + confirm returns the value in sats', async () => {
  const onConfirm = jest.fn()
  const tree = renderSheet(onConfirm)

  await keypad(tree, '5000')
  await press(tree, 'Confirm')

  expect(onConfirm).toHaveBeenCalledWith(5000, 'sats', undefined)
})

test('BTC: toggles the unit and returns the value converted to sats', async () => {
  const onConfirm = jest.fn()
  const tree = renderSheet(onConfirm)

  await press(tree, 'BTC')
  await keypad(tree, '0.00005')
  await press(tree, 'Confirm')

  expect(onConfirm).toHaveBeenCalledWith(5000, 'btc', undefined)
})

test('the typed value carries over when toggling sats -> BTC', async () => {
  const onConfirm = jest.fn()
  const tree = renderSheet(onConfirm)

  await keypad(tree, '100000')
  await press(tree, 'BTC')

  // The typed amount carries across the unit toggle rather than resetting.
  expect(texts(tree)).toContain('0.001')

  await press(tree, 'Confirm')
  expect(onConfirm).toHaveBeenCalledWith(100000, 'btc', undefined)
})

test('the range shows in the selected unit', async () => {
  const tree = renderSheet(jest.fn())

  expect(texts(tree).some(text => text.includes(formatSats(100000)))).toBe(true)

  await press(tree, 'BTC')

  expect(texts(tree).some(text => text.includes('0.001'))).toBe(true)
  expect(texts(tree).some(text => text.includes('BTC'))).toBe(true)
})

test('fiat: typing in R$ confirms the converted sats at the current rate', async () => {
  const onConfirm = jest.fn()
  const tree = renderSheet(onConfirm, FIAT)

  await press(tree, 'R$')
  await keypad(tree, '50')
  await press(tree, 'Confirm')

  expect(onConfirm).toHaveBeenCalledWith(10000, 'fiat', undefined)
})

test('fiat: shows the live sats conversion while typing fiat', async () => {
  const tree = renderSheet(jest.fn(), FIAT)

  await press(tree, 'R$')
  await keypad(tree, '50')

  expect(texts(tree).some(text => text.includes(formatSats(10000)))).toBe(true)
})

test('sats: shows the live fiat conversion while typing sats', async () => {
  const tree = renderSheet(jest.fn(), FIAT)

  await keypad(tree, '10000')

  expect(texts(tree).some(text => text.includes('R$50.00'))).toBe(true)
})

// The entry is drawn in runs (symbol, digits, symbol), so the paragraph is read whole, in order.
function entryParagraph(tree: ReactTestRenderer.ReactTestRenderer, digits: string): string {
  const paragraph = tree.root
    .findAllByType(Text)
    .find(node => [node.props.children].flat().includes(digits))
  if (!paragraph) {
    throw new Error(`entry not found: ${digits}`)
  }
  return [paragraph.props.children]
    .flat()
    .map(child => {
      if (typeof child === 'string') {
        return child
      }
      return child?.props ? [child.props.children].flat().join('') : ''
    })
    .join('')
}

describe('the fiat entry places the symbol as the app language writes money', () => {
  const USD = { rate: 500_000, currency: 'USD' as FiatCurrency }
  afterEach(async () => {
    await ReactTestRenderer.act(async () => {
      await i18n.changeLanguage('en-US')
    })
  })

  test('English: $ before the digits, with no space', async () => {
    const tree = renderSheet(jest.fn(), USD)
    await press(tree, '$')
    await keypad(tree, '12.5')
    expect(entryParagraph(tree, '12.5')).toBe('$12.5')
  })

  test('Portuguese: US$ before the digits, with a no-break space', async () => {
    await ReactTestRenderer.act(async () => {
      await i18n.changeLanguage('pt-BR')
    })
    const tree = renderSheet(jest.fn(), USD)
    await press(tree, 'US$')
    await keypad(tree, '12,5')
    expect(entryParagraph(tree, '12,5')).toBe('US$\u00a012,5')
  })

  test('German: $ after the digits', async () => {
    await ReactTestRenderer.act(async () => {
      await i18n.changeLanguage('de')
    })
    const tree = renderSheet(jest.fn(), USD)
    await press(tree, '$')
    await keypad(tree, '12')
    expect(entryParagraph(tree, '12')).toBe('12\u00a0$')
  })

  test('a language changed with the sheet open moves the symbol on the next render', async () => {
    const tree = renderSheet(jest.fn(), USD)
    await press(tree, '$')
    await keypad(tree, '12')
    expect(entryParagraph(tree, '12')).toBe('$12')
    await ReactTestRenderer.act(async () => {
      await i18n.changeLanguage('de')
    })
    expect(entryParagraph(tree, '12')).toBe('12\u00a0$')
  })

  // A bare $ is the reader's own dollar, so the entry and its unit button carry it only at home.
  describe('away from a dollar country', () => {
    afterEach(() => {
      // The same read src/i18n made when it loaded, so this puts back what the boot set.
      setLocalCurrency(getCurrencies())
    })

    test('English on an Australian device: US$ before the digits, and on the unit button', async () => {
      setLocalCurrency(['AUD'])
      const tree = renderSheet(jest.fn(), USD)
      await press(tree, 'US$')
      await keypad(tree, '12.5')
      expect(entryParagraph(tree, '12.5')).toBe('US$12.5')
    })

    test('German on a German device: US$ after the digits', async () => {
      setLocalCurrency(['EUR'])
      await ReactTestRenderer.act(async () => {
        await i18n.changeLanguage('de')
      })
      const tree = renderSheet(jest.fn(), USD)
      await press(tree, 'US$')
      await keypad(tree, '12')
      expect(entryParagraph(tree, '12')).toBe('12\u00a0US$')
    })

    test("Mexican Spanish on a Mexican device: the peso's own $ before the digits", async () => {
      setLocalCurrency(['MXN'])
      await ReactTestRenderer.act(async () => {
        await i18n.changeLanguage('es-MX')
      })
      configureFiatFormats([{ id: 'MXN', symbol: '$', fractionSize: 2 }], i18n.language)
      const tree = renderSheet(jest.fn(), { rate: 9_000_000, currency: 'MXN' })
      await press(tree, '$')
      await keypad(tree, '12.5')
      expect(entryParagraph(tree, '12.5')).toBe('$12.5')
    })
  })

  test('sats keep their unit after the figure', async () => {
    const tree = renderSheet(jest.fn(), USD)
    await keypad(tree, '5000')
    expect(entryParagraph(tree, formatSats(5000))).toBe(`${formatSats(5000)}\u00a0sats`)
  })
})

function hasDecimalKey(tree: ReactTestRenderer.ReactTestRenderer): boolean {
  return tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .some(n => n.findAllByType(Text).some(t => t.props.children === '.' || t.props.children === ','))
}

test('a zero-decimal fiat (JPY) offers no decimal key, since the yen has no cents', async () => {
  const tree = renderSheet(jest.fn(), { rate: 15_000_000, currency: 'JPY' as FiatCurrency })
  await press(tree, 'JPY') // switch to fiat entry
  expect(hasDecimalKey(tree)).toBe(false)
})

test('a two-decimal fiat (BRL) offers a decimal key', async () => {
  const tree = renderSheet(jest.fn(), FIAT)
  await press(tree, 'R$')
  expect(hasDecimalKey(tree)).toBe(true)
})

test('charge/receive toggle: returns the selected mode on confirm', async () => {
  const onConfirm = jest.fn()
  const tree = renderSheet(onConfirm, undefined, true)

  await press(tree, 'I receive') // switch away from the default ("They pay")
  await keypad(tree, '5000')
  await press(tree, 'Confirm')

  expect(onConfirm).toHaveBeenCalledWith(5000, 'sats', 'receive')
})

test('charge/receive toggle: defaults to charge when untouched', async () => {
  const onConfirm = jest.fn()
  const tree = renderSheet(onConfirm, undefined, true)

  await keypad(tree, '5000')
  await press(tree, 'Confirm')

  expect(onConfirm).toHaveBeenCalledWith(5000, 'sats', 'charge')
})

test('commentMax > 0: the typed note comes back as the fourth confirm arg', async () => {
  const onConfirm = jest.fn()
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <AmountSheet
        visible
        unit="sats"
        allowDecimal={false}
        satsBtcToggle
        min={1000}
        max={100000}
        commentMax={120}
        initial=""
        parse={parseAmountSat}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    )
  })

  const { TextInput } = require('react-native')
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(TextInput).props.onChangeText('  thanks!  ')
  })
  await keypad(tree, '5000')
  await press(tree, 'Confirm')

  // The note field only exists when commentMax is above 0, and its value arrives trimmed.
  expect(onConfirm).toHaveBeenCalledWith(5000, 'sats', undefined, 'thanks!')
})

test('no comment field when commentMax is 0 or omitted', () => {
  const { TextInput } = require('react-native')
  const tree = renderSheet(jest.fn()) // no commentMax
  expect(tree.root.findAllByType(TextInput)).toHaveLength(0)
})

test('BTC: rejects an out-of-range value without confirming', async () => {
  const onConfirm = jest.fn()
  const tree = renderSheet(onConfirm)

  await press(tree, 'BTC')
  await keypad(tree, '0.5') // 50 000 000 sats, above the 100 000 max
  await press(tree, 'Confirm')

  expect(onConfirm).not.toHaveBeenCalled()
  expect(texts(tree).some(text => text.includes('out of range'))).toBe(true)
})

// A cross-chain route can publish a floor and no ceiling (or the reverse), and a two-sided message
// would then read "1 200 sats to 0 sats".
function renderBounded(
  onConfirm: jest.Mock,
  bounds: { min?: number; max?: number },
  token?: { unit: string; bounds: TokenBounds },
) {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <AmountSheet
        visible
        unit={token?.unit ?? 'sats'}
        allowDecimal={token !== undefined}
        satsBtcToggle={token === undefined}
        {...(token ? { tokenBounds: token.bounds } : { min: bounds.min, max: bounds.max })}
        initial=""
        parse={token ? parseConvertAmount : parseAmountSat}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    )
  })
  return tree
}

// A stablecoin receive bounds the amount in the coin, so every bound reads in the coin and never as
// sats.
test('bounds in a token unit read in that unit', async () => {
  const onConfirm = jest.fn()
  const bounds = { decimals: 6, min: 800_000n, max: 169_200_000_000n }
  const tree = renderBounded(onConfirm, {}, { unit: 'USDT', bounds })

  const hint = texts(tree).join(' ')
  expect(hint).toContain('0.8 USDT')
  expect(hint).toContain(`${formatSats(169_200)} USDT`)
  expect(hint).not.toContain('sats')

  await keypad(tree, '0.5')
  await press(tree, 'Confirm')
  expect(onConfirm).not.toHaveBeenCalled()
  expect(texts(tree).join(' ')).not.toContain('sats')
})

test('a floor alone is named as a minimum, before and after a refused amount', async () => {
  const onConfirm = jest.fn()
  const tree = renderBounded(onConfirm, { min: 1200 })

  expect(texts(tree).join(' ')).toContain(`Minimum ${formatSats(1200)}`)
  await keypad(tree, '1000')
  await press(tree, 'Confirm')

  expect(onConfirm).not.toHaveBeenCalled()
  const shown = texts(tree).join(' ')
  expect(shown).toContain(`The minimum is ${formatSats(1200)}`)
  expect(shown).not.toContain('to 0')
})

test('a ceiling alone is named as a maximum', async () => {
  const onConfirm = jest.fn()
  const tree = renderBounded(onConfirm, { max: 50_000 })

  expect(texts(tree).join(' ')).toContain(`Maximum ${formatSats(50_000)}`)
  await keypad(tree, '60000')
  await press(tree, 'Confirm')

  expect(onConfirm).not.toHaveBeenCalled()
  expect(texts(tree).join(' ')).toContain(`The maximum is ${formatSats(50_000)}`)
})

// A stablecoin has six places, and a seventh typed digit would be refused later with a vaguer message.
test('the keypad stops taking digits past the asset places', async () => {
  const onConfirm = jest.fn()
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <AmountSheet
        visible
        unit="USDT"
        allowDecimal
        maxDecimals={2}
        satsBtcToggle={false}
        initial=""
        parse={parseConvertAmount}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    )
  })

  await keypad(tree, '1.234')
  await press(tree, 'Confirm')

  expect(onConfirm).toHaveBeenCalledWith(1.23, undefined, undefined)
})

// A token with no places counts whole units, so the cap on places never stops a digit before the point.
test('an asset with no places takes whole digits and no point', async () => {
  const onConfirm = jest.fn()
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <AmountSheet
        visible
        unit="WHOLE"
        allowDecimal
        maxDecimals={0}
        satsBtcToggle={false}
        initial=""
        parse={parseConvertAmount}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    )
  })

  await keypad(tree, '12.5')
  await press(tree, 'Confirm')

  expect(onConfirm).toHaveBeenCalledWith(125, undefined, undefined)
})

// The floor itself passes and one under it is refused, so the comparison sits on the bound.
test('a sats floor takes the bound and refuses one under it', async () => {
  const onConfirm = jest.fn()
  const tree = renderBounded(onConfirm, { min: 1200 })

  await keypad(tree, '1199')
  await press(tree, 'Confirm')
  expect(onConfirm).not.toHaveBeenCalled()

  const atFloor = renderBounded(onConfirm, { min: 1200 })
  await keypad(atFloor, '1200')
  await press(atFloor, 'Confirm')
  expect(onConfirm).toHaveBeenCalledWith(1200, 'sats', undefined)
})

// The mark is only drawn; the typed value keeps its dot, so parsing and the confirmed number do not
// depend on the language.
test('in Portuguese the decimal key and the typed amount read a comma', async () => {
  await ReactTestRenderer.act(async () => {
    await i18n.changeLanguage('pt-BR')
  })
  try {
    const onConfirm = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <AmountSheet
          visible
          unit="USDB"
          allowDecimal
          satsBtcToggle={false}
          initial=""
          parse={parseConvertAmount}
          onConfirm={onConfirm}
          onClose={() => {}}
        />,
      )
    })

    await keypad(tree, '1,5')
    expect(texts(tree)).toContain('1,5')
    await press(tree, i18n.t('receive.confirmAmount'))
    expect(onConfirm).toHaveBeenCalledWith(1.5, undefined, undefined)
  } finally {
    await ReactTestRenderer.act(async () => {
      await i18n.changeLanguage('en-US')
    })
  }
})

// Typed reais take the app language's mark, the same one the R$ figures on the sheet use.
test('typing reais in English takes the dot the R$ figures use in English', async () => {
  const tree = renderSheet(jest.fn(), FIAT)
  await press(tree, 'R$')
  await keypad(tree, '50.5')
  expect(texts(tree)).toContain('50.5')
})

test('sats typed in Portuguese keep the no-break space, not the Portuguese dot', async () => {
  await ReactTestRenderer.act(async () => {
    await i18n.changeLanguage('pt-BR')
  })
  try {
    const tree = renderSheet(jest.fn())
    await keypad(tree, '1000')
    expect(texts(tree)).toContain('1\u00a0000')
  } finally {
    await ReactTestRenderer.act(async () => {
      await i18n.changeLanguage('en-US')
    })
  }
})

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(x => x && typeof x === 'object'))

function withNote(onConfirm: (...args: unknown[]) => void = jest.fn()) {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <AmountSheet
        visible
        unit="sats"
        allowDecimal={false}
        satsBtcToggle
        fiatRate={FIAT.rate}
        fiatCurrency={FIAT.currency}
        min={1000}
        max={100000}
        commentMax={120}
        initial=""
        parse={parseAmountSat}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    )
  })
  return tree
}

// Walks up from the key labelled `digit` to its row, then to the keypad that stacks the rows. Each
// level shows up twice in the tree, as the View component and as the native view it renders.
function keypadLevels(tree: ReactTestRenderer.ReactTestRenderer, digit = '1') {
  const up = (from: ReactTestRenderer.ReactTestInstance | null, test: (s: Record<string, unknown>) => boolean) => {
    let node = from
    while (node && !test(flat(node.props.style))) {
      node = node.parent
    }
    return node!
  }
  const label = tree.root.findAll(n => n.type === Text && n.props.children === digit)[0]!
  const row = up(label.parent, st => st.flexDirection === 'row')
  const grid = up(row.parent, st => st.gap === space.sm && st.flexDirection === undefined)
  return { row: flat(row.props.style), grid: flat(grid.props.style) }
}

const panelOf = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(View).find(n => flat(n.props.style).backgroundColor === colors.sheet)!

// The home indicator is 34pt tall, and a fixed 32 of padding would put the bottom of Confirm inside it.
test('Confirm sits above the bottom inset, as in every other sheet', () => {
  const tree = renderSheet(jest.fn())
  const panel = panelOf(tree)
  expect(flat(panel.props.style).paddingBottom).toBe(space.xl + 34)
  expect(panel.findAll(n => n.props.children === 'Confirm' && n.type === Text)).toHaveLength(1)
})

describe('the note field and the keyboard', () => {
  afterEach(() => jest.restoreAllMocks())

  test('avoids the keyboard only when the note field shows', () => {
    expect(renderSheet(jest.fn()).root.findAllByType(KeyboardAvoidingView)).toHaveLength(0)
    expect(withNote().root.findAllByType(KeyboardAvoidingView)).toHaveLength(1)
  })

  // With the note, the unit toggle and the range the sheet is taller than a 667pt screen, so what
  // sits above the keypad scrolls and Confirm stays outside the scroll, always in reach.
  test('scrolls the fields above the keypad and keeps Confirm out of the scroll', () => {
    const tree = withNote()
    const scroll = tree.root.findByType(ScrollView)
    expect(scroll.findAllByType(NoteInput)).toHaveLength(1)
    expect(scroll.findAll(n => n.type === Text && n.props.children === 'Confirm')).toHaveLength(0)
    expect(scroll.findAll(n => n.type === Text && n.props.children === '1')).toHaveLength(0)
  })

  test('lets the key rows shrink towards the touch floor, never below it', () => {
    const { row, grid } = keypadLevels(withNote())
    expect(row.flexShrink).toBe(1)
    expect(row.minHeight).toBe(touch.min)
    expect(grid.flexShrink).toBe(1)
  })

  // Jest cannot lay out a short window, so this reads the floor that holds there: a keypad box that
  // shrinks below its four rows leaves them, held at 44pt, running onto the error line under it.
  test('keeps the keypad box as tall as its four rows at the floor and the gaps between them', () => {
    const { grid } = keypadLevels(withNote())
    expect(grid.minHeight).toBe(4 * touch.min + 3 * space.sm)
  })

  // Yoga takes a shortfall from each child in proportion to flexShrink times basis, and the scroll's
  // basis is all of its content. Jest runs no Yoga, so this applies that rule to the styles: over the
  // keypad's whole give, from rows at full height to its floor, the scroll above it gives up under a
  // pixel even with content taller than any phone.
  test('takes a short window out of the key rows before it cuts the note above them', () => {
    const tree = withNote()
    // A ScrollView shrinks at 1 by its own style when the caller sets nothing.
    const scroll = Number(flat(tree.root.findByType(ScrollView).props.style).flexShrink ?? 1)
    const { row, grid } = keypadLevels(tree)
    const fullRows = 4 * Number(row.flexBasis) + 3 * Number(grid.gap)
    const give = fullRows - Number(grid.minHeight)
    expect(give).toBeGreaterThan(0)
    const content = 2000
    const cut = (give * scroll * content) / (Number(grid.flexShrink) * fullRows)
    expect(cut).toBeLessThan(1 / 3)
    // Past the keypad's floor only the scroll can give way, or Confirm leaves a short screen.
    expect(scroll).toBeGreaterThan(0)
  })

  // iOS announces the keyboard before it moves, Android only once it is up.
  test.each([
    ['ios', 'keyboardWillShow', 'keyboardWillHide'],
    ['android', 'keyboardDidShow', 'keyboardDidHide'],
  ] as const)(
    'steps the keypad aside while the keyboard is up for the note on %s, and brings it back after',
    async (os, show, hide) => {
      const original = Platform.OS
      Platform.OS = os
      try {
        const listeners: Record<string, (() => void)[]> = {}
        const add = Keyboard.addListener.bind(Keyboard)
        jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, listener: () => void) => {
          ;(listeners[event] ??= []).push(listener)
          return add(event as never, listener as never)
        }) as never)
        const fire = (event: string) =>
          ReactTestRenderer.act(async () => (listeners[event] ?? []).forEach(listener => listener()))
        const onConfirm = jest.fn()
        const tree = withNote(onConfirm)
        const keyOne = () => tree.root.findAll(n => n.type === Text && n.props.children === '1')

        expect(keyOne()).toHaveLength(1)
        await fire(show)
        expect(keyOne()).toHaveLength(0)
        expect(tree.root.findAllByType(NoteInput)).toHaveLength(1)
        expect(tree.root.findAll(n => n.type === Text && n.props.children === 'Confirm')).toHaveLength(1)

        await fire(hide)
        expect(keyOne()).toHaveLength(1)

        // Confirm hands back the amount, the unit and the trimmed note, as every case above expects.
        await ReactTestRenderer.act(async () => {
          tree.root.findByType(NoteInput).props.onChangeText(' for lunch ')
        })
        await keypad(tree, '5000')
        await press(tree, 'Confirm')
        expect(onConfirm).toHaveBeenCalledWith(5000, 'sats', undefined, 'for lunch')
      } finally {
        Platform.OS = original
      }
    },
  )

  // On a 667pt screen with the note, the unit toggle and a range, the scroll shows only part of what
  // it holds and the note ends it, so an error inside it is cut off and Confirm seems to do nothing.
  test('shows an amount error beside Confirm and outside the scroll, with the keypad up or aside', async () => {
    const listeners: Record<string, (() => void)[]> = {}
    const add = Keyboard.addListener.bind(Keyboard)
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, listener: () => void) => {
      ;(listeners[event] ??= []).push(listener)
      return add(event as never, listener as never)
    }) as never)
    const tree = withNote()
    const isError = (n: ReactTestRenderer.ReactTestInstance) => n.type === Txt && n.props.tone === 'danger'
    const expectBesideConfirm = () => {
      const errors = tree.root.findAll(isError)
      expect(errors).toHaveLength(1)
      expect(tree.root.findByType(ScrollView).findAll(isError)).toHaveLength(0)
      // The error sits in a line of its own, kept empty, so what counts is what stands after that line.
      const isConfirm = (n: string | ReactTestRenderer.ReactTestInstance) => typeof n === 'object' && n.type === GradientButton
      let line = errors[0]!
      while (line.parent && !line.parent.children.some(isConfirm)) {
        line = line.parent
      }
      const siblings = line.parent!.children
      expect(isConfirm(siblings[siblings.indexOf(line) + 1]!)).toBe(true)
    }

    await keypad(tree, '5')
    await press(tree, 'Confirm')
    expectBesideConfirm()

    await ReactTestRenderer.act(async () => (listeners.keyboardWillShow ?? []).forEach(fire => fire()))
    expect(tree.root.findAll(n => n.type === Text && n.props.children === '1')).toHaveLength(0)
    expectBesideConfirm()
  })
})

// The sheet's pieces come from the shared ones, so it reads like the rest of the app.
describe('built on the shared pieces', () => {
  test('closes from a link-styled Touch that keeps the title\'s height and reaches 44 by slop', async () => {
    const onClose = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <AmountSheet visible unit="sats" allowDecimal={false} initial="" parse={parseAmountSat} onConfirm={jest.fn()} onClose={onClose} />,
      )
    })
    const close = tree.root.findAllByType(Touch).find(n => n.props.label === i18n.t('common.close'))!
    expect(close.props.feedback).toBe('link')
    expect(close.props.size + 2 * close.props.hitSlop).toBeGreaterThanOrEqual(touch.min)
    ReactTestRenderer.act(() => close.props.onPress())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('draws keys with the button radius', () => {
    const key = renderSheet(jest.fn()).root.findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => x.props.children === '5'))!
    const style = typeof key.props.style === 'function' ? key.props.style({ pressed: false }) : key.props.style
    expect(flat(style).borderRadius).toBe(radius.md)
  })

  test('sets the conversion, the range and the error in Txt roles, and keeps the figures on one line', async () => {
    const tree = renderSheet(jest.fn(), FIAT)
    await keypad(tree, '5')
    await press(tree, 'Confirm')
    const roleOf = (text: string) =>
      tree.root.findAllByType(Txt).find(n => [n.props.children].flat().join('').includes(text))?.props.role
    expect(roleOf('≈')).toBe('label')
    expect(roleOf(formatSats(100000))).toBe('caption')
    expect(tree.root.findAllByType(Txt).find(n => n.props.tone === 'danger')?.props.role).toBe('caption')
    // The entry and the conversion under it are both money figures; the range is a sentence.
    const figures = tree.root.findAll(n => n.type === Text && n.props.adjustsFontSizeToFit === true)
    expect(figures.map(n => n.props.numberOfLines)).toEqual([1, 1])
  })

  // Each spacer stands for its line, so the toggle and the note do not move when the line comes.
  test('holds the place of an absent conversion and range at their line heights', () => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <AmountSheet visible unit="sats" allowDecimal={false} satsBtcToggle initial="" parse={parseAmountSat} onConfirm={jest.fn()} onClose={jest.fn()} />,
      )
    })
    const heights = tree.root.findAllByType(View).map(n => flat(n.props.style).height)
    expect(heights).toContain(font.leading.sm + space.sm)
    expect(heights).toContain(font.leading.sm + space.md)
  })

  // A caption's leading grows with the system text size, so a place held at the unscaled leading
  // grows the sheet when its line comes: 2pt at 110%, as the insufficient line did beside Confirm.
  describe('at a larger system text size', () => {
    const start = Dimensions.get('window')
    const setScale = (fontScale: number) => {
      const window = { ...Dimensions.get('window'), fontScale }
      ReactTestRenderer.act(() => {
        Dimensions.set({ window, screen: window })
      })
    }
    afterEach(() => setScale(start.fontScale))

    test.each([1.1, 2])('holds each absent line at the height its caption takes, at %s', async scale => {
      setScale(scale)
      let tree!: ReactTestRenderer.ReactTestRenderer
      ReactTestRenderer.act(() => {
        tree = ReactTestRenderer.create(
          <FontScaleProvider>
            <AmountSheet
              visible
              unit="sats"
              allowDecimal={false}
              satsBtcToggle
              available={5000}
              initial=""
              parse={parseAmountSat}
              onConfirm={jest.fn()}
              onClose={jest.fn()}
            />
          </FontScaleProvider>,
        )
      })
      const line = (roles.caption.lineHeight as number) * scale
      const heights = tree.root.findAllByType(View).map(n => flat(n.props.style).height)
      expect(heights).toContain(line + space.sm)
      expect(heights).toContain(line + space.md)

      await keypad(tree, '5001')
      const error = tree.root.findAll(n => n.type === Txt && n.props.tone === 'danger')
      expect(error).toHaveLength(1)
      expect(error[0]!.props.role).toBe('caption')
      expect(flat(error[0]!.parent!.props.style).minHeight).toBe(line)
    })
  })

  test('runs the unit toggle the full width of the sheet', () => {
    const tree = renderSheet(jest.fn())
    const wrap = tree.root.findAllByType(SegmentedControl).find(n => n.props.value === 'sats')!.parent!
    expect(flat(wrap.props.style).width).toBeUndefined()
    expect(flat(wrap.props.style).alignSelf).toBeUndefined()
  })
})

// The word is "sats" in all 24 locales today, which is why a literal in the markup would go unnoticed
// the day one locale changes it.
describe('the sats word', () => {
  const original = i18n.t('common.sats')
  // The range counts its figures, so its word comes from the counted key rather than common.sats.
  const limit = i18n.getResource(i18n.language, 'translation', 'receive.limitSats_other')
  beforeEach(() => {
    i18n.addResource(i18n.language, 'translation', 'common.sats', 'sat-x')
    i18n.addResource(i18n.language, 'translation', 'receive.limitSats_other', '{{amount}} sat-x')
  })
  afterEach(() => {
    i18n.addResource(i18n.language, 'translation', 'common.sats', original)
    i18n.addResource(i18n.language, 'translation', 'receive.limitSats_other', limit)
  })

  test('comes from the locale in the unit, the toggle and the range, and still groups the entry', async () => {
    const tree = renderSheet(jest.fn())
    await keypad(tree, '50000')
    const shown = texts(tree)
    // The unit beside the figure and the toggle's segment.
    expect(shown.filter(s => s === 'sat-x')).toHaveLength(2)
    expect(shown.some(s => s.includes(`${formatSats(1000)} sat-x`))).toBe(true)
    expect(shown).not.toContain('sats')
    expect(shown).toContain(formatSats(50000))
  })
})

// A phone keypad reads 1 2 3 from the left in Arabic and Hebrew too, and rows that follow the layout
// direction would draw 3 2 1 there.
test('lays the keypad out left to right whatever the language direction', () => {
  expect(keypadLevels(renderSheet(jest.fn())).grid.direction).toBe('ltr')
})


// The key rows shrink to the 44pt floor, and an uncapped 24pt digit at the largest text size would be
// three times taller than that.
test('caps the keypad digits so they fit a key at its floor', () => {
  const tree = renderSheet(() => {})
  const digits = '0123456789'
    .split('')
    .map(d => button(tree, d).findAllByType(Text).find(node => node.props.children === d)!)
  for (const digit of digits) {
    expect(digit.props.maxFontSizeMultiplier).toBe(textScale.keypadMax)
    const size = Number(Object.assign({}, ...[digit.props.style].flat(Infinity).filter(Boolean)).fontSize)
    // A line of system type is about 1.2 times its size; 1.25 leaves room for either platform's face.
    expect(size * textScale.keypadMax * 1.25).toBeLessThanOrEqual(touch.min)
  }
})

// A range that starts at one read "Between 1 sats and 100 000 sats". Counted, the figure takes its
// word in the singular where the language has one, and the word stays on the figure's line.
test('counts the sats in the range, so a limit of one reads in the singular', () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <AmountSheet
        visible
        unit="sats"
        allowDecimal={false}
        satsBtcToggle
        min={1}
        max={100000}
        initial=""
        parse={parseAmountSat}
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    )
  })
  const range = texts(tree).find(text => text.startsWith('Between'))
  expect(range).toBe(`Between 1\u00a0sat and ${formatSats(100000)}\u00a0sats`)
})

// A title that keeps its width takes the whole row at the largest text size and pushes the close
// mark out of the sheet, so the title wraps beside a close mark that keeps its place.
test('the title gives way to the close mark rather than pushing it out', () => {
  const tree = renderSheet(() => {})
  const title = tree.root.findAllByType(Txt).find(n => n.props.children === i18n.t('receive.amountTitle'))!
  expect(StyleSheet.flatten(title.props.style).flexShrink).toBe(1)
  const row = StyleSheet.flatten(title.parent!.props.style)
  expect([row.flexDirection, row.gap]).toEqual(['row', space.md])
})

// A unit drawn beside the entry keeps its width and takes the entry's room at the largest text
// size, so the two are one paragraph, as in Amount, and shrink together without parting.
test('draws the entry and its unit as one figure that shrinks as a whole', async () => {
  const tree = renderSheet(() => undefined)
  await keypad(tree, '17920')
  const entry = figuresIn(tree.root).find(figure => textOf(figure).endsWith(' sats'))
  expect(entry && textOf(entry)).toBe(`${formatSats(17_920)} sats`)
  expect(figuresHeldOut(tree.root)).toEqual([])
})

describe('what is available', () => {
  const sheet = (props: Partial<SheetProps>) => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <AmountSheet
          visible
          unit="sats"
          allowDecimal={false}
          satsBtcToggle
          initial=""
          parse={parseAmountSat}
          onConfirm={jest.fn()}
          onClose={() => {}}
          {...props}
        />,
      )
    })
    return tree
  }
  const OVER = 'Not enough balance to complete.'
  const confirm = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(GradientButton)

  test('nothing given, no line, no lock', async () => {
    const onConfirm = jest.fn()
    const tree = sheet({ onConfirm })
    await keypad(tree, '999999')
    await press(tree, 'Confirm')

    expect(texts(tree).join(' ')).not.toContain('Available')
    expect(onConfirm).toHaveBeenCalled()
  })

  test('past it, says so as it is typed, and Confirm does nothing', async () => {
    const onConfirm = jest.fn()
    const tree = sheet({ available: 5000, onConfirm })
    expect(texts(tree).join(' ')).toContain('Available')
    await keypad(tree, '5001')

    expect(texts(tree).join(' ')).toContain(OVER)
    expect(confirm(tree).props.disabled).toBe(true)
    await ReactTestRenderer.act(async () => confirm(tree).props.onPress())
    expect(onConfirm).not.toHaveBeenCalled()
  })

  test('a screen reader hears it once as it appears, not on each digit after', async () => {
    const heard = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined)
    heard.mockClear()
    const tree = sheet({ available: 5000 })
    await keypad(tree, '500')
    expect(heard).not.toHaveBeenCalled()

    await keypad(tree, '10')
    expect(heard.mock.calls).toEqual([[OVER]])
    heard.mockRestore()
  })

  test('a closed sheet says nothing when the balance drops under the amount it kept', async () => {
    const heard = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined)
    heard.mockClear()
    const drawn = (visible: boolean, available: number) => (
      <AmountSheet
        visible={visible}
        unit="sats"
        allowDecimal={false}
        satsBtcToggle
        initial=""
        parse={parseAmountSat}
        onConfirm={jest.fn()}
        onClose={() => {}}
        available={available}
      />
    )
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(drawn(true, 5000))
    })
    await keypad(tree, '500')
    ReactTestRenderer.act(() => tree.update(drawn(false, 5000)))
    ReactTestRenderer.act(() => tree.update(drawn(false, 100)))

    expect(heard).not.toHaveBeenCalled()
    heard.mockRestore()
  })

  test('exactly it passes', async () => {
    const tree = sheet({ available: 5000 })
    await keypad(tree, '5000')
    expect(texts(tree).join(' ')).not.toContain(OVER)
    expect(confirm(tree).props.disabled).toBe(false)
  })

  test('BTC compares in sats', async () => {
    const tree = sheet({ available: 50_000 })
    await press(tree, 'BTC')
    await keypad(tree, '0.0006')
    expect(texts(tree).join(' ')).toContain(OVER)
  })

  test('a one sat minimum in money is not stated as zero', async () => {
    const tree = sheet({ min: 1, max: 1_000_000, fiatRate: FIAT.rate, fiatCurrency: FIAT.currency })
    await press(tree, 'R$')

    const range = i18n.t('receive.range', {
      min: formatFiatGeneric(0.005, fiatSymbol('BRL'), 3),
      max: formatFiat(5_000, 'BRL'),
    })
    expect(texts(tree)).toContain(range)
  })

  // 247 sats at the test rate are R$ 1.235: typed back, the minimum drawn must still be enough and the
  // maximum drawn must still fit.
  test('a minimum in money is drawn at or above itself, a maximum at or below', async () => {
    const tree = sheet({ min: 247, max: 1_000_000, fiatRate: FIAT.rate, fiatCurrency: FIAT.currency })
    await press(tree, 'R$')
    expect(texts(tree)).toContain(i18n.t('receive.range', { min: formatFiat(1.24, 'BRL'), max: formatFiat(5_000, 'BRL') }))

    const capped = sheet({ min: 1, max: 247, fiatRate: FIAT.rate, fiatCurrency: FIAT.currency })
    await press(capped, 'R$')
    expect(texts(capped).join(' ')).toContain(formatFiat(1.23, 'BRL'))
    expect(texts(capped).join(' ')).not.toContain(formatFiat(1.24, 'BRL'))
  })

  // A fixed amount of R$ 1.235 has no cent figure that fits it, so the range names one figure, never
  // an end above the other.
  test('a range inside one cent reads one figure, never crossed', async () => {
    const tree = sheet({ min: 247, max: 247, fiatRate: FIAT.rate, fiatCurrency: FIAT.currency })
    await press(tree, 'R$')

    const one = formatFiat(1.23, 'BRL')
    expect(texts(tree)).toContain(i18n.t('receive.range', { min: one, max: one }))
  })

  test('in a right-to-left language the money in that sentence holds its direction', async () => {
    jest.replaceProperty(I18nManager, 'isRTL', true)
    const tree = sheet({ min: 1, max: 1_000_000, fiatRate: FIAT.rate, fiatCurrency: FIAT.currency })
    await press(tree, 'R$')

    expect(texts(tree).join(' ')).toContain('\u2066R$0.005\u2069')
    jest.restoreAllMocks()
  })

  test('money compares in sats, at the rate shown', async () => {
    const tree = sheet({ available: 5_000, fiatRate: FIAT.rate, fiatCurrency: FIAT.currency })
    await press(tree, 'R$')
    await keypad(tree, '50')
    expect(texts(tree).join(' ')).toContain(OVER)
  })

  test('a token compares in its own unit, keeping its places', async () => {
    const tree = sheet({
      available: 1.23456789,
      satsBtcToggle: false,
      unit: 'DEPIX',
      allowDecimal: true,
      parse: parseConvertAmount,
    })
    expect(texts(tree).join(' ')).toContain('1.23456789 DEPIX')
    await keypad(tree, '1.24')
    expect(texts(tree).join(' ')).toContain(OVER)
  })

  test('a token with more places than drawn cuts its figure, so typing it never passes the balance', () => {
    const tree = sheet({
      available: 1.234567899,
      satsBtcToggle: false,
      unit: 'USDT',
      allowDecimal: true,
      parse: parseConvertAmount,
    })
    expect(texts(tree).join(' ')).toContain('1.23456789 USDT')
  })

  test('the chip appears only when offered', async () => {
    const onUseAll = jest.fn()
    expect(texts(sheet({ available: 5000 })).join(' ')).not.toContain('Use all')

    const tree = sheet({ available: 5000, onUseAll })
    await press(tree, 'Use all')
    expect(onUseAll).toHaveBeenCalledTimes(1)
  })
})

describe('a sheet asked to open in a currency', () => {
  const baseProps = {
    visible: true,
    unit: 'sats',
    allowDecimal: false,
    satsBtcToggle: true,
    initial: '',
    parse: parseAmountSat,
    onConfirm: jest.fn(),
    onClose: jest.fn(),
  }
  const mount = async (props: object): Promise<ReactTestRenderer.ReactTestRenderer> => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<AmountSheet {...baseProps} {...props} />)
    })
    return tree
  }
  const unit = (tree: ReactTestRenderer.ReactTestRenderer): unknown =>
    tree.root.findByType(SegmentedControl<string>).props.value

  test('opens there and still confirms in sats', async () => {
    const onConfirm = jest.fn()
    const tree = await mount({ fiatRate: 100_000, fiatCurrency: 'USD', initialDenom: 'fiat', onConfirm })
    expect(unit(tree)).toBe('fiat')

    await press(tree, '1')
    await press(tree, '0')
    await press(tree, i18n.t('receive.confirmAmount'))

    expect(onConfirm).toHaveBeenCalledWith(10_000, 'fiat', undefined)
  })

  test('with no rate it opens in sats and works', async () => {
    const onConfirm = jest.fn()
    const tree = await mount({ fiatCurrency: 'USD', initialDenom: 'fiat', onConfirm })
    expect(unit(tree)).toBe('sats')

    await press(tree, '5')
    await press(tree, i18n.t('receive.confirmAmount'))

    expect(onConfirm).toHaveBeenCalledWith(5, 'sats', undefined)
  })

  test('a rate that lands with the sheet open changes neither the unit nor what was typed', async () => {
    const tree = await mount({ fiatCurrency: 'USD', initialDenom: 'fiat' })
    await press(tree, '5')

    await ReactTestRenderer.act(async () => {
      tree.update(<AmountSheet {...baseProps} fiatRate={100_000} fiatCurrency="USD" initialDenom="fiat" />)
    })

    expect(unit(tree)).toBe('sats')
    expect(texts(tree).join(' ')).toContain('5')
  })

  test('a kept amount, which is in sats, reads in the unit it opens in', async () => {
    const tree = await mount({ fiatRate: 100_000, fiatCurrency: 'USD', initialDenom: 'fiat', initial: '12300' })

    expect(texts(tree).join(' ')).toContain('12.3')
    expect(texts(tree).join(' ')).not.toContain('12300')
  })
})

// A send funded with USDB: dollars typed as dollars, with no rate behind them and no sats anywhere.
describe('dollars typed as dollars', () => {
  function renderDollars(onConfirm: (v: number | undefined) => void, min?: number, unit = 'USDB') {
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <AmountSheet
          visible
          unit={unit}
          dollars
          allowDecimal
          maxDecimals={2}
          min={min}
          initial=""
          parse={parseConvertAmount}
          onConfirm={onConfirm}
          onClose={() => undefined}
        />,
      )
    })
    return tree
  }

  test('the figure carries the dollar sign, and what comes back is dollars', async () => {
    const onConfirm = jest.fn()
    const tree = renderDollars(onConfirm)

    await keypad(tree, '12.5')
    expect(texts(tree)).toContain('$')
    expect(texts(tree).join(' ')).not.toContain('sats')
    await press(tree, i18n.t('receive.confirmAmount'))

    expect(onConfirm).toHaveBeenCalledWith(12.5, undefined, undefined)
  })

  test.each([
    ['12.49', '12.49'],
    ['12.5', '12.5'],
    ['0.2', '0.2'],
    ['.75', '0.75'],
  ])('%s draws what the SDK is asked for, never a rounded dollar', async (typed, drawn) => {
    for (const unit of ['USDB', 'sats']) {
      const tree = renderDollars(jest.fn(), undefined, unit)

      await keypad(tree, typed)

      expect(texts(tree)).toContain(drawn)
    }
  })

  test('takes no third decimal', async () => {
    const onConfirm = jest.fn()
    const tree = renderDollars(onConfirm)

    await keypad(tree, '1.239')
    await press(tree, i18n.t('receive.confirmAmount'))

    expect(onConfirm).toHaveBeenCalledWith(1.23, undefined, undefined)
  })

  test('a dollar minimum is drawn at or above itself', async () => {
    const tree = renderDollars(jest.fn(), 1.234)

    expect(texts(tree).join(' ')).toContain('$1.24')
    expect(texts(tree).join(' ')).not.toContain('$1.23')
  })

  test('a limit reads in dollars', async () => {
    const tree = renderDollars(jest.fn(), 2)

    expect(texts(tree).join(' ')).toContain('$2.00')
  })
})

// A token can call itself anything, and the sheet groups as sats only what can only be whole.
describe('a token called sats', () => {
  function renderToken(available?: bigint, min?: bigint) {
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <AmountSheet
          visible
          unit="sats"
          allowDecimal
          maxDecimals={6}
          tokenBounds={{ decimals: 6, min, available }}
          initial=""
          parse={parseConvertAmount}
          onConfirm={() => undefined}
          onClose={() => undefined}
        />,
      )
    })
    return tree
  }

  test('keeps the digits typed', async () => {
    const tree = renderToken()

    await keypad(tree, '12.49')

    expect(texts(tree)).toContain('12.49')
  })

  test('keeps the figures of its balance and its limit', () => {
    const tree = renderToken(1_500_000n, 250_000n)

    expect(texts(tree).join(' ')).toContain('1.5 sats')
    expect(texts(tree).join(' ')).toContain('0.25 sats')
  })
})

// The real callers' shapes, so the sheet's figure is checked as each of them draws it.
describe('every caller keeps the figure typed', () => {
  async function drawn(props: Partial<SheetProps>, typed: string) {
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <AmountSheet
          visible
          unit="sats"
          allowDecimal={false}
          initial=""
          parse={parseConvertAmount}
          onConfirm={() => undefined}
          onClose={() => undefined}
          {...props}
        />,
      )
    })
    await keypad(tree, typed)
    return texts(tree)
  }

  test.each([
    ['Send, a token', { unit: 'USDB', allowDecimal: true }, '12.49', '12.49'],
    ['Send, a dollar wallet in USDB', { unit: 'USDB', dollars: true, allowDecimal: true, maxDecimals: 2 }, '12.49', '12.49'],
    ['Receive, a token', { unit: 'BRLA', allowDecimal: true }, '12.49', '12.49'],
    ['Convert, a token', { unit: 'DePix', allowDecimal: true }, '12.49', '12.49'],
    ['Stable receive, a route', { unit: 'USDT', allowDecimal: true, maxDecimals: 6 }, '12.49', '12.49'],
    ['Send, Receive and Redeem, sats', { unit: 'sats', satsBtcToggle: true, parse: parseAmountSat }, '12345', formatSats(12_345)],
    ['Convert, bitcoin', { unit: 'sats', allowDecimal: false, parse: parseAmountSat }, '12345', formatSats(12_345)],
  ])('%s', async (_caller, props, typed, figure) => {
    expect(await drawn(props, typed)).toContain(figure)
  })
})

// A token holds up to 18 places, so a bound one base unit past a cent must not be drawn on that
// cent: typed back, a minimum drawn below itself is refused by the route, and a maximum drawn above
// itself passes it. A double carries such a bound only to about 15 digits, so at 18 places it is
// compared and drawn on integers.
describe("a token's bound drawn on its own side", () => {
  const render = (
    bounds: TokenBounds,
    unit = 'DEPIX',
    onConfirm: (base: bigint | undefined) => void = () => undefined,
  ) => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <AmountSheet
          visible
          unit={unit}
          allowDecimal
          maxDecimals={bounds.decimals}
          tokenBounds={bounds}
          initial=""
          parse={parseConvertAmount}
          onConfirm={onConfirm}
          onClose={() => undefined}
        />,
      )
    })
    return tree
  }
  const hint = (bounds: TokenBounds, unit?: string) => texts(render(bounds, unit)).join(' ')
  // The same figure at 6, 8 and 18 places: a cent plus or minus one base unit.
  const at = (decimals: number, cents: bigint, units = 0n) =>
    cents * 10n ** BigInt(decimals - 2) + units

  const PLACES = [6, 8, 18]

  test.each(PLACES)('at %i places a floor a base unit past a cent rounds up', decimals => {
    expect(hint({ decimals, min: at(decimals, 123n, 1n) })).toContain('Minimum 1.24 DEPIX')
  })

  test.each(PLACES)('at %i places a ceiling a base unit short of a cent rounds down', decimals => {
    expect(hint({ decimals, max: at(decimals, 123n, -1n) })).toContain('Maximum 1.22 DEPIX')
  })

  test('a bound on the cent stays on it', () => {
    expect(hint({ decimals: 8, min: 123_000_000n })).toContain('Minimum 1.23 DEPIX')
    expect(hint({ decimals: 8, max: 29_000_000n })).toContain('Maximum 0.29 DEPIX')
    expect(hint({ decimals: 18, min: at(18, 123n) })).toContain('Minimum 1.23 DEPIX')
  })

  // USDB and DePix read as they always have: two places at most, trailing zeros dropped, grouped.
  test('USDB and DePix keep their figures', () => {
    expect(hint({ decimals: 6, min: 5_000_000n, max: 169_200_500_000n }, 'USDB')).toContain(
      `Between 5 USDB and ${formatSats(169_200)}.5 USDB`,
    )
    expect(hint({ decimals: 8, min: 80_000_000n }, 'DEPIX')).toContain('Minimum 0.8 DEPIX')
  })

  test('a bound past what a double holds is grouped from its digits', () => {
    expect(hint({ decimals: 0, max: 18_446_744_073_709_551_615n }, 'TKN')).toContain(
      'Maximum 18\u00a0446\u00a0744\u00a0073\u00a0709\u00a0551\u00a0615 TKN',
    )
  })

  test('the bound takes the language decimal mark', async () => {
    await ReactTestRenderer.act(async () => {
      await i18n.changeLanguage('pt-BR')
    })
    try {
      expect(hint({ decimals: 6, min: 1_230_001n }, 'USDB')).toContain(
        i18n.t('receive.minHint', { min: '1,24 USDB' }),
      )
    } finally {
      await ReactTestRenderer.act(async () => {
        await i18n.changeLanguage('en-US')
      })
    }
  })

  // No two-place figure lies in a range inside one cent, so its ends take the places that hold one.
  test('a range inside one cent reads at the places that fit it, never past either end', () => {
    expect(hint({ decimals: 6, min: 1_231_000n, max: 1_239_000n })).toContain(
      'Between 1.231 DEPIX and 1.239 DEPIX',
    )
    expect(hint({ decimals: 18, min: at(18, 123n, 1n), max: at(18, 123n, 2n) })).toContain(
      'Between 1.230000000000000001 DEPIX and 1.230000000000000002 DEPIX',
    )
  })

  // The figure drawn is the one a person types back, so it must pass, and one drawn step past it
  // must not, at every number of places the token can hold.
  test.each(PLACES)('at %i places the floor drawn passes, a cent under it not', async decimals => {
    for (const [typed, passes] of [['1.24', true], ['1.23', false]] as const) {
      const onConfirm = jest.fn()
      const tree = render({ decimals, min: at(decimals, 123n, 1n) }, 'USDC', onConfirm)
      await keypad(tree, typed)
      await press(tree, 'Confirm')
      expect(onConfirm.mock.calls.length).toBe(passes ? 1 : 0)
      if (!passes) {
        expect(texts(tree).join(' ')).toContain('The minimum is 1.24 USDC')
      }
    }
  })

  test.each(PLACES)('at %i places the ceiling drawn passes, a cent over it not', async decimals => {
    for (const [typed, passes] of [['1.22', true], ['1.23', false]] as const) {
      const onConfirm = jest.fn()
      const tree = render({ decimals, max: at(decimals, 123n, -1n) }, 'USDC', onConfirm)
      await keypad(tree, typed)
      await press(tree, 'Confirm')
      expect(onConfirm.mock.calls.length).toBe(passes ? 1 : 0)
      if (!passes) {
        expect(texts(tree).join(' ')).toContain('The maximum is 1.22 USDC')
      }
    }
  })

  // A double reads 5.000000000000000001 as 5, so 5 would pass a floor the route refuses it under.
  test('at 18 places a figure under the floor is refused, which a double calls equal', async () => {
    const onConfirm = jest.fn()
    const tree = render({ decimals: 18, min: 5_000_000_000_000_000_001n }, 'USDC', onConfirm)
    expect(texts(tree).join(' ')).toContain('Minimum 5.01 USDC')
    await keypad(tree, '5')
    await press(tree, 'Confirm')
    expect(onConfirm).not.toHaveBeenCalled()
  })

  // A whole dollar is a drawn step, so a bound on one is typed exactly as drawn and must pass, while
  // the figure a step past it must not.
  test.each(PLACES)('at %i places a bound on a whole dollar passes typed as drawn', async decimals => {
    const whole = (dollars: bigint) => dollars * 10n ** BigInt(decimals)
    const cases: [TokenBounds, string, string, bigint | null][] = [
      [{ decimals, min: whole(1n) }, 'Minimum 1 USDC', '1', whole(1n)],
      [{ decimals, min: whole(1n) }, 'Minimum 1 USDC', '0.99', null],
      [{ decimals, min: whole(5n) }, 'Minimum 5 USDC', '5', whole(5n)],
      [{ decimals, min: whole(5n) }, 'Minimum 5 USDC', '4.99', null],
      [{ decimals, max: whole(2n) }, 'Maximum 2 USDC', '2', whole(2n)],
      [{ decimals, max: whole(2n) }, 'Maximum 2 USDC', '2.01', null],
    ]
    for (const [bounds, drawn, typed, handed] of cases) {
      const onConfirm = jest.fn()
      const tree = render(bounds, 'USDC', onConfirm)
      expect(texts(tree).join(' ')).toContain(drawn)
      await keypad(tree, typed)
      await press(tree, 'Confirm')
      if (handed === null) {
        expect(onConfirm).not.toHaveBeenCalled()
      } else {
        expect(onConfirm.mock.calls).toEqual([[handed]])
      }
    }
  })

  // The caller gets the base units typed, which a double would cut at 18 places or write as "1e-7".
  test.each([
    [18, '5.000000000000000001', 5_000_000_000_000_000_001n],
    [18, '0.0000001', 100_000_000_000n],
    [18, '123456789.123456789123456789', 123_456_789_123_456_789_123_456_789n],
    [6, '12.49', 12_490_000n],
  ])('at %i places %s reaches the caller as its base units', async (decimals, typed, base) => {
    const onConfirm = jest.fn()
    const tree = render({ decimals, min: 1n }, 'USDC', onConfirm)
    await keypad(tree, typed)
    await press(tree, 'Confirm')
    expect(onConfirm.mock.calls).toEqual([[base]])
  })

  // The keypad writes a first dot as "0.", which is what keeps a bare leading dot out of the entry.
  test('a dot typed first reaches the caller as a whole figure', async () => {
    const onConfirm = jest.fn()
    const tree = render({ decimals: 6 }, 'USDC', onConfirm)
    await keypad(tree, '.5')
    expect(texts(tree)).toContain('0.5')
    await press(tree, 'Confirm')
    expect(onConfirm.mock.calls).toEqual([[500_000n]])
  })

  test('an empty entry clears a token amount', async () => {
    const onConfirm = jest.fn()
    const tree = render({ decimals: 18 }, 'USDC', onConfirm)
    await press(tree, 'Confirm')
    expect(onConfirm.mock.calls).toEqual([[undefined]])
  })

  // A figure handed in with more places than the token holds has no base units to compare.
  test('a figure the token cannot hold is refused as invalid, not let through', async () => {
    const onConfirm = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <AmountSheet
          visible
          unit="USDC"
          allowDecimal
          tokenBounds={{ decimals: 6, max: 2_000_000n }}
          initial="1.1234567"
          parse={parseConvertAmount}
          onConfirm={onConfirm}
          onClose={() => undefined}
        />,
      )
    })
    await press(tree, 'Confirm')
    expect(onConfirm).not.toHaveBeenCalled()
    expect(texts(tree).join(' ')).toContain(i18n.t('receive.invalidAmount'))
  })
})

// A double carries about 15 significant digits, so 1.000000000000000001 at 18 places would be read as
// 1 and its last base unit lost. A token's figure, balance and bounds are integers end to end.
describe("a token's figure in base units", () => {
  const render = (bounds: TokenBounds, onConfirm: (base: bigint | undefined) => void = () => undefined) => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <AmountSheet
          visible
          unit="TKN"
          allowDecimal={bounds.decimals > 0}
          tokenBounds={bounds}
          initial=""
          parse={parseConvertAmount}
          onConfirm={onConfirm}
          onClose={() => undefined}
        />,
      )
    })
    return tree
  }
  const OVER = 'Not enough balance to complete.'

  test.each([
    [0, '12', 12n],
    [2, '1.01', 101n],
    [6, '1.000001', 1_000_001n],
    [8, '1.00000001', 100_000_001n],
    [18, '1.000000000000000001', 1_000_000_000_000_000_001n],
  ])('at %i places hands on exactly the base units typed', async (decimals, typed, base) => {
    const onConfirm = jest.fn()
    const tree = render({ decimals }, onConfirm)
    await keypad(tree, typed)
    await press(tree, 'Confirm')
    expect(onConfirm).toHaveBeenCalledWith(base)
  })

  test('takes no digit past its places when the caller names none', async () => {
    const onConfirm = jest.fn()
    const tree = render({ decimals: 2 }, onConfirm)
    await keypad(tree, '1.234')
    await press(tree, 'Confirm')
    expect(onConfirm).toHaveBeenCalledWith(123n)
  })

  test('one base unit past the balance at 18 places is over it', async () => {
    const onConfirm = jest.fn()
    const tree = render({ decimals: 18, available: 1_000_000_000_000_000_000n }, onConfirm)
    expect(texts(tree).join(' ')).toContain('1 TKN')
    await keypad(tree, '1.000000000000000001')
    expect(texts(tree).join(' ')).toContain(OVER)
    expect(tree.root.findByType(GradientButton).props.disabled).toBe(true)
    await ReactTestRenderer.act(async () => tree.root.findByType(GradientButton).props.onPress())
    expect(onConfirm).not.toHaveBeenCalled()
  })

  test('the whole balance at 18 places passes', async () => {
    const onConfirm = jest.fn()
    const tree = render({ decimals: 18, available: 1_000_000_000_000_000_001n }, onConfirm)
    await keypad(tree, '1.000000000000000001')
    expect(texts(tree).join(' ')).not.toContain(OVER)
    await press(tree, 'Confirm')
    expect(onConfirm).toHaveBeenCalledWith(1_000_000_000_000_000_001n)
  })

  test('the balance is cut at eight places, never rounded up', () => {
    const tree = render({ decimals: 18, available: 1_234_567_899_999_999_999n })
    expect(texts(tree).join(' ')).toContain('1.23456789 TKN')
  })

  test('one base unit under the floor at 18 places is refused, the floor passes', async () => {
    const onConfirm = jest.fn()
    const min = 1_000_000_000_000_000_001n
    const tree = render({ decimals: 18, min }, onConfirm)
    await keypad(tree, '1')
    await press(tree, 'Confirm')
    expect(onConfirm).not.toHaveBeenCalled()

    const atFloor = render({ decimals: 18, min }, onConfirm)
    await keypad(atFloor, '1.000000000000000001')
    await press(atFloor, 'Confirm')
    expect(onConfirm).toHaveBeenCalledWith(min)
  })
})
