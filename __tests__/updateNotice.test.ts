import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { Platform } from 'react-native'
import { isOlderVersion, noticeFromFile, readUpdateNotice, storeUrl } from '../src/wallet/updateNotice'

// jest.setup.js stands a null in for the read, for the suites that only render Home.
jest.unmock('../src/wallet/updateNotice')

const BOTH = {
  v: 1,
  ios: { latest: '1.2.0', critical: '1.0.3' },
  android: { latest: '1.2.0', critical: '1.0.3' },
}

// Keys and signatures come from node:crypto, as the publisher's do, so the verification here is
// across two implementations and not a library agreeing with itself.
function makeKey(): { privateKey: KeyObject; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const x = publicKey.export({ format: 'jwk' }).x as string
  return { privateKey, publicKey: Buffer.from(x, 'base64url').toString('base64') }
}

const KEY = makeKey()

function signed(body: unknown, key = KEY.privateKey, prefix = 'voltz-notice:v1\n'): string {
  const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const sig = sign(null, Buffer.concat([Buffer.from(prefix), payload]), key)
  return JSON.stringify({ payload: payload.toString('base64'), sig: sig.toString('base64') })
}

const read = (text: string, installed = '1.1.0', platform = 'ios') =>
  noticeFromFile(text, { installed, platform, publicKey: KEY.publicKey })

describe('the level an install reads', () => {
  test('below critical is critical', () => {
    expect(read(signed(BOTH), '1.0.2')).toEqual({ level: 'critical' })
  })

  test('at critical and below latest is normal, and names the version', () => {
    expect(read(signed(BOTH), '1.0.3')).toEqual({ level: 'normal', latest: '1.2.0' })
  })

  test('at latest and above is nothing', () => {
    expect(read(signed(BOTH), '1.2.0')).toBeNull()
    expect(read(signed(BOTH), '1.3.0')).toBeNull()
  })

  test('each platform reads its own side', () => {
    const body = { v: 1, ios: { latest: '1.2.0', critical: '1.0.3' }, android: { latest: '2.0.0', critical: '1.5.0' } }
    expect(read(signed(body), '1.1.0', 'ios')).toEqual({ level: 'normal', latest: '1.2.0' })
    expect(read(signed(body), '1.1.0', 'android')).toEqual({ level: 'critical' })
  })
})

describe('versions compare number by number', () => {
  test('1.0.10 is newer than 1.0.9, which text order gets wrong', () => {
    expect(isOlderVersion('1.0.9', '1.0.10')).toBe(true)
    expect(isOlderVersion('1.0.10', '1.0.9')).toBe(false)
  })

  test('the file reaches the same verdict', () => {
    const body = { v: 1, ios: { latest: '1.0.10', critical: '1.0.0' } }
    expect(read(signed(body), '1.0.9')).toEqual({ level: 'normal', latest: '1.0.10' })
    expect(read(signed({ v: 1, ios: { latest: '1.0.9', critical: '1.0.0' } }), '1.0.10')).toBeNull()
  })

  test('a missing part counts as zero, and an equal version is not older', () => {
    expect(isOlderVersion('1.2', '1.2.0')).toBe(false)
    expect(isOlderVersion('1.2.0', '1.2')).toBe(false)
    expect(isOlderVersion('1.2', '1.2.1')).toBe(true)
  })
})

