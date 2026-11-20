import {
  conversionFigure,
  contactKey,
  conversionLeft,
  conversionSides,
  directionLabel,
  groupHistory,
  exactAmountText,
  explorerTxUrl,
  feeText,
  httpUrl,
  formatTime,
  formatDate,
  historyStatusText,
  matchContacts,
  parseZap,
  rowAmountText,
  type ContactNames,
} from '../src/wallet/history'
import { DEPIX, USDB as USDB_TOKEN } from '../src/wallet/tokens'
import { formatSats } from '../src/wallet/amount'
import i18n from '../src/i18n'
import type { HistoryConversionSide, HistoryConversionStatus, HistoryItem } from '../src/wallet/payment'

// Only content matters to parseZap, so the rest of the kind-9734 request stays minimal.
const zapRequest = (content: string) =>
  JSON.stringify({ kind: 9734, pubkey: 'abc', content, tags: [] })

describe('parseZap', () => {
  it('reads the zapper message from the 9734 content', () => {
    expect(parseZap(zapRequest('gm ☕'), undefined)).toEqual({ isZap: true, comment: 'gm ☕' })
  })

  it('is a zap even when the 9734 has no message, with no comment', () => {
    expect(parseZap(zapRequest(''), undefined)).toEqual({ isZap: true, comment: undefined })
  })

  it('falls back to the LUD-12 sender comment when the 9734 content is empty', () => {
    expect(parseZap(zapRequest('   '), 'thanks!')).toEqual({ isZap: true, comment: 'thanks!' })
  })

  it('stays a zap on malformed 9734 JSON, falling back to the sender comment', () => {
    expect(parseZap('{not valid json', 'via lud12')).toEqual({ isZap: true, comment: 'via lud12' })
    expect(parseZap('{not valid json', undefined)).toEqual({ isZap: true, comment: undefined })
  })

  it('is not a zap when only a LUD-12 comment is present', () => {
    expect(parseZap(undefined, 'just a comment')).toEqual({ isZap: false, comment: 'just a comment' })
  })

  it('is not a zap and has no comment when nothing is present', () => {
    expect(parseZap(undefined, undefined)).toEqual({ isZap: false, comment: undefined })
    expect(parseZap(undefined, '  ')).toEqual({ isZap: false, comment: undefined })
  })

  it('ignores a 9734 whose content is not a string', () => {
    expect(parseZap(JSON.stringify({ content: 42 }), 'fallback')).toEqual({
      isZap: true,
      comment: 'fallback',
    })
  })
})

const sec = (d: Date) => Math.floor(d.getTime() / 1000)

function item(timestampSeconds: number, over: Partial<HistoryItem> = {}): HistoryItem {
  return {
    id: String(timestampSeconds),
    direction: 'received',
    status: 'complete',
    amountSat: 1000,
    feesSat: 0,
    timestamp: timestampSeconds,
    asset: null,
    ...over,
  }
}

describe('groupHistory', () => {
  // Local noon, so the day boundaries are unambiguous regardless of the machine timezone.
  const now = new Date(2026, 6, 28, 12, 0, 0).getTime()

  it('labels today, yesterday, and older days', () => {
    const items = [
      item(sec(new Date(2026, 6, 28, 9, 0, 0))),
      item(sec(new Date(2026, 6, 27, 20, 0, 0))),
      item(sec(new Date(2026, 6, 25, 10, 0, 0))),
    ]
    expect(groupHistory(items, now).map(g => g.kind)).toEqual(['today', 'yesterday', 'older'])
  })

  it('groups consecutive same-day payments together', () => {
    const items = [
      item(sec(new Date(2026, 6, 28, 9, 0, 0))),
      item(sec(new Date(2026, 6, 28, 8, 0, 0))),
      item(sec(new Date(2026, 6, 27, 20, 0, 0))),
    ]
    const groups = groupHistory(items, now)
    expect(groups).toHaveLength(2)
    expect(groups[0].items).toHaveLength(2)
    expect(groups[1].items).toHaveLength(1)
  })

  it('keeps two different older days as separate groups', () => {
    const items = [
      item(sec(new Date(2026, 6, 25, 10, 0, 0))),
      item(sec(new Date(2026, 6, 24, 10, 0, 0))),
    ]
    const groups = groupHistory(items, now)
    expect(groups).toHaveLength(2)
    expect(groups.every(g => g.kind === 'older')).toBe(true)
  })

  it('yields no groups for an empty list', () => {
    expect(groupHistory([], now)).toEqual([])
  })
})

