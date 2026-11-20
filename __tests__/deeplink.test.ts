import { parseLightningDeeplink, routeLightningUrl, setDeeplinkHandler } from '../src/wallet/deeplink'

describe('parseLightningDeeplink', () => {
  it('returns the raw URI for a lightning: deep link', () => {
    expect(parseLightningDeeplink('lightning:lnbc1pexampleinvoice')).toBe('lightning:lnbc1pexampleinvoice')
  })

  it('matches the scheme case-insensitively', () => {
    expect(parseLightningDeeplink('LIGHTNING:LNBC1PABC')).toBe('LIGHTNING:LNBC1PABC')
  })

  it('trims surrounding whitespace', () => {
    expect(parseLightningDeeplink('  lightning:lnurl1abc \n')).toBe('lightning:lnurl1abc')
  })

  it('does not strip the scheme (the Send parser accepts the prefix, like Scan/NFC)', () => {
    expect(parseLightningDeeplink('lightning:lnbc1')).toContain('lightning:')
  })

  it('rejects other schemes and non-URIs', () => {
    expect(parseLightningDeeplink('bitcoin:bc1qxyz')).toBeNull()
    expect(parseLightningDeeplink('https://example.com')).toBeNull()
    expect(parseLightningDeeplink('lightningfoo:bar')).toBeNull()
    expect(parseLightningDeeplink('lnbc1nopfx')).toBeNull()
    expect(parseLightningDeeplink('')).toBeNull()
  })
})

describe('deeplink router (stash + replay)', () => {
  // Registering a no-op handler flushes any stashed URL that would otherwise leak into the next test.
  afterEach(() => {
    setDeeplinkHandler(() => undefined)
    setDeeplinkHandler(null)
  })

  it('routes to a registered handler', () => {
    const seen: string[] = []
    setDeeplinkHandler(d => seen.push(d))
    routeLightningUrl('lightning:lnbc1')
    routeLightningUrl('bitcoin:ignored')
    expect(seen).toEqual(['lightning:lnbc1'])
  })

  it('stashes a URL that arrives with no handler, and replays it on registration', () => {
    const seen: string[] = []
    routeLightningUrl('lightning:lnbc-while-locked') // no handler yet (app locked)
    expect(seen).toEqual([])
    setDeeplinkHandler(d => seen.push(d)) // navigator becomes ready
    expect(seen).toEqual(['lightning:lnbc-while-locked'])
  })

  it('only replays the latest stashed URL once', () => {
    const seen: string[] = []
    routeLightningUrl('lightning:first')
    routeLightningUrl('lightning:second')
    setDeeplinkHandler(d => seen.push(d))
    setDeeplinkHandler(d => seen.push(d)) // a second registration must not re-fire
    expect(seen).toEqual(['lightning:second'])
  })
})
