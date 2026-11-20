import {
  isSparkPubkey,
  parseUsdbRewards,
  parseUsdbPayouts,
  fetchUsdbRewards,
  fetchUsdbPayouts,
} from '../src/wallet/rewards'

const PUBKEY_66 = '02' + 'ab'.repeat(32)
const PUBKEY_130 = '04' + 'cd'.repeat(64)

const fetchMock = jest.fn()

beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch
})

beforeEach(() => {
  fetchMock.mockReset()
})

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
// The error body is a payload both parsers accept, so dropping the status check turns these red
// instead of passing on a body that was unparseable anyway.
const httpError = (status: number) => ({
  ok: false,
  status,
  json: async () => ({
    usdbBalance: { display: '1250.5' },
    rewardsPercent: 4.25,
    estimatedSatsToday: 137,
    payouts: [{ day: '2026-08-04', payoutSats: 137, status: 'paid' }],
  }),
})
const notJson = () => ({
  ok: true,
  status: 200,
  json: async () => {
    throw new SyntaxError('Unexpected token < in JSON at position 0')
  },
})

const REWARDS_BODY = {
  usdbBalance: { display: '1250.5' },
  rewardsPercent: 4.25,
  estimatedSatsToday: 137,
}

describe('isSparkPubkey', () => {
  it('accepts a 66 char compressed pubkey', () => {
    expect(isSparkPubkey(PUBKEY_66)).toBe(true)
  })

  it('accepts a 130 char uncompressed pubkey', () => {
    expect(isSparkPubkey(PUBKEY_130)).toBe(true)
  })

  it('accepts uppercase hex', () => {
    expect(isSparkPubkey(PUBKEY_66.toUpperCase())).toBe(true)
  })

  it('rejects an empty string', () => {
    expect(isSparkPubkey('')).toBe(false)
  })

  it('rejects lengths between and around the two valid ones', () => {
    expect(isSparkPubkey('ab'.repeat(32))).toBe(false) // 64
    expect(isSparkPubkey(PUBKEY_66 + 'ab')).toBe(false) // 68
    expect(isSparkPubkey('ab'.repeat(49))).toBe(false) // 98
    expect(isSparkPubkey(PUBKEY_130.slice(0, 128))).toBe(false)
    expect(isSparkPubkey(PUBKEY_130 + 'ab')).toBe(false) // 132
  })

  it('rejects non-hex characters at the right length', () => {
    expect(isSparkPubkey('zz' + 'ab'.repeat(32))).toBe(false)
    expect(isSparkPubkey(PUBKEY_66.slice(0, 65) + '-')).toBe(false)
    expect(isSparkPubkey(PUBKEY_66.slice(0, 65) + ' ')).toBe(false)
  })

  it('rejects path traversal: the value is interpolated into a URL path', () => {
    expect(isSparkPubkey('../../admin')).toBe(false)
    expect(isSparkPubkey(`${PUBKEY_66}/../admin`)).toBe(false)
    expect(isSparkPubkey('../'.repeat(22))).toBe(false) // 66 chars, still not hex
  })

  it('rejects a valid pubkey with a newline glued on (anchors must hold)', () => {
    expect(isSparkPubkey(`${PUBKEY_66}\n`)).toBe(false)
    expect(isSparkPubkey(`\n${PUBKEY_66}`)).toBe(false)
    expect(isSparkPubkey(`${PUBKEY_66}\nGET /admin`)).toBe(false)
  })
})

describe('parseUsdbRewards', () => {
  it('maps a valid payload', () => {
    expect(parseUsdbRewards(REWARDS_BODY)).toEqual({
      balance: '1250.5',
      percent: 4.25,
      estimatedSatsToday: 137,
    })
  })

  it('converts numbers that arrive as strings (u128 balances come as strings)', () => {
    const parsed = parseUsdbRewards({
      usdbBalance: { display: '10.0' },
      rewardsPercent: '5.5',
      estimatedSatsToday: '4200',
    })
    expect(parsed).toEqual({ balance: '10.0', percent: 5.5, estimatedSatsToday: 4200 })
    expect(typeof parsed?.percent).toBe('number')
    expect(typeof parsed?.estimatedSatsToday).toBe('number')
  })

  it('returns null without usdbBalance.display instead of showing a zero as if it were real', () => {
    expect(parseUsdbRewards({ rewardsPercent: 4.25, estimatedSatsToday: 137 })).toBeNull()
    expect(parseUsdbRewards({ usdbBalance: {}, rewardsPercent: 4.25 })).toBeNull()
    expect(parseUsdbRewards({ usdbBalance: '1250.5', rewardsPercent: 4.25 })).toBeNull()
  })

  it('returns null without rewardsPercent', () => {
    expect(parseUsdbRewards({ usdbBalance: { display: '1250.5' } })).toBeNull()
  })

  it('rejects a display that is present but not a number or string', () => {
    // A presence-only guard would String() these and put "null" where the balance goes.
    expect(parseUsdbRewards({ usdbBalance: { display: null }, rewardsPercent: 4.25 })).toBeNull()
    expect(parseUsdbRewards({ usdbBalance: { display: {} }, rewardsPercent: 4.25 })).toBeNull()
    expect(parseUsdbRewards({ usdbBalance: { display: [] }, rewardsPercent: 4.25 })).toBeNull()
  })

  it('accepts a numeric display (the API sends both shapes)', () => {
    expect(parseUsdbRewards({ usdbBalance: { display: 10000 }, rewardsPercent: 3.5 })).toEqual({
      balance: '10000',
      percent: 3.5,
      estimatedSatsToday: 0,
    })
  })

  it('returns null for a payload that is not an object', () => {
    expect(parseUsdbRewards(null)).toBeNull()
    expect(parseUsdbRewards(undefined)).toBeNull()
    expect(parseUsdbRewards('1250.5')).toBeNull()
    expect(parseUsdbRewards(42)).toBeNull()
  })
})

