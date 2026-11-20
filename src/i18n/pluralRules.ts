// Hermes ships Intl without PluralRules, and i18next then applies English's rule to every language,
// `one` for 1 and `other` for anything else, so Russian writes 12 and 24 with the same form and no
// locale's zero, two, few or many form is ever picked. These are CLDR's cardinal rules for the
// languages the app ships, installed only where the engine has none, and pluralRules.test.ts holds
// them to ICU for every shipped locale, so a device picks the form the suite measures.

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

// CLDR's operands: n is the absolute value, i its integer part and v the number of fraction digits
// shown, which ICU's default format caps at three. A JavaScript number keeps no trailing zeros, so
// n equals i exactly when v is 0.
type Operands = { n: number; i: number; v: number }
type Rule = { categories: PluralCategory[]; select: (o: Operands) => PluralCategory }

// From 1e21 up toFixed answers in exponent form, with no fraction part to split off.
function operands(count: number): Operands {
  const fixed = Math.abs(count).toFixed(3)
  const [int, fraction = ''] = fixed.split('.')
  return { n: Number(fixed), i: Number(int), v: fraction.replace(/0+$/, '').length }
}

const inRange = (x: number, low: number, high: number) => x >= low && x <= high
const roundMillion = ({ i, v }: Operands) => v === 0 && i !== 0 && i % 1_000_000 === 0

const OTHER: Rule = { categories: ['other'], select: () => 'other' }
const ONE_WHOLE: Rule = {
  categories: ['one', 'other'],
  select: ({ i, v }) => (i === 1 && v === 0 ? 'one' : 'other'),
}
const ONE_WHOLE_MANY: Rule = {
  categories: ['one', 'many', 'other'],
  select: o => (o.i === 1 && o.v === 0 ? 'one' : roundMillion(o) ? 'many' : 'other'),
}
const ONE_BELOW_TWO_MANY: Rule = {
  categories: ['one', 'many', 'other'],
  select: o => (o.i <= 1 ? 'one' : roundMillion(o) ? 'many' : 'other'),
}

// Keyed by the tag the app ships, falling back to its base language and then to English.
const RULES: Record<string, Rule> = {
  en: ONE_WHOLE,
  de: ONE_WHOLE,
  ur: ONE_WHOLE,
  id: OTHER,
  ja: OTHER,
  ko: OTHER,
  th: OTHER,
  vi: OTHER,
  zh: OTHER,
  it: ONE_WHOLE_MANY,
  'pt-PT': ONE_WHOLE_MANY,
  fr: ONE_BELOW_TWO_MANY,
  pt: ONE_BELOW_TWO_MANY,
  es: {
    categories: ['one', 'many', 'other'],
    select: o => (o.n === 1 ? 'one' : roundMillion(o) ? 'many' : 'other'),
  },
  hi: { categories: ['one', 'other'], select: ({ n, i }) => (i === 0 || n === 1 ? 'one' : 'other') },
  tr: { categories: ['one', 'other'], select: ({ n }) => (n === 1 ? 'one' : 'other') },
  he: {
    categories: ['one', 'two', 'other'],
    select: ({ i, v }) =>
      (i === 1 && v === 0) || (i === 0 && v !== 0) ? 'one' : i === 2 && v === 0 ? 'two' : 'other',
  },
  ru: {
    categories: ['one', 'few', 'many', 'other'],
    select: ({ i, v }) => {
      if (v !== 0) return 'other'
      if (i % 10 === 1 && i % 100 !== 11) return 'one'
      if (inRange(i % 10, 2, 4) && !inRange(i % 100, 12, 14)) return 'few'
      return 'many'
    },
  },
  pl: {
    categories: ['one', 'few', 'many', 'other'],
    select: ({ i, v }) => {
      if (v !== 0) return 'other'
      if (i === 1) return 'one'
      if (inRange(i % 10, 2, 4) && !inRange(i % 100, 12, 14)) return 'few'
      return 'many'
    },
  },
  ar: {
    categories: ['zero', 'one', 'two', 'few', 'many', 'other'],
    select: ({ i, v }) => {
      if (v !== 0) return 'other'
      if (i === 0) return 'zero'
      if (i === 1) return 'one'
      if (i === 2) return 'two'
      if (inRange(i % 100, 3, 10)) return 'few'
      if (inRange(i % 100, 11, 99)) return 'many'
      return 'other'
    },
  },
}

// The part of Intl.PluralRules that i18next reads. Ordinal rules are not bundled, and asking for one
// throws, as an unsupported option does, rather than answering with the cardinal rule.
export class PluralRules {
  private readonly locale: string
  private readonly rule: Rule

  constructor(locales?: string | string[], options?: { type?: string }) {
    if (options?.type === 'ordinal') {
      throw new RangeError('Only cardinal plural rules are bundled')
    }
    this.locale = (Array.isArray(locales) ? locales[0] : locales) ?? 'en'
    this.rule = RULES[this.locale] ?? RULES[this.locale.split('-')[0]] ?? RULES.en
  }

  // ICU answers 'other' for NaN and the infinities in every language.
  select(count: number): PluralCategory {
    return Number.isFinite(count) ? this.rule.select(operands(count)) : 'other'
  }

  resolvedOptions() {
    return { locale: this.locale, type: 'cardinal', pluralCategories: [...this.rule.categories] }
  }
}

// An engine that ships ICU keeps its own rules.
export function installPluralRules(): void {
  if (typeof Intl !== 'undefined' && typeof Intl.PluralRules !== 'function') {
    Object.defineProperty(Intl, 'PluralRules', { value: PluralRules, writable: true, configurable: true })
  }
}