describe('explorerTxUrl', () => {
  // The base is the explorer site picked in settings, not an API endpoint.
  const bitcoin = 'https://mempool.space'

  it('builds a bitcoin tx URL on the chosen explorer', () => {
    expect(explorerTxUrl('bitcoin', 'abc123', bitcoin)).toBe('https://mempool.space/tx/abc123')
  })

  it('keeps a self-hosted subpath instead of collapsing to the origin', () => {
    // Someone running mempool behind a path would otherwise get a link to a page that isn't theirs.
    expect(explorerTxUrl('bitcoin', 'abc123', 'https://node.example.com/mempool')).toBe(
      'https://node.example.com/mempool/tx/abc123',
    )
  })

  it('does not double the separator on a trailing slash', () => {
    expect(explorerTxUrl('bitcoin', 'abc', 'http://mempool.local:3006/')).toBe(
      'http://mempool.local:3006/tx/abc',
    )
  })

  it('gives no link for lightning or spark (no onchain tx)', () => {
    expect(explorerTxUrl('lightning', 'abc', bitcoin)).toBeNull()
    expect(explorerTxUrl('spark', 'abc', bitcoin)).toBeNull()
  })

  it('gives no link without a txid', () => {
    expect(explorerTxUrl('bitcoin', undefined, bitcoin)).toBeNull()
  })

  it('gives no link when there is no configured base', () => {
    expect(explorerTxUrl('bitcoin', 'abc', undefined)).toBeNull()
  })

  it('refuses a non-http base: the URL is handed to Linking.openURL', () => {
    // eslint-disable-next-line no-script-url -- the assert exists because this must be rejected
    expect(explorerTxUrl('bitcoin', 'abc', 'javascript:alert(1)')).toBeNull()
    expect(explorerTxUrl('bitcoin', 'abc', 'mempool.space')).toBeNull()
  })
})

// Jest runs on Node's ICU and the app on Hermes', which disagree in places such as ja-JP 24h
// ("8:03" against "08:03"), so only combinations confirmed identical on-device are asserted.
describe('formatTime / formatDate (device Intl)', () => {
  const t = sec(new Date(2026, 0, 5, 9, 3, 0))
  const tpm = sec(new Date(2026, 0, 5, 13, 5, 0))

  it('date order and separators follow the device locale exactly', () => {
    expect(formatDate(t, { locale: 'en-US', use24Hour: true })).toBe('01/05/2026')
    expect(formatDate(t, { locale: 'pt-BR', use24Hour: true })).toBe('05/01/2026')
    expect(formatDate(t, { locale: 'ja-JP', use24Hour: true })).toBe('2026/01/05')
    expect(formatDate(t, { locale: 'de-DE', use24Hour: true })).toBe('05.01.2026')
  })

  it('24h clock', () => {
    expect(formatTime(t, { locale: 'pt-BR', use24Hour: true })).toBe('09:03')
    expect(formatTime(tpm, { locale: 'pt-BR', use24Hour: true })).toBe('13:05')
  })

  it('12h clock with AM/PM', () => {
    expect(formatTime(t, { locale: 'en-US', use24Hour: false })).toBe('9:03 AM')
    expect(formatTime(tpm, { locale: 'en-US', use24Hour: false })).toBe('1:05 PM')
  })

  it("the device's explicit 12h/24h setting overrides the locale default", () => {
    expect(formatTime(tpm, { locale: 'pt-BR', use24Hour: false })).toBe('1:05 PM')
  })

  it('12h edge cases: midnight and noon map to 12', () => {
    expect(formatTime(sec(new Date(2026, 0, 5, 0, 7, 0)), { locale: 'en-US', use24Hour: false })).toBe(
      '12:07 AM',
    )
    expect(formatTime(sec(new Date(2026, 0, 5, 12, 0, 0)), { locale: 'en-US', use24Hour: false })).toBe(
      '12:00 PM',
    )
  })
})

