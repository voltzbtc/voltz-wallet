import {
  USERNAME_ADJECTIVES,
  USERNAME_ANIMALS,
  isLightningAddress,
  couldBeAddress,
  couldBeWholeAddress,
  probeLightningAddress,
  verifyLightningAddress,
  normalizeUsername,
  validateUsername,
  randomUsername,
  buildRegistrationMessage,
  buildRegistrationBody,
  defaultAddressDescription,
} from '../src/wallet/lnaddress'

describe('normalizeUsername', () => {
  it('converts to lowercase', () => {
    expect(normalizeUsername('Johndoe')).toBe('johndoe')
  })

  it('removes surrounding whitespace', () => {
    expect(normalizeUsername('  johndoe  ')).toBe('johndoe')
  })
})

// The cases of parse_domain in the SDK's lnurl.rs, which reduces the configured domain to its authority.
describe('defaultAddressDescription', () => {
  test.each([
    ['usevoltz.app', 'Pay to bob@usevoltz.app'],
    ['Pay.A.COM', 'Pay to bob@pay.a.com'],
    ['https://pay.a.com/', 'Pay to bob@pay.a.com'],
    ['https://pay.a.com/lnurl?x=1#y', 'Pay to bob@pay.a.com'],
    ['https://user:secret@pay.a.com', 'Pay to bob@pay.a.com'],
    ['pay.a.com:8443', 'Pay to bob@pay.a.com:8443'],
    ['pay.a.com:443', 'Pay to bob@pay.a.com'],
    ['https://pay.a.com:443', 'Pay to bob@pay.a.com'],
    ['http://pay.a.com:80', 'Pay to bob@pay.a.com'],
    ['http://pay.a.com:443', 'Pay to bob@pay.a.com:443'],
  ])('names the authority of %s', (domain, description) => {
    expect(defaultAddressDescription('bob', domain)).toBe(description)
  })

  // The SDK's URL parser writes a non-ASCII host in punycode. The expected values are Node's
  // url.domainToASCII, which follows the same non-transitional UTS 46 processing.
  test.each([
    ['bücher.de', 'Pay to bob@xn--bcher-kva.de'],
    ['https://Bücher.DE/', 'Pay to bob@xn--bcher-kva.de'],
    ['münchen.de:8443', 'Pay to bob@xn--mnchen-3ya.de:8443'],
    ['https://münchen.de:443', 'Pay to bob@xn--mnchen-3ya.de'],
    ['pay.ñandú.com.ar', 'Pay to bob@pay.xn--and-6ma2c.com.ar'],
    ['straße.de', 'Pay to bob@xn--strae-oqa.de'],
    ['пример.рф', 'Pay to bob@xn--e1afmkfd.xn--p1ai'],
    ['例え.テスト', 'Pay to bob@xn--r8jz45g.xn--zckzah'],
    ['bücher。de', 'Pay to bob@xn--bcher-kva.de'],
    // Composed and decomposed ü are one host to the SDK.
    ['bücher.de', 'Pay to bob@xn--bcher-kva.de'],
  ])('names the non-ASCII host %s in punycode', (domain, description) => {
    expect(defaultAddressDescription('bob', domain)).toBe(description)
  })

  it('names the username the SDK sends, trimmed and in lower case', () => {
    expect(defaultAddressDescription('  Bob ', 'usevoltz.app')).toBe('Pay to bob@usevoltz.app')
  })
})

