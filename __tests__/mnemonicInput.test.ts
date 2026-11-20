import { splitPhrase, suggestWords, isWordlistWord } from '../src/wallet/mnemonicInput'

describe('splitPhrase', () => {
  it('splits on a single space', () => {
    expect(splitPhrase('abandon ability able')).toEqual(['abandon', 'ability', 'able'])
  })

  it('collapses multiple spaces, tabs and line breaks', () => {
    expect(splitPhrase('abandon   ability\nable\tabout')).toEqual([
      'abandon',
      'ability',
      'able',
      'about',
    ])
  })

  it('normalizes to lowercase', () => {
    expect(splitPhrase('ABANDON Ability')).toEqual(['abandon', 'ability'])
  })

  it('ignores leading and trailing spaces', () => {
    expect(splitPhrase('  abandon ability  ')).toEqual(['abandon', 'ability'])
  })

  it('returns empty for a blank string', () => {
    expect(splitPhrase('   ')).toEqual([])
    expect(splitPhrase('')).toEqual([])
  })
})

describe('suggestWords', () => {
  it('returns the exact word for a unique prefix', () => {
    expect(suggestWords('abandon')).toEqual(['abandon'])
  })

  it('returns multiple words for a common prefix, respecting the limit', () => {
    const out = suggestWords('aba', 4)
    expect(out.length).toBeLessThanOrEqual(4)
    expect(out.every(word => word.startsWith('aba'))).toBe(true)
    expect(out).toContain('abandon')
  })

  it('returns nothing for an empty prefix', () => {
    expect(suggestWords('')).toEqual([])
    expect(suggestWords('   ')).toEqual([])
  })

  it('returns nothing for a prefix outside the wordlist', () => {
    expect(suggestWords('zzzz')).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(suggestWords('ABAN')).toContain('abandon')
  })
})

describe('isWordlistWord', () => {
  it('accepts a word from the BIP39 wordlist', () => {
    expect(isWordlistWord('abandon')).toBe(true)
  })

  it('accepts ignoring case and spaces', () => {
    expect(isWordlistWord('  ABANDON ')).toBe(true)
  })

  it('rejects a word outside the wordlist', () => {
    expect(isWordlistWord('bananarama')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isWordlistWord('')).toBe(false)
  })
})
