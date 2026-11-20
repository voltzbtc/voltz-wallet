import RNFS from 'react-native-fs'
import { clearDomainFor, domainFor, setDomainFor } from '../src/wallet/lnurlDomainPref'

jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'lnurl.usevoltz.app' }))

const FILE = `${RNFS.DocumentDirectoryPath}/lnurl-domain.json`

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
})

afterEach(() => {
  jest.restoreAllMocks()
})

it('falls back to the build domain for a wallet that bought none', async () => {
  expect(await domainFor('primary')).toBe('lnurl.usevoltz.app')
})

// A purchased domain is only useful once addresses are issued on it, which the SDK decides at
// connect from this value.
it('serves the purchased domain once it is adopted', async () => {
  await setDomainFor('primary', 'PAY.Bakery.com.br')
  expect(await domainFor('primary')).toBe('pay.bakery.com.br')
})

it('keeps the choice per wallet', async () => {
  await setDomainFor('primary', 'pay.bakery.com.br')
  expect(await domainFor('segunda')).toBe('lnurl.usevoltz.app')
})

it('returns a wallet to the build domain when cleared', async () => {
  await setDomainFor('primary', 'pay.bakery.com.br')
  await clearDomainFor('primary')
  expect(await domainFor('primary')).toBe('lnurl.usevoltz.app')
})

// Losing the file moves every wallet with a domain of its own to the shared one, so a write cut
// midway leaves the last whole file in place.
it('a write cut midway keeps every wallet\'s choice', async () => {
  await setDomainFor('primary', 'pay.a.com')
  await setDomainFor('other', 'pay.b.com')
  const write = RNFS.writeFile
  jest.spyOn(RNFS, 'writeFile').mockImplementation(async (path: string, text: string, ...rest: unknown[]) => {
    if (path.startsWith(FILE)) {
      await (write as (...args: unknown[]) => Promise<void>)(path, text.slice(0, 5), ...rest)
      throw new Error('killed mid write')
    }
    return (write as (...args: unknown[]) => Promise<void>)(path, text, ...rest)
  })
  await expect(setDomainFor('third', 'pay.c.com')).rejects.toThrow('killed mid write')
  jest.restoreAllMocks()
  expect(await domainFor('primary')).toBe('pay.a.com')
  expect(await domainFor('other')).toBe('pay.b.com')
})

it('a torn file reads as no choice, and a write sets it aside rather than writing over it', async () => {
  await RNFS.writeFile(FILE, '{"other":"pay.b', 'utf8')
  expect(await domainFor('other')).toBe('lnurl.usevoltz.app')
  await setDomainFor('primary', 'pay.a.com')
  expect(await RNFS.readFile(`${FILE}.unreadable`, 'utf8')).toBe('{"other":"pay.b')
  expect(await domainFor('primary')).toBe('pay.a.com')
})

// A read the platform refuses says nothing about the file, so no write starts from an empty map over it.
it('a write over a read the platform refuses throws and leaves the file as it is', async () => {
  const intact = JSON.stringify({ other: 'pay.b.com' })
  await RNFS.writeFile(FILE, intact, 'utf8')
  const read = RNFS.readFile
  jest.spyOn(RNFS, 'readFile').mockImplementation(async (path: string, ...rest: unknown[]) => {
    if (path === FILE) {
      throw new Error('EACCES: permission denied')
    }
    return (read as (...args: unknown[]) => Promise<string>)(path, ...rest)
  })
  await expect(setDomainFor('primary', 'pay.a.com')).rejects.toThrow('EACCES')
  await expect(clearDomainFor('other')).rejects.toThrow('EACCES')
  expect(await domainFor('other')).toBe('lnurl.usevoltz.app')
  jest.restoreAllMocks()
  expect(await RNFS.readFile(FILE, 'utf8')).toBe(intact)
  expect(await domainFor('other')).toBe('pay.b.com')
})