describe('anything short of a readable answer says nothing', () => {
  test.each([
    ['text that is not JSON', 'not json'],
    ['JSON that is not an object', '[]'],
    ['null', 'null'],
    ['a file without a signature', JSON.stringify({ payload: 'e30=' })],
    ['a payload that is not a string', JSON.stringify({ payload: 1, sig: 'AA==' })],
    ['a signed payload that is not JSON', signed('not json')],
    ['an unknown v', signed({ ...BOTH, v: 2 })],
    ['v as text', signed({ ...BOTH, v: '1' })],
    ['no v', signed({ ios: BOTH.ios })],
    ['no side for this platform', signed({ v: 1, android: BOTH.android })],
    ['a side that is not an object', signed({ v: 1, ios: '1.2.0' })],
    ['an unreadable latest', signed({ v: 1, ios: { latest: 'one', critical: '1.0.3' } })],
    ['an unreadable critical', signed({ v: 1, ios: { latest: '1.2.0', critical: '1.x' } })],
    ['a number for a version', signed({ v: 1, ios: { latest: 2, critical: '1.0.3' } })],
    ['a missing critical', signed({ v: 1, ios: { latest: '1.2.0' } })],
    ['a version with a suffix', signed({ v: 1, ios: { latest: '1.2.0-beta', critical: '1.0.3' } })],
    ['a part too long to be a safe number', signed({ v: 1, ios: { latest: '1.99999999999999999', critical: '1.0.3' } })],
  ])('%s', (_name, text) => {
    expect(read(text, '1.0.0')).toBeNull()
  })

  test('an install whose own version cannot be read', () => {
    expect(read(signed(BOTH), 'dev')).toBeNull()
  })

  test('a file too large to be real is refused before it is hashed', () => {
    const padded = signed({ ...BOTH, pad: 'x'.repeat(4_096) })
    expect(read(padded, '1.0.0')).toBeNull()
  })
})

describe('only this key, over these bytes, is an answer', () => {
  test('control: the same file with its key reads', () => {
    expect(read(signed(BOTH), '1.0.0')).toEqual({ level: 'critical' })
  })

  test('a signature from another key', () => {
    expect(read(signed(BOTH, makeKey().privateKey), '1.0.0')).toBeNull()
  })

  test('the file against the key built into the app', () => {
    expect(noticeFromFile(signed(BOTH), { installed: '1.0.0', platform: 'ios' })).toBeNull()
  })

  test('one payload byte changed', () => {
    const file = JSON.parse(signed(BOTH))
    const bytes = Buffer.from(file.payload, 'base64')
    bytes[bytes.indexOf('2'.charCodeAt(0))] = '3'.charCodeAt(0)
    expect(read(JSON.stringify({ ...file, payload: bytes.toString('base64') }), '1.0.0')).toBeNull()
  })

  test('one signature byte changed', () => {
    const file = JSON.parse(signed(BOTH))
    const bytes = Buffer.from(file.sig, 'base64')
    bytes[10] = bytes[10] === 0 ? 1 : 0
    expect(read(JSON.stringify({ ...file, sig: bytes.toString('base64') }), '1.0.0')).toBeNull()
  })

  test('a signature of the same bytes without the prefix', () => {
    expect(read(signed(BOTH, KEY.privateKey, ''), '1.0.0')).toBeNull()
  })

  test('a signature of the wrong length', () => {
    const file = JSON.parse(signed(BOTH))
    expect(read(JSON.stringify({ ...file, sig: 'AAAA' }), '1.0.0')).toBeNull()
  })
})

describe('the file has no way to carry words or a link', () => {
  test('fields beyond the versions leave the answer as it was', () => {
    const body = {
      ...BOTH,
      url: 'https://example.com/steal',
      message: 'Type your recovery phrase',
      ios: { ...BOTH.ios, url: 'https://example.com/steal', message: 'Type your recovery phrase' },
    }
    expect(read(signed(body), '1.1.0')).toEqual({ level: 'normal', latest: '1.2.0' })
    expect(read(signed(body), '1.0.0')).toEqual({ level: 'critical' })
  })
})