describe('how a conversion reads', () => {
  const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts)
  const entry = (over: Partial<HistoryItem>): HistoryItem => ({
    id: 'c',
    direction: 'converted',
    status: 'complete',
    amountSat: 31_473,
    feesSat: 0,
    timestamp: 1_700_000_000,
    asset: null,
    ...over,
  })
  const SATS = { ticker: null, amount: '31473' }
  const USDB = { ticker: 'USDB', amount: '25.388955' }

  it('is titled by where it landed, never by the pair', () => {
    expect(directionLabel(entry({ conversion: { status: 'complete', automatic: false, from: USDB, to: SATS } }), t)).toBe(
      'Conversion to bitcoin',
    )
    expect(
      directionLabel(entry({ conversion: { status: 'complete', automatic: false, from: { ticker: null }, to: USDB } }), t),
    ).toBe('Conversion to USDB')
  })

  it('without the side it landed on it is only a conversion, which may have failed', () => {
    expect(directionLabel(entry({ conversion: { status: 'failed', automatic: false, from: USDB } }), t)).toBe('Conversion')
    expect(directionLabel(entry({ conversion: { status: 'failed', automatic: false } }), t)).toBe('Conversion')
  })

  it('needs only the side it landed on', () => {
    expect(directionLabel(entry({ conversion: { status: 'complete', automatic: false, to: SATS } }), t)).toBe(
      'Conversion to bitcoin',
    )
  })

  it('with no side it is the plain word', () => {
    expect(directionLabel(entry({}), t)).toBe('Conversion')
  })

  it('a receive stays a receive whatever conversion it carries', () => {
    expect(
      directionLabel(entry({ direction: 'received', conversion: { status: 'complete', automatic: false, from: SATS, to: USDB } }), t),
    ).toBe('Received')
  })

  it('draws sats in sats and a token in its ticker', () => {
    expect(conversionFigure({ ticker: null }, '31473', t)).toBe(`${formatSats(31_473)} sats`)
    expect(conversionFigure({ ticker: 'USDB' }, '25.388955', t)).toBe('25.388955 USDB')
  })

  it('a row draws what left only when both amounts are known', () => {
    const both = { status: 'complete', automatic: false, from: USDB, to: SATS } as const
    expect(conversionLeft(entry({ conversion: both }), t)).toBe('from 25.38 USDB')
    const fromSats = { status: 'complete', automatic: false, from: SATS, to: USDB } as const
    expect(conversionLeft(entry({ conversion: fromSats }), t)).toBe(`from ${formatSats(31_473)} sats`)
    expect(conversionLeft(entry({ conversion: { ...both, from: { ticker: null } } }), t)).toBeNull()
    expect(conversionLeft(entry({ conversion: { ...both, to: undefined } }), t)).toBeNull()
    expect(conversionLeft(entry({}), t)).toBeNull()
  })

  it('a figure that is only the quote reads as approximate, and a reported one does not', () => {
    const quoted = { status: 'complete', automatic: false, from: { ...USDB, quoted: true }, to: SATS } as const
    expect(conversionLeft(entry({ conversion: quoted }), t)).toBe('from ≈ 25.38 USDB')
    const quotedSats = { status: 'complete', automatic: false, from: { ...SATS, quoted: true }, to: USDB } as const
    expect(conversionLeft(entry({ conversion: quotedSats }), t)).toBe(`from ≈ ${formatSats(31_473)} sats`)
  })

  it('a row of a receive draws one amount, since the row is the receive', () => {
    const conversion = { status: 'complete', automatic: false, from: USDB, to: SATS } as const
    expect(conversionLeft(entry({ direction: 'received', conversion }), t)).toBeNull()
  })

  it('a conversion that did not deliver says where the value stands', () => {
    const failed = (status: 'refundPending' | 'refunded' | 'failed') =>
      entry({ status: 'failed', conversion: { status, automatic: false, from: USDB } })
    expect(historyStatusText(failed('refundPending'), t)).toBe('Refund in progress')
    expect(historyStatusText(failed('refunded'), t)).toBe('Refunded')
    expect(historyStatusText(failed('failed'), t)).toBe('Failed')
  })

  it('a send past Spark says where the value stands by its delivery, not its conversion', () => {
    const sent = (status: 'failed' | 'pending', delivery: 'refundPending' | 'refunded' | 'failed' | 'pending') =>
      entry({ direction: 'sent', status, delivery })
    expect(historyStatusText(sent('failed', 'refundPending'), t)).toBe('Refund in progress')
    expect(historyStatusText(sent('failed', 'refunded'), t)).toBe('Refunded')
    expect(historyStatusText(sent('failed', 'failed'), t)).toBe('Failed')
    expect(historyStatusText(sent('pending', 'pending'), t)).toBe('Pending')
    const funded = entry({ direction: 'sent', conversion: { status: 'refunded', automatic: true } })
    expect(historyStatusText(funded, t)).toBe('Completed')
  })

  it('a refund row, which is a receive, reads by its own status', () => {
    const refund = entry({ direction: 'received', conversion: { status: 'refunded', automatic: false } })
    expect(historyStatusText(refund, t)).toBe('Completed')
  })

  it('a leg still settling reads as pending whatever the conversion says', () => {
    const pending = entry({ status: 'pending', conversion: { status: 'complete', automatic: false, to: SATS } })
    expect(historyStatusText(pending, t)).toBe('Pending')
  })
})