describe('validateUsername', () => {
  it('accepts lowercase letters and digits', () => {
    expect(validateUsername('johndoe123')).toBe(true)
  })

  it('accepts dot, hyphen and underscore (allowed in LUD-16)', () => {
    expect(validateUsername('john.doe')).toBe(true)
    expect(validateUsername('john-doe')).toBe(true)
    expect(validateUsername('john_doe')).toBe(true)
  })

  it('accepts uppercase because it normalizes first', () => {
    expect(validateUsername('Johndoe')).toBe(true)
  })

  it('accepts exactly 64 chars (upper boundary)', () => {
    expect(validateUsername('a'.repeat(64))).toBe(true)
  })

  it('rejects more than 64 chars', () => {
    expect(validateUsername('a'.repeat(65))).toBe(false)
  })

  it('rejects empty string', () => {
    expect(validateUsername('')).toBe(false)
  })

  it('rejects whitespace only', () => {
    expect(validateUsername('   ')).toBe(false)
  })

  it('rejects whitespace in the middle', () => {
    expect(validateUsername('john doe')).toBe(false)
  })

  it('rejects at-sign and other symbols', () => {
    expect(validateUsername('john@doe')).toBe(false)
    expect(validateUsername('john/doe')).toBe(false)
  })

  it('rejects accents and non-ascii', () => {
    expect(validateUsername('cafe')).toBe(true)
    expect(validateUsername('café')).toBe(false)
    expect(validateUsername('джондо')).toBe(false)
  })
})

describe('buildRegistrationMessage', () => {
  it('builds the message without username', () => {
    expect(buildRegistrationMessage(1000, 'https://nds.usevoltz.app/x')).toBe(
      '1000-https://nds.usevoltz.app/x',
    )
  })

  it('builds the message with username', () => {
    expect(buildRegistrationMessage(1000, 'https://nds.usevoltz.app/x', 'johndoe')).toBe(
      '1000-https://nds.usevoltz.app/x-johndoe',
    )
  })

  it('normalizes the username in the message to match the sent body', () => {
    expect(buildRegistrationMessage(1000, 'https://nds.usevoltz.app/x', 'Johndoe')).toBe(
      '1000-https://nds.usevoltz.app/x-johndoe',
    )
  })

  it('treats empty username as absent', () => {
    expect(buildRegistrationMessage(1000, 'https://nds.usevoltz.app/x', '')).toBe(
      '1000-https://nds.usevoltz.app/x',
    )
  })
})

describe('buildRegistrationBody', () => {
  it('uses webhook_url in snake_case (matches the server json tag)', () => {
    const body = buildRegistrationBody(1000, 'https://nds.usevoltz.app/x', 'sig')
    expect(body).toEqual({
      time: 1000,
      webhook_url: 'https://nds.usevoltz.app/x',
      signature: 'sig',
    })
  })

  it('includes the normalized username when present', () => {
    const body = buildRegistrationBody(1000, 'https://nds.usevoltz.app/x', 'sig', 'Johndoe')
    expect(body.username).toBe('johndoe')
  })

  it('omits the username when absent', () => {
    const body = buildRegistrationBody(1000, 'https://nds.usevoltz.app/x', 'sig')
    expect('username' in body).toBe(false)
  })
})

describe('randomUsername', () => {
  it('reads as adjective + animal + two digits (Wallet-of-Satoshi style)', () => {
    expect(randomUsername()).toMatch(/^[a-z]+\d{2}$/)
  })

  it('always produces a valid LUD-16 username', () => {
    // One stray character in the word list would slip an unregistrable default past ensure().
    for (let i = 0; i < 200; i++) {
      expect(validateUsername(randomUsername())).toBe(true)
    }
  })

  it('varies between calls', () => {
    const names = new Set(Array.from({ length: 20 }, () => randomUsername()))
    expect(names.size).toBeGreaterThan(1)
  })

  it('refuses a draw that fell back to Math.random', () => {
    const spy = jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(array => {
      const view = array as Uint8Array
      for (let i = 0; i < view.length; i += 1) {
        view[i] = Math.floor(Math.random() * 256)
      }
      return array
    })
    try {
      expect(() => randomUsername()).toThrow('non-crypto RNG')
    } finally {
      spy.mockRestore()
    }
  })
})

// The gateway gives away the generated address for free and charges for a chosen one. It tells them
// apart by shape, not by holding a copy of these lists, so a word of a different length here would
// make new wallets pay for their own address. This is the only thing that catches that.
describe('generated names stay inside the shape the gateway calls free', () => {
  const GATEWAY_SHAPE = /^[a-z]{8,12}\d{2}$/

  it('every adjective and animal pairing fits', () => {
    const outside = USERNAME_ADJECTIVES.flatMap(a =>
      USERNAME_ANIMALS.flatMap(n => [`${a}${n}10`, `${a}${n}99`].filter(u => !GATEWAY_SHAPE.test(u))),
    )
    expect(outside).toEqual([])
  })

  it('what the generator actually returns fits too', () => {
    for (let i = 0; i < 200; i++) {
      expect(randomUsername()).toMatch(GATEWAY_SHAPE)
    }
  })
})

