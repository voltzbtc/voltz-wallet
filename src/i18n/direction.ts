import { I18nManager, Platform, type TextStyle } from 'react-native'

// The light half of the direction rules, imported by every text that sets its leading edge. The
// restart that changes direction lives in directionRestart.ts, so these importers do not load the
// SDK, the settings file or the restart module with it.

// iOS aligns text that has no textAlign by the app bundle's localization rather than by the layout
// direction, so under a forced RTL layout such a label sits on the left, and with an RTL .lproj in the
// bundle a phone set to that language draws an LTR layout's labels on the right. An explicit
// alignment follows the layout instead. Fabric's iOS paragraph swaps left and right under an RTL
// layout, so 'left' is the leading edge in both directions. Android already aligns by the layout.
const LEADING_TEXT: TextStyle = { textAlign: 'left' }

export function leadingText(): TextStyle | undefined {
  return Platform.OS === 'ios' ? LEADING_TEXT : undefined
}

// A TextInput's text attributes carry no layout direction, so iOS swaps nothing there and the leading
// edge under RTL is 'right', for the value and the placeholder alike.
const LEADING_INPUT_LTR: TextStyle = { textAlign: 'left' }
const LEADING_INPUT_RTL: TextStyle = { textAlign: 'right' }

export function leadingInput(): TextStyle | undefined {
  if (Platform.OS !== 'ios') {
    return undefined
  }
  return I18nManager.isRTL ? LEADING_INPUT_RTL : LEADING_INPUT_LTR
}

const LTR_ISOLATE = '\u2066'
const POP_ISOLATE = '\u2069'
const ISOLATE = /[\u2066-\u2069]/
const LETTER = /[A-Za-z\u00C0-\u024F\u0370-\u052F]/
const OTHER_THAN_LETTER = /[^A-Za-z\u00C0-\u024F\u0370-\u052F]/
const DIGIT = /[0-9\u0660-\u0669\u06F0-\u06F9]/
const SIGN_OR_PERCENT = /^[+\-\u2212]|%$/

// What of a run with no space in it the bidi algorithm would take apart in a right-to-left paragraph.
// `R$` splits, since the sign has no direction of its own, and reads `$R`. A sign or a percent is
// neutral beside digits and lands on the far side of them, so `-5.61%` reads `5.61%-`. Bare digits
// and a plain word hold together, and stay out so what reads in order is left alone.
function fallsApart(run: string): boolean {
  return DIGIT.test(run) ? SIGN_OR_PERCENT.test(run) || LETTER.test(run) : LETTER.test(run) && OTHER_THAN_LETTER.test(run)
}

// A figure's money symbols and signed numbers, each held left to right where it stands, so the
// amount keeps the side CLDR gives it in the language and only its pieces stop turning around. An
// isolate rather than the marks CLDR writes around the digits: a left-to-right mark before a minus
// leaves the minus between a strong letter and a number, which the algorithm still resolves to the
// paragraph's direction. Spaces and the marks themselves end a run, except the no-break space that
// groups digits, which stays inside the figure. A run already held is left as it is, so a figure
// that i18next placed and Figure then draws is held once.
export function holdDirection(text: string): string {
  return text.replace(/(?:[^\s\u200E\u200F]|\u00A0(?=[0-9\u0660-\u0669\u06F0-\u06F9]))+/g, run =>
    fallsApart(run) && !ISOLATE.test(run) ? `${LTR_ISOLATE}${run}${POP_ISOLATE}` : run,
  )
}

// The placeholders that carry money in every locale, held where i18next fills them in, so a figure
// placed inside a translated sentence keeps its pieces in a right-to-left paragraph without each call
// site remembering to. By name rather than for every value: a DNS value, a key or a payment reference
// also leaves through Share and mail, where an invisible isolate would break a paste. A value already
// held by its caller is left as it is.
const MONEY_PLACEHOLDERS: ReadonlySet<string> = new Set(['amount', 'price', 'min', 'max', 'fee', 'sats', 'change', 'fiat'])

export function holdMoneyPlaceholder(value: unknown, placeholder: string | undefined, rtl: boolean): unknown {
  if (!rtl || typeof value !== 'string' || placeholder === undefined || !MONEY_PLACEHOLDERS.has(placeholder)) {
    return value
  }
  return ISOLATE.test(value) ? value : holdDirection(value)
}