describe('feeText', () => {
  const t = (key: string, opts?: Record<string, unknown>) => (key === 'home.sats' ? `${opts?.amount} sats` : key)
  const SENT: HistoryItem = {
    id: 'p',
    direction: 'sent',
    status: 'complete',
    amountSat: 1000,
    feesSat: 5,
    timestamp: 1,
    asset: null,
  }

  test('a Bitcoin payment always has one, a free one saying 0 sats', () => {
    expect(feeText(SENT, t)).toBe('5 sats')
    expect(feeText({ ...SENT, feesSat: 0 }, t)).toBe('0 sats')
  })

  test('a failed payment has none', () => {
    expect(feeText({ ...SENT, status: 'failed' }, t)).toBeNull()
  })

  test('a conversion has none of its own', () => {
    expect(feeText({ ...SENT, direction: 'converted' }, t)).toBeNull()
  })

  test('a token reads its own fee and never the base units in feesSat', () => {
    const asset = { assetId: 'a', ticker: 'USDB', amount: '1' }
    expect(feeText({ ...SENT, feesSat: 50_000, asset: { ...asset, fee: '0.05' } }, t)).toBe('0.05 USDB')
    expect(feeText({ ...SENT, feesSat: 50_000, asset }, t)).toBeNull()
  })
})

describe('httpUrl', () => {
  test.each(['https://a.example/x', 'HTTP://a.example'])('passes %s', url => {
    expect(httpUrl(url)).toBe(url)
  })

  // eslint-disable-next-line no-script-url
  test.each(['javascript:alert(1)', 'ftp://a.example', ' https://a.example', 'https://a b', ''])('refuses %j', url => {
    expect(httpUrl(url)).toBeNull()
  })
})