describe('isLightningAddress', () => {
  test.each(['maria@usevoltz.app', 'Maria@Usevoltz.App', ' a.b-c_d@pay.example.com '])('%s is one', value => {
    expect(isLightningAddress(value)).toBe(true)
  })

  test.each([
    '',
    'maria',
    'maria@',
    '@usevoltz.app',
    'maria@usevoltz',
    'ma ria@usevoltz.app',
    'alice@!!!',
    'a@b@usevoltz.app',
    `${'a'.repeat(65)}@usevoltz.app`,
  ])('%s is not', value => {
    expect(isLightningAddress(value)).toBe(false)
  })
})

describe('couldBeWholeAddress', () => {
  test.each(['bob@x.co', 'bob@x.com', 'b!b@x.com', ' bob@x.com '])('%p can be whole', value => {
    expect(couldBeWholeAddress(value)).toBe(true)
  })

  test.each(['', 'b', 'bob', 'bob@', 'bob@x', 'bob@x.', 'bob@x.c', '@x.com', 'bob@x.c@y.com'])(
    '%p is still on its way',
    value => {
      expect(couldBeWholeAddress(value)).toBe(false)
    },
  )
})

describe('verifyLightningAddress', () => {
  const realFetch = global.fetch
  const fetching = jest.fn()
  const refused = jest.fn(async () => 'other' as const)

  beforeEach(() => {
    fetching.mockReset()
    refused.mockClear()
    global.fetch = fetching as unknown as typeof fetch
  })
  afterEach(() => {
    global.fetch = realFetch
    jest.useRealTimers()
  })

  test('an address the SDK can read is good, with nothing more asked', async () => {
    expect(await verifyLightningAddress('maria@usevoltz.app', async () => 'lightningAddress')).toBe('ok')
    expect(fetching).not.toHaveBeenCalled()
  })

  // The SDK reads the name's BIP-353 record only after the LNURL read failed, which may be a server that
  // is down, so a payment found there is asked of the server like a refusal.
  test.each(['bitcoinAddress', 'sparkAddress', 'bolt11', 'wrongNetwork'] as const)(
    'a %s found under the name is no lightning address, and its server says whether one is there',
    async kind => {
      fetching.mockResolvedValueOnce({ status: 404 })
      expect(await verifyLightningAddress('maria@usevoltz.app', async () => kind)).toBe('wrong')
      fetching.mockRejectedValueOnce(new TypeError('Network request failed'))
      expect(await verifyLightningAddress('maria@usevoltz.app', async () => kind)).toBe('unreachable')
      expect(fetching).toHaveBeenCalledTimes(2)
    },
  )

  test('text that cannot be an address reaches neither the SDK nor the network', async () => {
    expect(await verifyLightningAddress('maria@usevoltz', refused)).toBe('wrong')
    expect(refused).not.toHaveBeenCalled()
    expect(fetching).not.toHaveBeenCalled()
  })

  test.each([
    [200, 'unreachable'],
    [204, 'unreachable'],
    [400, 'wrong'],
    [404, 'wrong'],
    [410, 'wrong'],
    [429, 'unreachable'],
    [499, 'unreachable'],
    [500, 'unreachable'],
    [503, 'unreachable'],
  ])('a refusal with the server answering %i is %s', async (status, verdict) => {
    fetching.mockResolvedValue({ status })
    expect(await verifyLightningAddress('maria@usevoltz.app', refused)).toBe(verdict)
  })

  test('a refusal with no way to reach the server says nothing of the address', async () => {
    fetching.mockRejectedValue(new TypeError('Network request failed'))
    expect(await verifyLightningAddress('maria@usevoltz.app', refused)).toBe('unreachable')
  })

  test('a parse that names a server it could not read is asked of the server all the same', async () => {
    fetching.mockRejectedValue(new TypeError('Network request failed'))
    expect(await verifyLightningAddress('maria@usevoltz.app', async () => 'unread')).toBe('unreachable')
    expect(fetching).toHaveBeenCalledTimes(1)
  })

  test('a classification that rejects is no verdict either', async () => {
    const broken = async (): Promise<'other'> => {
      throw new Error('spark not connected')
    }
    expect(await verifyLightningAddress('maria@usevoltz.app', broken)).toBe('unreachable')
    expect(fetching).not.toHaveBeenCalled()
  })

  test('asks the same URL the SDK does, in lowercase', async () => {
    fetching.mockResolvedValue({ status: 404 })
    await verifyLightningAddress(' Maria@UseVoltz.App ', refused)
    expect(fetching).toHaveBeenCalledWith('https://usevoltz.app/.well-known/lnurlp/maria')
    expect(refused).toHaveBeenCalledWith('Maria@UseVoltz.App')
  })

  test('a Tor domain goes over http, as the SDK does', async () => {
    fetching.mockResolvedValue({ status: 404 })
    await verifyLightningAddress('maria@abc.onion', refused)
    expect(fetching).toHaveBeenCalledWith('http://abc.onion/.well-known/lnurlp/maria')
  })

  test.each([
    ['a probe', () => verifyLightningAddress('maria@usevoltz.app', refused)],
    ['a classification', () => verifyLightningAddress('maria@usevoltz.app', () => new Promise(() => undefined))],
  ])('%s with no answer ends at the limit', async (_name, check) => {
    jest.useFakeTimers()
    fetching.mockReturnValue(new Promise(() => undefined))
    const settled = jest.fn()
    check().then(settled)
    await jest.advanceTimersByTimeAsync(4_999)
    expect(settled).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    expect(settled).toHaveBeenCalledWith('unreachable')
  })
})

