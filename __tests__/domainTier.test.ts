import RNFS from 'react-native-fs'
import { forgetDomainAsk, forgetDomainCache, phaseOf, type DomainLifecycle } from '../src/wallet/domainTier'

const DAY = 86_400
// A fixed server clock. Every case states its distance from expiry against this and nothing else.
const NOW = 1_772_000_000

function customer(over: Partial<DomainLifecycle> = {}): DomainLifecycle {
  return { kind: 'customer', expiresAt: NOW + 365 * DAY, frozenAt: null, ...over }
}

function inDays(days: number): number {
  return NOW + days * DAY
}

describe('the 30 day window', () => {
  it('says nothing at 31 days', () => {
    expect(phaseOf(customer({ expiresAt: inDays(31) }), NOW)).toBe('fine')
  })

  it('is still quiet one second before the window opens', () => {
    expect(phaseOf(customer({ expiresAt: inDays(30) + 1 }), NOW)).toBe('fine')
  })

  it('is ending at exactly 30 days, the instant the first reminder is sent', () => {
    expect(phaseOf(customer({ expiresAt: inDays(30) }), NOW)).toBe('ending')
  })

  it('is ending one second inside the window', () => {
    expect(phaseOf(customer({ expiresAt: inDays(30) - 1 }), NOW)).toBe('ending')
  })

  it('stays ending across every day from 29 down to 2', () => {
    for (const days of [29, 21, 14, 7, 3, 2]) {
      expect(phaseOf(customer({ expiresAt: inDays(days) }), NOW)).toBe('ending')
    }
  })
})

describe('the last day', () => {
  it('is still ending one second before 24 hours are left', () => {
    expect(phaseOf(customer({ expiresAt: inDays(1) + 1 }), NOW)).toBe('ending')
  })

  it('turns at exactly 24 hours', () => {
    expect(phaseOf(customer({ expiresAt: inDays(1) }), NOW)).toBe('lastDay')
  })

  it('holds with one second left', () => {
    expect(phaseOf(customer({ expiresAt: NOW + 1 }), NOW)).toBe('lastDay')
  })
})

describe('expiry', () => {
  it('is expired at the exact instant of expiry, not a last day of zero length', () => {
    expect(phaseOf(customer({ expiresAt: NOW }), NOW)).toBe('expired')
  })

  it('is expired one second past', () => {
    expect(phaseOf(customer({ expiresAt: NOW - 1 }), NOW)).toBe('expired')
  })

  it('is expired in the hour before the pass removes the hostname', () => {
    expect(phaseOf(customer({ expiresAt: NOW - 1_800 }), NOW)).toBe('expired')
  })

  it('is still expired 60 days on, because only the reminders stop, not the truth', () => {
    expect(phaseOf(customer({ expiresAt: inDays(-60) }), NOW)).toBe('expired')
  })
})

describe('a hostname that was actually removed', () => {
  it('reads frozen rather than expired once the pass has run', () => {
    expect(phaseOf(customer({ expiresAt: NOW - 60, frozenAt: NOW - 30 }), NOW)).toBe('frozen')
  })

  it('reads frozen at the very second of removal', () => {
    expect(phaseOf(customer({ expiresAt: NOW - 60, frozenAt: NOW }), NOW)).toBe('frozen')
  })

  it('reads frozen 60 days on', () => {
    expect(phaseOf(customer({ expiresAt: inDays(-60), frozenAt: inDays(-60) }), NOW)).toBe('frozen')
  })

  it('reads frozen after a renewal that has not thawed yet, live expiry and all', () => {
    expect(phaseOf(customer({ expiresAt: inDays(365), frozenAt: inDays(-2) }), NOW)).toBe('frozen')
  })

  it('derives from the date again once frozenAt is cleared', () => {
    expect(phaseOf(customer({ expiresAt: inDays(365), frozenAt: null }), NOW)).toBe('fine')
    expect(phaseOf(customer({ expiresAt: inDays(-2), frozenAt: null }), NOW)).toBe('expired')
  })
})

describe('the shared build domain', () => {
  it('is fine, having no tier and no dates at all', () => {
    expect(phaseOf({ kind: 'public', expiresAt: null, frozenAt: null }, NOW)).toBe('fine')
  })

  it('is fine even carrying dates that would read as frozen on a customer domain', () => {
    expect(
      phaseOf({ kind: 'public', expiresAt: inDays(-400), frozenAt: inDays(-300) }, NOW),
    ).toBe('fine')
  })
})

describe('a body short of what it promised', () => {
  it('treats an absent frozenAt as up, never as removed', () => {
    const short = { kind: 'customer', expiresAt: inDays(200) } as unknown as DomainLifecycle
    expect(phaseOf(short, NOW)).toBe('fine')
  })

  it('does not shout expired at a customer domain whose expiry is unknown', () => {
    expect(phaseOf(customer({ expiresAt: null }), NOW)).toBe('fine')
  })
})

describe('only the server clock decides', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('does not expire a live domain on a device running a year fast', () => {
    jest.spyOn(Date, 'now').mockReturnValue(inDays(400) * 1000)
    expect(phaseOf(customer({ expiresAt: inDays(200) }), NOW)).toBe('fine')
  })

  it('does not revive an expired domain on a device running two years slow', () => {
    jest.spyOn(Date, 'now').mockReturnValue(inDays(-730) * 1000)
    expect(phaseOf(customer({ expiresAt: inDays(-1) }), NOW)).toBe('expired')
  })
})

describe('two changes to one file at once', () => {
  const docs = RNFS.DocumentDirectoryPath

  test.each([
    ['answers', `${docs}/domain-tier.json`, forgetDomainCache],
    ['asks', `${docs}/domain-mine.json`, forgetDomainAsk],
  ])('forgetting two wallets %s drops both', async (_what, path, forget) => {
    await RNFS.writeFile(path, JSON.stringify({ a: {}, b: {}, c: {} }), 'utf8')

    await Promise.all([forget('a'), forget('b')])

    expect(JSON.parse(await RNFS.readFile(path, 'utf8'))).toEqual({ c: {} })
  })
})
