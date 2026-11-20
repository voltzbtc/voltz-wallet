import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import i18n from '../src/i18n'
import { amountText, noticeTitle, settledSendNotice, tokenUnit, type PaymentFacts } from '../src/wallet/paymentNotice'
import { announceSendSettled } from '../src/wallet/sendNotice'
import { NOTICE_RATE_WAIT_MS } from '../src/wallet/noticeFiat'
import { useSettledSendNotice } from '../src/hooks/useSettledSendNotice'
import { sparkGetFiatRates } from '../src/wallet/spark'
import { formatFiat } from '../src/wallet/fiat'
import { DEPIX, USDB } from '../src/wallet/tokens'
import { holdDirection } from '../src/i18n/direction'
import type { ForegroundNotice } from '../src/wallet/pushRoute'

jest.mock('../src/wallet/spark', () => ({ sparkGetFiatRates: jest.fn() }))
jest.mock('../src/wallet/fiatDisplay', () => ({ resolveDisplayCurrency: jest.fn(async () => 'BRL') }))

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options)
const NBSP = ' '

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  jest.mocked(sparkGetFiatRates).mockReset()
})

// Every notice names the rail the record gives, after the direction, so a send that ends out of sight
// says how it went and how much.
describe('the rail', () => {
  test.each([
    ['incoming', 'lightning', 'Incoming via Lightning'],
    ['received', 'spark', 'Received via the Spark network'],
    ['received', 'bitcoin', 'Received via the Bitcoin network'],
    ['sent', 'lightning', 'Sent via Lightning'],
    ['onTheWay', 'lightning', 'On the way via Lightning'],
    ['onTheWay', 'bitcoin', 'On the way via the Bitcoin network'],
  ] as const)('%s over %s reads "%s"', (kind, rail, words) => {
    expect(noticeTitle(kind, rail, t)).toBe(words)
  })

  test('a record that names no rail keeps the words without one', () => {
    expect(noticeTitle('received', undefined, t)).toBe(i18n.t('receive.gotIt'))
    expect(noticeTitle('onTheWay', undefined, t)).toBe(i18n.t('send.onTheWay'))
  })

  // Pending has words of its own in every language, so a send on its way never borrows "sent".
  test.each(['lightning', 'spark', 'bitcoin'] as const)('on its way over %s never reads as sent', rail => {
    for (const code of Object.keys(i18n.options.resources ?? {})) {
      const onTheWay = i18n.getFixedT(code)(`notice.onTheWay.${rail}`)
      expect(onTheWay).not.toBe(i18n.getFixedT(code)(`notice.sent.${rail}`))
      expect(onTheWay).not.toBe(i18n.getFixedT(code)(`notice.settled.${rail}`))
    }
  })
})

describe('the asset and the amount', () => {
  test('bitcoin is counted in sats', () => {
    expect(amountText({ sat: 50_000 }, t)).toBe(`50${NBSP}000 sats`)
  })

  test('a known token is named by its identifier and counted in its own unit', () => {
    expect(amountText({ sat: 10_000_000, asset: { assetId: USDB.identifier, amount: '10' } }, t)).toBe('10 USDB')
    expect(amountText({ sat: 150_000_000, asset: { assetId: DEPIX.identifier, amount: '1.5' } }, t)).toBe('1.5 DePix')
  })

  // Anyone can issue a token called USDB, or sats; the notice never takes a name from the token.
  test('a token under another identifier is never named by what it calls itself', () => {
    expect(tokenUnit('btkn1lookalike')).toBeNull()
    const text = amountText({ sat: 10_000_000, asset: { assetId: 'btkn1lookalike', amount: '10' } }, t)
    expect(text).toBe(i18n.t('notice.unknownTokenAmount', { amount: '10' }))
    expect(text).not.toMatch(/USDB|sats/)
  })

  test('a token the record left without metadata is not passed off as sats', () => {
    const text = amountText({ sat: 10_000_000, rail: 'spark', tokenUnread: true }, t)
    expect(text).toBe(i18n.t('notice.tokenAmountUnread'))
    expect(text).not.toMatch(/sats|10/)
  })
})

