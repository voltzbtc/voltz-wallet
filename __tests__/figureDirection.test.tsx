import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { I18nManager, Text } from 'react-native'
import '../src/i18n'
import { Amount, Figure } from '../src/components/Amount'
import { PriceCard } from '../src/components/PriceCard'
import { holdDirection } from '../src/i18n/direction'
import { formatFiat, setNumberLanguage } from '../src/wallet/fiat'
import { formatSats } from '../src/wallet/amount'

jest.mock('../src/wallet/dollarMode', () => ({ useAccent: () => ({ accent: '#ff7a00' }) }))

const LRI = '⁦'
const PDI = '⁩'
const held = (text: string) => `${LRI}${text}${PDI}`
const MINUS = '−'

afterEach(() => {
  setNumberLanguage('en-US')
  jest.restoreAllMocks()
})

// What a right-to-left paragraph was measured doing with these, through CoreText and through ICU's
// bidi: `R$` read `$R`, and `−5.61%` read `5.61%−`.
describe.each(['ar', 'he', 'ur'])('in %s', language => {
  beforeEach(() => setNumberLanguage(language))

  test('the symbol of the money stays whole, and the digits stay where the language puts them', () => {
    const figure = holdDirection(formatFiat(421_691.66, 'BRL'))
    expect(figure).toContain(held(language === 'ur' ? 'R$421,691.66' : 'R$'))
    expect(figure.replace(/[⁦⁩]/g, '')).toBe(formatFiat(421_691.66, 'BRL'))
  })

  test('a negative amount keeps its minus on the digits', () => {
    expect(holdDirection(formatFiat(-12, 'USD'))).toMatch(language === 'ur' ? /⁦-.*12\.00⁩/ : /⁦-12\.00⁩/)
  })
})

test.each([`${MINUS}5.61%`, '+5.61%', `${MINUS}٥٫٦١%`])('a signed percent holds together: %s', text => {
  expect(holdDirection(text)).toBe(held(text))
})

test.each([
  ['a number alone', '421,691.66'],
  ['sats, whose unit is a word', formatSats(47_112)],
  ['a word in the language', 'لم يُحدَّث مع الشبكة بعد'],
  ['a bare symbol beside its digits', '12.00 $'],
  ['a unit', '0.001 BTC'],
])('leaves alone %s', (_name, text) => {
  expect(holdDirection(text)).toBe(text)
})

test('names a symbol of another script too', () => {
  expect(holdDirection('12.00 р.')).toBe(`12.00 ${held('р.')}`)
})

test('a figure with grouped digits stays whole in a right-to-left paragraph', () => {
  expect(holdDirection('+21\u00A0000')).toBe('\u2066+21\u00A0000\u2069')
})

// i18next holds a money placeholder in a right-to-left language, and Figure holds what it draws, so a
// line such as "≈ R$ 12" passes through both.
test('a figure already held is held once', () => {
  for (const text of [formatFiat(421_691.66, 'BRL'), `${MINUS}5.61%`, '12.00 р.']) {
    expect(holdDirection(holdDirection(text))).toBe(holdDirection(text))
  }
})

describe('Figure', () => {
  const words = (node: React.JSX.Element) => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(node)
    })
    return tree.root.findAllByType(Text).flatMap(text => [text.props.children].flat())
  }

  test('holds its text under a right-to-left layout, in every run of a mixed paragraph', () => {
    jest.replaceProperty(I18nManager, 'isRTL', true)

    expect(words(<Figure>{`${MINUS}5.61%`}</Figure>)).toContain(held(`${MINUS}5.61%`))
    expect(
      words(
        <Figure>
          <Text>R$</Text> 12
        </Figure>,
      ),
    ).toContain(held('R$'))
    expect(words(<Amount value={`${MINUS}5%`} unit="sats" />)).toContain(held(`${MINUS}5%`))
  })

  test('the Bitcoin page holds its change too', () => {
    jest.replaceProperty(I18nManager, 'isRTL', true)
    const points = [
      { t: 0, v: 100 },
      { t: 1, v: 95 },
    ]
    const shown = words(
      <PriceCard
        points={points}
        spot={95}
        currency="BRL"
        name="Bitcoin"
        period="1D"
        onPeriodChange={() => undefined}
        loading={false}
        prefs={{ locale: 'en-US', hour12: false } as never}
      />,
    )

    expect(shown.join(' ')).toContain(`${LRI}${MINUS}5.00`)
  })

  test('keeps a figure i18next already held as it came', () => {
    jest.replaceProperty(I18nManager, 'isRTL', true)
    const line = `≈ ${held('R$12.00')}`

    expect(words(<Figure>{line}</Figure>)).toContain(line)
  })

  test('hands the text on untouched under a left-to-right layout', () => {
    expect(words(<Figure>{`${MINUS}5.61%`}</Figure>)).toContain(`${MINUS}5.61%`)
  })
})