describe('who a send went to', () => {
  const t = i18n.t.bind(i18n)
  const SENT: HistoryItem = {
    id: 'p',
    direction: 'sent',
    status: 'complete',
    amountSat: 1000,
    feesSat: 0,
    timestamp: 1,
    asset: null,
  }
  const names: ContactNames = new Map([['maria@usevoltz.app', 'Maria']])

  test('a contact first', () => {
    expect(directionLabel({ ...SENT, lnAddress: 'maria@usevoltz.app' }, t, names)).toBe('To Maria')
  })

  test('the address when no contact has it', () => {
    expect(directionLabel({ ...SENT, lnAddress: 'joao@usevoltz.app' }, t, names)).toBe('To joao@usevoltz.app')
  })

  test('the address with no map at all, as while the contacts load or when their read failed', () => {
    expect(directionLabel({ ...SENT, lnAddress: 'maria@usevoltz.app' }, t)).toBe('To maria@usevoltz.app')
  })

  test('Sent when the send has no address, even with a destination', () => {
    expect(directionLabel({ ...SENT, destination: '02deadbeef' }, t, names)).toBe('Sent')
  })

  test('matches however either side was typed', () => {
    const typed: ContactNames = new Map([[contactKey('  Maria@Usevoltz.App '), 'Maria']])
    expect(directionLabel({ ...SENT, lnAddress: 'maria@USEVOLTZ.app' }, t, typed)).toBe('To Maria')
  })

  test('a receive is never titled after anyone', () => {
    const paid: HistoryItem = { ...SENT, direction: 'received', lnAddress: 'maria@usevoltz.app' }
    expect(directionLabel(paid, t, names)).toBe('Received')
  })

  test('a conversion is titled by where it landed, whoever it mentions', () => {
    const conversion = { status: 'complete' as const, automatic: false, from: { ticker: null }, to: { ticker: 'USDB' } }
    const paid: HistoryItem = { ...SENT, direction: 'converted', lnAddress: 'maria@usevoltz.app', conversion }
    expect(directionLabel(paid, t, names)).toBe('Conversion to USDB')
  })

  test.each(['ar', 'he', 'ur'])('in %s a Latin name sits in its own direction', async language => {
    const before = i18n.language
    await i18n.changeLanguage(language)
    try {
      const title = directionLabel({ ...SENT, lnAddress: 'maria@usevoltz.app' }, i18n.t.bind(i18n), names)
      expect(title).toContain('\u2068Maria\u2069')
    } finally {
      await i18n.changeLanguage(before)
    }
  })
})

describe('a refund from the pool', () => {
  const t = i18n.t.bind(i18n)
  const BACK: HistoryItem = {
    id: 'p',
    direction: 'received',
    status: 'complete',
    amountSat: 1000,
    feesSat: 0,
    timestamp: 1,
    asset: null,
    poolRefund: true,
    conversion: { status: 'refunded', automatic: false },
  }

  test('reads as returned, not as money from someone', () => {
    expect(directionLabel(BACK, t)).toBe('Returned')
  })

  // The status reaches a real receive from a child leg, and that money stayed in the wallet.
  test.each(['complete', 'pending', 'failed', 'refundPending', 'refunded'] as const)(
    'a real receive whose conversion is at %s stays Received',
    status => {
      expect(directionLabel({ ...BACK, poolRefund: undefined, conversion: { status, automatic: false } }, t)).toBe('Received')
    },
  )

  test('only a receive: a refunded conversion leg keeps its own title', () => {
    expect(directionLabel({ ...BACK, direction: 'converted' }, t)).toBe('Conversion')
  })
})