describe('fetchUsdbRewards', () => {
  it('returns the mapped rewards on a 200', async () => {
    fetchMock.mockResolvedValue(okJson(REWARDS_BODY))
    await expect(fetchUsdbRewards(PUBKEY_66)).resolves.toEqual({
      balance: '1250.5',
      percent: 4.25,
      estimatedSatsToday: 137,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      `https://rewards.flashnet.xyz/v1/rewards/${PUBKEY_66}`,
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('does not call fetch with an invalid pubkey: the value would shape the URL', async () => {
    await expect(fetchUsdbRewards('../../admin')).resolves.toBeNull()
    await expect(fetchUsdbRewards('')).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null on 400 (Flashnet excludes some addresses, such as LP pools)', async () => {
    fetchMock.mockResolvedValue(httpError(400))
    await expect(fetchUsdbRewards(PUBKEY_66)).resolves.toBeNull()
  })

  it('returns null on 500', async () => {
    fetchMock.mockResolvedValue(httpError(500))
    await expect(fetchUsdbRewards(PUBKEY_66)).resolves.toBeNull()
  })

  it('returns null when the body is not JSON (an HTML error page, say)', async () => {
    fetchMock.mockResolvedValue(notJson())
    await expect(fetchUsdbRewards(PUBKEY_66)).resolves.toBeNull()
  })

  it('returns null on a network error instead of rejecting', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'))
    await expect(fetchUsdbRewards(PUBKEY_66)).resolves.toBeNull()
  })

  it('returns null when the request is aborted (timeout)', async () => {
    const aborted = new Error('Aborted')
    aborted.name = 'AbortError'
    fetchMock.mockRejectedValue(aborted)
    await expect(fetchUsdbRewards(PUBKEY_66)).resolves.toBeNull()
  })
})

describe('parseUsdbPayouts', () => {
  it('maps valid entries', () => {
    expect(
      parseUsdbPayouts({
        payouts: [
          { day: '2026-08-04', payoutSats: 137, status: 'paid' },
          { day: '2026-08-05', payoutSats: '210', status: 'pending' },
        ],
      }),
    ).toEqual([
      { day: '2026-08-04', sats: 137, paid: true },
      { day: '2026-08-05', sats: 210, paid: false },
    ])
  })

  it('marks paid only for status "paid"', () => {
    const [entry] = parseUsdbPayouts({
      payouts: [{ day: '2026-08-04', payoutSats: 1, status: 'settled' }],
    })
    expect(entry.paid).toBe(false)
  })

  it('drops entries without a day instead of rendering them half empty', () => {
    expect(
      parseUsdbPayouts({
        payouts: [
          { payoutSats: 137, status: 'paid' },
          { day: 20260804, payoutSats: 137, status: 'paid' },
          { day: '2026-08-05', payoutSats: 210, status: 'paid' },
        ],
      }),
    ).toEqual([{ day: '2026-08-05', sats: 210, paid: true }])
  })

  it('drops malformed entries (null, string, number) and keeps the valid ones', () => {
    expect(
      parseUsdbPayouts({
        payouts: [null, 'nope', 7, { day: '2026-08-05', payoutSats: 210, status: 'paid' }],
      }),
    ).toEqual([{ day: '2026-08-05', sats: 210, paid: true }])
  })

  it('returns an empty list when there is no payouts array', () => {
    expect(parseUsdbPayouts({})).toEqual([])
    expect(parseUsdbPayouts({ payouts: 'none' })).toEqual([])
    expect(parseUsdbPayouts([])).toEqual([])
    expect(parseUsdbPayouts(null)).toEqual([])
    expect(parseUsdbPayouts('nope')).toEqual([])
  })
})

describe('fetchUsdbPayouts', () => {
  it('builds the URL with the escaped pubkey and the given limit', async () => {
    fetchMock.mockResolvedValue(okJson({ payouts: [] }))
    await fetchUsdbPayouts(PUBKEY_66, 25)
    expect(fetchMock).toHaveBeenCalledWith(
      `https://rewards.flashnet.xyz/v1/rewards/${PUBKEY_66}/payouts?limit=25`,
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('defaults to limit 10', async () => {
    fetchMock.mockResolvedValue(okJson({ payouts: [] }))
    await fetchUsdbPayouts(PUBKEY_130)
    expect(fetchMock).toHaveBeenCalledWith(
      `https://rewards.flashnet.xyz/v1/rewards/${PUBKEY_130}/payouts?limit=10`,
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('does not call fetch with an invalid pubkey', async () => {
    await expect(fetchUsdbPayouts('../../admin')).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns an empty list on a failed request', async () => {
    fetchMock.mockResolvedValue(httpError(500))
    await expect(fetchUsdbPayouts(PUBKEY_66)).resolves.toEqual([])

    fetchMock.mockRejectedValue(new TypeError('Network request failed'))
    await expect(fetchUsdbPayouts(PUBKEY_66)).resolves.toEqual([])
  })
})
