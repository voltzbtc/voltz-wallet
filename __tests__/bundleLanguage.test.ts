import { Platform, Settings } from 'react-native'
import i18n from '../src/i18n'
import { pinBundleLanguage } from '../src/i18n/bundleLanguage'

const writeSettings = jest.spyOn(Settings, 'set')
const originalOs = Platform.OS

function onPlatform(os: typeof Platform.OS) {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true })
}

beforeEach(() => {
  writeSettings.mockReset().mockImplementation(() => undefined)
})

afterEach(() => {
  onPlatform(originalOs)
})

describe('pinBundleLanguage', () => {
  it.each([
    ['ar', 'ar'],
    ['pt-BR', 'pt-BR'],
    ['pt-PT', 'pt-PT'],
    ['en-US', 'en'],
    ['en-GB', 'en-GB'],
    ['zh', 'zh-Hans'],
    ['zh-TW', 'zh-Hant'],
  ])('writes %s to AppleLanguages as the bundle localization %s on iOS', (code, lproj) => {
    onPlatform('ios')
    pinBundleLanguage(code)
    expect(writeSettings).toHaveBeenCalledTimes(1)
    expect(writeSettings).toHaveBeenCalledWith({ AppleLanguages: [lproj] })
  })

  it('writes nothing on Android, whose system prompts follow the phone', () => {
    onPlatform('android')
    pinBundleLanguage('ar')
    expect(writeSettings).not.toHaveBeenCalled()
  })

  it('warns and goes on when the write throws', () => {
    onPlatform('ios')
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    writeSettings.mockImplementationOnce(() => {
      throw new Error('no defaults')
    })
    expect(() => pinBundleLanguage('he')).not.toThrow()
    expect(warn).toHaveBeenCalledWith('could not pin the bundle language', expect.any(Error))
    warn.mockRestore()
  })
})

// Detection reads the preferred languages the pin overrides, so a pin written for a language nobody
// chose would hold the app on it after the phone's language changes.
describe('a language change on its own', () => {
  const start = i18n.language

  afterAll(async () => {
    await i18n.changeLanguage(start)
  })

  it('writes nothing, so a detected language keeps following the phone', async () => {
    onPlatform('ios')
    await i18n.changeLanguage('ur')
    await i18n.changeLanguage('zh-TW')
    expect(writeSettings).not.toHaveBeenCalled()
  })
})