describe('the card for a send that ended out of sight', () => {
  const lightning: PaymentFacts = { sat: 50_000, rail: 'lightning' }

  test('one that went through over Lightning says so, with the amount and its value', () => {
    const fiat = formatFiat(150, 'BRL')
    expect(settledSendNotice('complete', lightning, t, fiat)).toEqual({
      title: 'Payment sent via Lightning',
      body: `50${NBSP}000 sats (≈ ${fiat})`,
      destination: null,
    })
  })

  // The SDK's word on a failure does not say where the money is, so neither does the card.
  test('one that failed points at History and never says the money came back', () => {
    const notice = settledSendNotice('failed', lightning, t)
    expect(notice.title).toBe('Your payment via Lightning did not go through')
    expect(notice.body).toBe(`50${NBSP}000 sats. See History for details.`)
    expect(`${notice.title} ${notice.body}`).not.toMatch(/back|refund|return/i)
  })

  // A right-to-left paragraph turns a symbol of letters and a sign around ("$US") unless the value is
  // held apart, as every money placeholder is (direction.ts).
  test.each(
    ['ar', 'he', 'ur'].flatMap(code => [
      [code, 'complete'],
      [code, 'failed'],
    ]) as [string, 'complete' | 'failed'][],
  )('in %s the value keeps its pieces in order on a %s card', async (code, outcome) => {
    await i18n.changeLanguage(code)
    const fiat = 'US$\u00A05.00'
    expect(holdDirection(fiat)).not.toBe(fiat)

    const { body } = settledSendNotice(outcome, lightning, t, fiat)

    expect(body).toContain(holdDirection(fiat))
  })

  test('a token takes no value from the sats rate', () => {
    const usdb: PaymentFacts = { sat: 10_000_000, rail: 'spark', asset: { assetId: USDB.identifier, amount: '10' } }
    expect(settledSendNotice('complete', usdb, t, 'R$ 50.000,00')).toEqual({
      title: 'Payment sent via the Spark network',
      body: '10 USDB',
      destination: null,
    })
  })

  // Its record ends with the Spark transfer while the provider still delivers it on the other chain.
  test('a send past Spark is on the way when its Spark side completes, and failed when that fails', () => {
    const crossChain: PaymentFacts = { sat: 50_000, crossChain: true }
    expect(settledSendNotice('complete', crossChain, t)).toEqual({
      title: 'On the way',
      body: `50${NBSP}000 sats`,
      destination: null,
    })
    expect(settledSendNotice('failed', crossChain, t).title).toBe(i18n.t('send.lateFailedTitle'))
  })

  test('a record with no rail keeps the title it had, and still says how much', () => {
    expect(settledSendNotice('complete', { sat: 21 }, t)).toEqual({
      title: i18n.t('send.lateCompleteTitle'),
      body: '21 sats',
      destination: null,
    })
  })
})

describe('the card, as the navigator shows it', () => {
  let card: ForegroundNotice | null = null
  function Host(): null {
    const [notice, setNotice] = React.useState<ForegroundNotice | null>(null)
    card = notice
    useSettledSendNotice(setNotice)
    return null
  }
  let tree: ReactTestRenderer.ReactTestRenderer | null = null

  beforeEach(async () => {
    card = null
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<Host />)
    })
  })
  afterEach(() => {
    ReactTestRenderer.act(() => tree?.unmount())
    jest.useRealTimers()
  })

  const flush = async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
    }
  }
  const settle = async (outcome: 'complete' | 'failed', facts: PaymentFacts) => {
    await ReactTestRenderer.act(async () => {
      announceSendSettled(outcome, facts)
      await flush()
    })
  }
  const rateLater = () => {
    let answer: (rates: Record<string, number>) => void = () => undefined
    jest.mocked(sparkGetFiatRates).mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
    return (rates: Record<string, number>) =>
      ReactTestRenderer.act(async () => {
        answer(rates)
        await flush()
      })
  }

  test('a rate that answers puts the value beside the sats', async () => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 300_000 })

    await settle('complete', { sat: 50_000, rail: 'lightning' })

    expect(sparkGetFiatRates).toHaveBeenCalledWith(['BRL'])
    expect(card).toEqual({
      title: 'Payment sent via Lightning',
      body: `50${NBSP}000 sats (≈ ${formatFiat(150, 'BRL')})`,
      destination: null,
    })
  })

  test('a read that fails leaves the card without a value', async () => {
    jest.mocked(sparkGetFiatRates).mockRejectedValue(new Error('offline'))

    await settle('failed', { sat: 50_000, rail: 'lightning' })

    expect(card).toEqual(expect.objectContaining({ body: `50${NBSP}000 sats. See History for details.` }))
  })

  test('the card shows at once, and a rate past the wait leaves it without a value', async () => {
    jest.useFakeTimers()
    const answer = rateLater()

    await settle('complete', { sat: 50_000, rail: 'lightning' })
    expect(card).toEqual(expect.objectContaining({ body: `50${NBSP}000 sats` }))

    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(NOTICE_RATE_WAIT_MS)
    })
    await answer({ BRL: 300_000 })
    expect(card).toEqual(expect.objectContaining({ body: `50${NBSP}000 sats` }))
  })

  // The record gave the send up before the card was asked for, so a card lost here is lost for good.
  test('a language change during the rate read keeps the card', async () => {
    const answer = rateLater()

    await settle('complete', { sat: 50_000, rail: 'lightning' })
    await ReactTestRenderer.act(async () => {
      await i18n.changeLanguage('pt-BR')
    })
    await answer({ BRL: 300_000 })

    expect(card).toEqual(expect.objectContaining({ title: 'Payment sent via Lightning', body: `50${NBSP}000 sats` }))
  })

  test('a later card is never covered by an earlier one whose rate answers last', async () => {
    const first = rateLater()
    const second = rateLater()

    await settle('complete', { sat: 50_000, rail: 'lightning' })
    await settle('complete', { sat: 20_000, rail: 'spark' })
    await second({ BRL: 300_000 })
    await first({ BRL: 300_000 })

    expect(card).toEqual({
      title: 'Payment sent via the Spark network',
      body: `20${NBSP}000 sats (≈ ${formatFiat(60, 'BRL')})`,
      destination: null,
    })
  })

  test('a token asks for no rate', async () => {
    await settle('complete', { sat: 10_000_000, rail: 'spark', asset: { assetId: USDB.identifier, amount: '10' } })

    expect(sparkGetFiatRates).not.toHaveBeenCalled()
    expect(card).toEqual(expect.objectContaining({ body: '10 USDB' }))
  })
})