describe('the conversion sides a detail states', () => {
  const FROM = { ticker: null, amount: '5000' }
  const TO = { ticker: 'USDB', amount: '4.9' }
  const on = (direction: HistoryItem['direction'], status: HistoryConversionStatus): HistoryItem => ({
    id: 'p',
    direction,
    status: 'complete',
    amountSat: 5000,
    feesSat: 0,
    timestamp: 1,
    asset: null,
    conversion: { status, automatic: true, from: FROM, to: TO },
  })

  test('a finished conversion states both', () => {
    expect(conversionSides(on('converted', 'complete'))).toEqual({ left: FROM, arrived: TO })
    expect(conversionSides(on('received', 'complete'))).toEqual({ left: FROM, arrived: TO })
  })

  test('only a send waits on its own status: a leg still settling keeps the side the conversion made', () => {
    expect(conversionSides({ ...on('converted', 'complete'), status: 'pending' })).toEqual({ left: FROM, arrived: TO })
  })

  test.each(['pending', 'failed', 'refundPending', 'refunded'] as const)(
    'at %s nothing arrived, and a receive stayed as it came in',
    status => {
      expect(conversionSides(on('converted', status))).toEqual({ left: FROM })
      expect(conversionSides(on('received', status))).toEqual({})
    },
  )

  test('a send it funded reads as arrived only once the send is through', () => {
    expect(conversionSides(on('sent', 'complete'))).toEqual({ left: FROM, arrived: TO })
    expect(conversionSides({ ...on('sent', 'complete'), status: 'failed' })).toEqual({ left: FROM })
    expect(conversionSides({ ...on('sent', 'complete'), status: 'pending' })).toEqual({ left: FROM })
  })

  test.each(['complete', 'pending', 'failed', 'refundPending', 'refunded'] as const)(
    'a cross-chain send it funded states neither side, at delivery %s',
    delivery => {
      const send = { chain: 'tron', asset: 'USDT', estimatedOut: '12' }
      expect(conversionSides({ ...on('sent', 'complete'), crossChainSend: send, delivery })).toEqual({})
    },
  )

  test('a payment with no conversion has none', () => {
    expect(conversionSides({ ...on('received', 'complete'), conversion: undefined })).toEqual({})
  })
})