describe('couldBeAddress', () => {
  test.each(['ana@usevoltz.app', '₿ana@usevoltz.app', ' ana@usevoltz.app ', 'josé@usevoltz.app', 'ana+1@voltz.co'])(
    'lets the parser judge %s',
    text => {
      expect(couldBeAddress(text)).toBe(true)
    },
  )

  test.each(['ana', 'ana@', '@usevoltz.app', 'ana@voltz', 'ana@.app', 'ana@voltz.', 'a b@voltz.app', 'a@b@c.app'])(
    'spares the request for %s',
    text => {
      expect(couldBeAddress(text)).toBe(false)
    },
  )
})

describe('probeLightningAddress', () => {
  const realFetch = global.fetch
  const fetching = jest.fn()

  beforeEach(() => {
    fetching.mockReset()
    global.fetch = fetching as unknown as typeof fetch
  })
  afterEach(() => {
    global.fetch = realFetch
    jest.useRealTimers()
  })

  test.each([400, 404, 410])('a %i denies the address', async status => {
    fetching.mockResolvedValue({ status })

    expect(await probeLightningAddress('maria@usevoltz.app')).toBe('wrong')
  })

  test.each([200, 301, 403, 408, 429, 502])('a %i says nothing against it', async status => {
    fetching.mockResolvedValue({ status })

    expect(await probeLightningAddress('maria@usevoltz.app')).toBe('unreachable')
  })

  test('asks the server of the address, past the bitcoin sign, with the name encoded', async () => {
    fetching.mockResolvedValue({ status: 404 })

    await probeLightningAddress('₿Ana+1@usevoltz.app')

    expect(fetching).toHaveBeenCalledWith('https://usevoltz.app/.well-known/lnurlp/ana%2B1')
  })

  test('no network is no verdict', async () => {
    fetching.mockRejectedValue(new TypeError('Network request failed'))

    expect(await probeLightningAddress('maria@usevoltz.app')).toBe('unreachable')
  })

  test('silence past the limit is no verdict', async () => {
    jest.useFakeTimers()
    fetching.mockReturnValue(new Promise(() => undefined))

    const answer = probeLightningAddress('maria@usevoltz.app')
    await jest.advanceTimersByTimeAsync(5_000)

    expect(await answer).toBe('unreachable')
  })
})
