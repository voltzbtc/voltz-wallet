import i18n from 'i18next'
import '../src/i18n'
import { holdDirection } from '../src/i18n/direction'
import { formatFiat } from '../src/wallet/fiat'
import { formatSats } from '../src/wallet/amount'

const ISOLATES = /[⁦-⁩]/g

afterEach(async () => {
  await i18n.changeLanguage('en-US')
})

// A figure placed in a translated sentence is out of Figure's reach, so i18next holds it where it
// fills the placeholder in. Measured with CoreText and ICU's bidi: `R$` read `$R` in a right-to-left
// paragraph, and a minus beside digits landed on their far side.
describe.each(['ar', 'he', 'ur'])('in %s', language => {
  beforeEach(async () => {
    await i18n.changeLanguage(language)
  })

  test('money in a sentence keeps its pieces', () => {
    const price = formatFiat(421_691.66, 'BRL')
    // As a control, this figure is one the bidi algorithm takes apart.
    expect(holdDirection(price)).not.toBe(price)
    const line = i18n.t('home.bitcoinPrice', { price })
    expect(line).toContain(holdDirection(price))
    expect(line.replace(ISOLATES, '')).toBe(i18n.t('home.bitcoinPrice', { price: '\u0000' }).replace('\u0000', price))
  })

  test('every money placeholder is held, a limit and a fee included', () => {
    const min = formatFiat(-12, 'USD')
    expect(i18n.t('receive.range', { min, max: min })).toContain(holdDirection(min))
    expect(i18n.t('send.plusFee', { fee: min })).toContain(holdDirection(min))
  })

  // The approximate lines carry money too, under the same placeholder name as every other figure.
  test('an approximate figure is held as any other money', () => {
    const amount = formatFiat(12.5, 'BRL')
    for (const key of ['receive.approxFiat', 'send.approxFiat', 'send.approxAmount']) {
      expect(i18n.t(key, { amount })).toContain(holdDirection(amount))
    }
  })

  test('a figure its caller already held is not held twice', () => {
    const held = holdDirection(formatFiat(421_691.66, 'BRL'))
    expect(i18n.t('home.bitcoinPrice', { price: held })).toContain(held)
    const isolates = (text: string) => text.match(ISOLATES)?.length ?? 0
    expect(isolates(i18n.t('home.bitcoinPrice', { price: held }))).toBe(isolates(held))
  })

  test('sats, whose figure holds together, are left alone', () => {
    const amount = formatSats(47_112)
    expect(i18n.t('home.sats', { amount })).not.toMatch(ISOLATES)
  })

  // These leave the app through Share and mail, where an invisible isolate breaks a paste.
  test('a value that is not money is never touched', () => {
    expect(i18n.t('useDomain.stepLine', { label: 'TXT', value: 'v=spf1 -all' })).not.toMatch(ISOLATES)
    expect(i18n.t('withdrawal.receiptRef', { ref: 'ref-1a2b' })).not.toMatch(ISOLATES)
    expect(i18n.t('recover.mailBody', { pubkey: '02ab12cd', reference: 'ref-9' })).not.toMatch(ISOLATES)
  })
})

test('a left-to-right language places money as it is', async () => {
  await i18n.changeLanguage('pt-BR')
  const price = formatFiat(421_691.66, 'BRL')
  expect(i18n.t('home.bitcoinPrice', { price })).not.toMatch(ISOLATES)
})