describe('the figure on a list row', () => {
  const t = i18n.t.bind(i18n)
  const SATS = (amount: number) => t('home.sats', { amount: formatSats(amount) })
  const row: HistoryItem = {
    id: 'p',
    direction: 'received',
    status: 'complete',
    amountSat: 12_000,
    feesSat: 0,
    timestamp: 1,
    asset: null,
  }
  const usdb = (amount: string) => ({ assetId: USDB_TOKEN.identifier, ticker: 'USDB', amount })

  test('a known pegged token reads as the money it tracks', () => {
    expect(rowAmountText({ ...row, asset: usdb('10.5') }, t)).toBe('$10.50')
  })

  test('each by its own peg', () => {
    expect(rowAmountText({ ...row, asset: { assetId: DEPIX.identifier, ticker: 'DePix', amount: '25' } }, t)).toBe(
      'R$25.00',
    )
  })

  test('the detail keeps the exact figure with its ticker', () => {
    expect(exactAmountText({ ...row, asset: usdb('10.123456') }, t)).toBe('10.123456 USDB')
  })

  test('a token that only calls itself USDB keeps its ticker', () => {
    const fake = { assetId: 'btkn1fake', ticker: 'USDB', amount: '10' }
    expect(rowAmountText({ ...row, asset: fake }, t)).toBe('10 USDB')
  })

  test('a known token with no peg in the table would keep its ticker', () => {
    expect(rowAmountText({ ...row, asset: { assetId: 'btkn1meme', ticker: 'MEME', amount: '10' } }, t)).toBe('10 MEME')
  })

  test.each(['0.009999', '0.000001'])('under a cent, %s stays exact rather than reading as zero', amount => {
    expect(rowAmountText({ ...row, asset: usdb(amount) }, t)).toBe(`${amount} USDB`)
  })

  test('a cent exactly is money', () => {
    expect(rowAmountText({ ...row, asset: usdb('0.01') }, t)).toBe('$0.01')
  })

  test('sats stay sats', () => {
    expect(rowAmountText(row, t)).toBe(SATS(12_000))
  })

  describe('with a conversion behind it', () => {
    const side = { ticker: 'USDB', assetId: USDB_TOKEN.identifier, amount: '9.87' }
    const sats = { ticker: null, amount: '12000' }
    const converted = (status: 'complete' | 'pending' | 'failed', to: HistoryConversionSide = side): HistoryItem => ({
      ...row,
      conversion: { status, automatic: true, from: sats, to },
    })

    test('a finished one reads as the side the money ended on', () => {
      expect(rowAmountText(converted('complete'), t)).toBe('$9.87')
    })

    test('a send reads as the side it left from', () => {
      const paid: HistoryItem = {
        ...row,
        direction: 'sent',
        conversion: { status: 'complete', automatic: true, from: side, to: sats },
      }
      expect(rowAmountText(paid, t)).toBe('$9.87')
    })

    test.each(['pending', 'failed'] as const)('at %s it stays in sats', status => {
      expect(rowAmountText(converted(status), t)).toBe(SATS(12_000))
    })

    test('a figure that is only the quote stays in sats', () => {
      expect(rowAmountText(converted('complete', { ...side, quoted: true }), t)).toBe(SATS(12_000))
    })

    test('a side with no amount stays in sats', () => {
      expect(rowAmountText(converted('complete', { ticker: 'USDB', assetId: USDB_TOKEN.identifier }), t)).toBe(
        SATS(12_000),
      )
    })

    test('a side that only calls itself USDB stays in sats', () => {
      expect(rowAmountText(converted('complete', { ...side, assetId: 'btkn1fake' }), t)).toBe(SATS(12_000))
    })

    test('a token payment with its conversion still running does not read as money yet', () => {
      expect(rowAmountText({ ...converted('pending'), asset: usdb('10') }, t)).toBe('10 USDB')
    })
  })

  describe('a conversion', () => {
    const arrived = (amount: string) => rowAmountText({ ...row, direction: 'converted', asset: usdb(amount) }, t)

    test('keeps its own unit, as its title does', () => {
      expect(arrived('25')).toBe('25.00 USDB')
    })

    test('is cut at two places, so it never reads as more than arrived', () => {
      expect(arrived('25.337999')).toBe('25.33 USDB')
      expect(arrived('25.999999')).toBe('25.99 USDB')
      expect(arrived('25.3')).toBe('25.30 USDB')
    })

    test('under a hundredth keeps its digits rather than read as nothing', () => {
      expect(arrived('0.004321')).toBe('0.004321 USDB')
    })

    test('in sats stays whole', () => {
      expect(rowAmountText({ ...row, direction: 'converted', asset: null, amountSat: 31_473 }, t)).toBe(SATS(31_473))
    })
  })
})

describe('matchContacts', () => {
  const maria = { name: 'Mária Souza', address: 'maria@usevoltz.app' }
  const ze = { name: 'Zé', address: 'jose@example.com' }

  test.each([
    ['maria', [maria]],
    ['MARIA', [maria]],
    ['Mária', [maria]],
    ['souza', [maria]],
    ['ze', [ze]],
    ['example.com', [ze]],
    ['  jose@ ', [ze]],
    ['a', [maria, ze]],
    ['nobody', []],
  ])('%s', (typed, expected) => {
    expect(matchContacts([maria, ze], typed)).toEqual(expected)
  })

  test('an accent in the middle of a name, on a contact whose address does not spell it', () => {
    const contact = { name: 'Mária', address: 'mm@usevoltz.app' }
    expect(matchContacts([contact], 'maria')).toEqual([contact])
  })

  test('nothing typed matches nothing, rather than the whole list', () => {
    expect(matchContacts([maria, ze], '   ')).toEqual([])
  })

  test('stops at five lines', () => {
    const many = Array.from({ length: 7 }, (_, index) => ({ name: `Ana ${index}`, address: `a${index}@b.co` }))
    expect(matchContacts(many, 'ana')).toEqual(many.slice(0, 5))
  })
})