// The publisher's test in the site repository carries the same vector, signed once by a key that
// was thrown away, so neither side can change the format alone.
describe('the vector shared with the publisher', () => {
  const VECTOR = {
    publicKey: 'AcKD19ap++fGHYX/trXq0vEXPwVWqrDN41PRGwDTPjQ=',
    file: {
      payload:
        'eyJ2IjoxLCJpb3MiOnsibGF0ZXN0IjoiMS4yLjAiLCJjcml0aWNhbCI6IjEuMC4zIn0sImFuZHJvaWQiOnsibGF0ZXN0IjoiMS4yLjAiLCJjcml0aWNhbCI6IjEuMC4zIn19',
      sig: 'Bus63bhQCgpBMguGK2ESiyrdS/DQoLujMnZqk3PcPp+68CgzJ9gv+cqfZ3IwcigXMFJMkICrG1r7ePny/XXODw==',
    },
  }

  test('passes under its key on each platform', () => {
    const text = JSON.stringify(VECTOR.file)
    for (const platform of ['ios', 'android']) {
      expect(noticeFromFile(text, { installed: '1.1.0', platform, publicKey: VECTOR.publicKey })).toEqual({
        level: 'normal',
        latest: '1.2.0',
      })
      expect(noticeFromFile(text, { installed: '1.0.2', platform, publicKey: VECTOR.publicKey })).toEqual({
        level: 'critical',
      })
    }
  })

  test('says nothing under the key built into the app', () => {
    expect(noticeFromFile(JSON.stringify(VECTOR.file), { installed: '1.0.2', platform: 'ios' })).toBeNull()
  })
})

describe('the read', () => {
  const realFetch = global.fetch
  const fetchMock = jest.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    global.fetch = realFetch
    jest.useRealTimers()
  })

  test('a network failure says nothing', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'))
    await expect(readUpdateNotice()).resolves.toBeNull()
  })

  test('a 404 says nothing, whatever its body is', async () => {
    fetchMock.mockResolvedValue(new Response('<html>not found</html>', { status: 404 }))
    await expect(readUpdateNotice()).resolves.toBeNull()
  })

  test('a body that fails to arrive says nothing', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: () => Promise.reject(new TypeError('Network request failed')) })
    await expect(readUpdateNotice()).resolves.toBeNull()
  })

  test('a page that answers 200 with HTML says nothing', async () => {
    fetchMock.mockResolvedValue(new Response('<html></html>', { status: 200 }))
    await expect(readUpdateNotice()).resolves.toBeNull()
  })

  test('five seconds without an answer say nothing, and the request is let go', async () => {
    jest.useFakeTimers()
    let signal: AbortSignal | undefined
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined
      return new Promise(() => undefined)
    })
    const answer = jest.fn()
    readUpdateNotice().then(answer)
    await jest.advanceTimersByTimeAsync(4_999)
    expect(answer).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    expect(answer).toHaveBeenCalledWith(null)
    expect(signal?.aborted).toBe(true)
  })

  test('control: a signed file over the same path is an answer', async () => {
    fetchMock.mockResolvedValue(new Response(signed(BOTH), { status: 200 }))
    await expect(
      readUpdateNotice({ installed: '1.0.0', platform: 'ios', publicKey: KEY.publicKey }),
    ).resolves.toEqual({ level: 'critical' })
  })

  test('the same file under the key built into the app is not', async () => {
    fetchMock.mockResolvedValue(new Response(signed(BOTH), { status: 200 }))
    await expect(readUpdateNotice({ installed: '1.0.0', platform: 'ios' })).resolves.toBeNull()
  })

  test('nothing leaves but a bare GET of the fixed address', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))
    await readUpdateNotice()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://www.usevoltz.app/app-notice.json')
    const { signal, ...sent } = init
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(sent).toEqual({ method: 'GET', credentials: 'omit' })
  })
})

describe('the store link', () => {
  const realOS = Platform.OS

  afterEach(() => {
    Platform.OS = realOS
  })

  test('is the fixed address of each platform store', () => {
    Platform.OS = 'ios'
    expect(storeUrl()).toBe('itms-apps://apps.apple.com/app/id6825551866')
    Platform.OS = 'android'
    expect(storeUrl()).toBe('market://details?id=app.usevoltz')
  })
})
