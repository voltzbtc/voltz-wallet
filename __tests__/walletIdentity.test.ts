import {
  formatFingerprint,
  avatarMonogram,
  avatarColor,
  validateWalletName,
  resolveWalletDisplay,
} from '../src/wallet/walletIdentity'

describe('formatFingerprint', () => {
  it('returns the full 8-char fingerprint lowercased and unbroken', () => {
    expect(formatFingerprint('C3C60DC8')).toBe('c3c60dc8')
  })
  it('trims surrounding whitespace', () => {
    expect(formatFingerprint('  A1B2C3D4  ')).toBe('a1b2c3d4')
  })
  it('empty stays empty, never throws', () => {
    expect(formatFingerprint('')).toBe('')
  })
})

describe('avatarMonogram', () => {
  it('takes the first two chars, uppercased', () => {
    expect(avatarMonogram('a1b2c3d4')).toBe('A1')
  })
})

describe('avatarColor', () => {
  it('is deterministic for the same fingerprint', () => {
    expect(avatarColor('a1b2c3d4')).toBe(avatarColor('a1b2c3d4'))
  })
  it('differs for different fingerprints', () => {
    expect(avatarColor('a1b2c3d4')).not.toBe(avatarColor('ffffffff'))
  })
  it('returns a fixed-sat/lightness hsl string', () => {
    expect(avatarColor('a1b2c3d4')).toMatch(/^hsl\(\d{1,3}, 55%, 45%\)$/)
  })
})

describe('validateWalletName', () => {
  it('trims surrounding whitespace', () => {
    expect(validateWalletName('  Principal  ')).toBe('Principal')
  })
  it('caps the length at 24 chars', () => {
    expect(validateWalletName('x'.repeat(40))).toHaveLength(24)
  })
})

describe('resolveWalletDisplay', () => {
  const fp = 'c3c60dc8'

  it('falls back to fingerprint-derived defaults when there is no meta', () => {
    const d = resolveWalletDisplay(fp, null, 'Wallet')
    expect(d.name).toBe('Wallet')
    expect(d.imagePath).toBeNull()
    expect(d.color).toBe(avatarColor(fp))
    expect(d.monogram).toBe('C3')
  })

  it('uses the custom name, image and color when set', () => {
    const d = resolveWalletDisplay(
      fp,
      { name: 'Savings', imagePath: '/a/b.jpg', color: '#123456' },
      'Wallet',
    )
    expect(d.name).toBe('Savings')
    expect(d.imagePath).toBe('/a/b.jpg')
    expect(d.color).toBe('#123456')
  })

  it('treats a blank custom name as unset and falls back to the default', () => {
    expect(resolveWalletDisplay(fp, { name: '   ' }, 'Wallet').name).toBe('Wallet')
  })
})
