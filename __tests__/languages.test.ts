import { bundleLocalization, isRTL, languageLabel, languageMatches, LANGUAGES } from '../src/i18n/languages'

describe('isRTL', () => {
  it('is true for the RTL scripts the app ships', () => {
    expect(isRTL('ar')).toBe(true)
    expect(isRTL('he')).toBe(true)
    expect(isRTL('ur')).toBe(true)
  })

  it('is false for LTR languages, including non-Latin ones', () => {
    expect(isRTL('en-US')).toBe(false)
    expect(isRTL('pt-BR')).toBe(false)
    expect(isRTL('ja')).toBe(false)
    expect(isRTL('zh')).toBe(false)
    expect(isRTL('ru')).toBe(false)
  })

  it('matches on the base tag, so a region-qualified RTL tag still counts', () => {
    expect(isRTL('ar-EG')).toBe(true)
    expect(isRTL('AR')).toBe(true) // case-insensitive
  })

  it('every language the picker lists resolves to a boolean direction', () => {
    // Guards against a new locale being added without a considered direction.
    for (const lang of LANGUAGES) {
      expect(typeof isRTL(lang.code)).toBe('boolean')
    }
  })
})

describe('languageLabel', () => {
  it('returns the endonym for an exact tag and for a base match', () => {
    expect(languageLabel('pt-BR')).toBe('Português')
    expect(languageLabel('ar')).toBe('العربية')
    expect(languageLabel('fr-CA')).toBe('Français (Canada)') // exact match on the variant
    expect(languageLabel('fr-FR')).toBe('Français') // no exact entry -> base match on 'fr'
  })

  it('falls back to English for an unknown language', () => {
    expect(languageLabel('xx')).toBe('English')
  })
})

// iOS shows the permission prompts from the app bundle, not from i18next, so an app language needs
// its own InfoPlist.strings or the camera and Face ID prompts stay in English.
//
// Every language ships one, the RTL ones included. The app pins the bundle's localization to its own
// language (src/i18n/bundleLanguage.ts), so an RTL .lproj never lays out UIKit's views right to left
// under an app in an LTR language, and every text carries an explicit alignment
// (rules.naturalText in designRatchet.test.ts) for the launch a switch made in place still runs in.
describe('iOS permission prompts', () => {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const IOS = path.join(__dirname, '..', 'ios')
  // The identifier the app writes to AppleLanguages, so each must name a localization on disk.
  const lprojOf = bundleLocalization
  const ALL = LANGUAGES.map(l => l.code)
  const RTL = ALL.filter(code => isRTL(code))

  const infoPlist = fs.readFileSync(path.join(IOS, 'VoltzWallet', 'Info.plist'), 'utf8')
  const PROMPTS = [...infoPlist.matchAll(/<key>(\w+UsageDescription)<\/key>/g)].map(m => m[1])

  const PBXPROJ = fs.readFileSync(path.join(IOS, 'VoltzWallet.xcodeproj', 'project.pbxproj'), 'utf8')
  const list = (body: string | undefined) =>
    (body ?? '')
      .split(',')
      .map(r => r.replace(/\/\*.*?\*\//g, '').trim().replace(/"/g, ''))
      .filter(Boolean)
  const KNOWN_REGIONS = list(/knownRegions = \(([^)]*)\)/.exec(PBXPROJ)?.[1])
  // The variant group lists each localization by name, after the reference id.
  const VARIANTS = [
    ...(/\/\* InfoPlist\.strings \*\/ = \{\s*isa = PBXVariantGroup;\s*children = \(([^)]*)\)/.exec(PBXPROJ)?.[1] ?? '')
      .matchAll(/\/\* (.+?) \*\//g),
  ].map(m => m[1])
  const ON_DISK = fs
    .readdirSync(path.join(IOS, 'VoltzWallet'))
    .filter(entry => entry.endsWith('.lproj'))
    .map(entry => entry.replace(/\.lproj$/, ''))

  function strings(lproj: string): Record<string, string> {
    const file = path.join(IOS, 'VoltzWallet', `${lproj}.lproj`, 'InfoPlist.strings')
    const text = fs.readFileSync(file, 'utf8')
    return Object.fromEntries([...text.matchAll(/^"(\w+)" = "([^"]+)";$/gm)].map(m => [m[1], m[2]]))
  }

  it('covers the four prompts Info.plist declares', () => {
    expect(PROMPTS.sort()).toEqual(
      ['NFCReaderUsageDescription', 'NSCameraUsageDescription', 'NSFaceIDUsageDescription', 'NSPhotoLibraryUsageDescription'],
    )
  })

  it('ships every one of the 24 languages, the RTL ones included', () => {
    expect(ALL).toHaveLength(24)
    expect([...RTL].sort()).toEqual(['ar', 'he', 'ur'])
    const expected = ALL.map(lprojOf).sort()
    expect([...ON_DISK].sort()).toEqual(expected)
    expect([...VARIANTS].sort()).toEqual(expected)
    expect(KNOWN_REGIONS.filter(r => r !== 'Base').sort()).toEqual(expected)
  })

  it.each(ALL)('%s has every prompt, translated, in a registered region', code => {
    const own = strings(lprojOf(code))
    expect(Object.keys(own).sort()).toEqual([...PROMPTS].sort())
    if (lprojOf(code) !== 'en' && !code.startsWith('en-')) {
      expect(own.NSCameraUsageDescription).not.toBe(strings('en').NSCameraUsageDescription)
    }
    // A file on disk that the project does not list never reaches the bundle.
    expect(PBXPROJ).toContain(`VoltzWallet/${lprojOf(code)}.lproj/InfoPlist.strings`)
    expect(KNOWN_REGIONS).toContain(lprojOf(code))
  })

  it('ships the strings as a resource of the app', () => {
    const phases = /Begin PBXResourcesBuildPhase section \*\/([\s\S]*?)End PBXResourcesBuildPhase/.exec(PBXPROJ)
    expect(phases?.[1]).toMatch(/InfoPlist\.strings in Resources/)
  })

  it('never names custody or brokerage', () => {
    const banned = /\b(bank|deposit|withdraw|trade|exchange|broker)/i
    for (const code of ALL) {
      expect(Object.values(strings(lprojOf(code))).join(' ')).not.toMatch(banned)
    }
  })
})

describe('languageMatches', () => {
  const portuguese = LANGUAGES.find(l => l.code === 'pt-BR')!

  it('finds a name typed without its accents, in any case', () => {
    expect(languageMatches(portuguese, 'portugues')).toBe(true)
    expect(languageMatches(portuguese, 'PORTUGUÊS')).toBe(true)
  })

  it('finds a language by its tag, which tells variants apart', () => {
    expect(languageMatches(portuguese, 'pt-br')).toBe(true)
  })

  it('finds every language on an empty query, spaces included', () => {
    expect(languageMatches(portuguese, '  ')).toBe(true)
  })

  it('leaves out what does not match', () => {
    expect(languageMatches(portuguese, 'deutsch')).toBe(false)
  })
})
