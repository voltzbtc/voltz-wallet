import RNFS from 'react-native-fs'
import {
  changeDomainAccess,
  domainAccessMessage,
  domainListMessage,
  isWalletKey,
  listDomainWallets,
  loadLabels,
  parseWalletKey,
  saveLabel,
  walletCode,
  walletKeyUri,
  type DomainAccessDeps,
} from '../src/wallet/domainAccess'

const DOMAIN = 'pay.example.com'
const OWNER = `02${'a'.repeat(64)}`
const GUEST = `03${'b'.repeat(64)}`

function deps(over: Partial<DomainAccessDeps> = {}): DomainAccessDeps & {
  sent: string[]
  signed: string[]
} {
  const sent: string[] = []
  const signed: string[] = []
  return {
    sent,
    signed,
    gatewayUrl: `https://${DOMAIN}/`,
    domain: DOMAIN,
    ownerPubkey: OWNER,
    sign: async message => {
      signed.push(message)
      return 'deadbeef'
    },
    now: () => 1_700_000_000_000,
    request: (async (url: string, init: RequestInit) => {
      sent.push(`${url}|${String(init.body)}`)
      return {
        ok: true,
        status: 200,
        json: async () => ({ wallets: [{ pubkey: GUEST, grantedAt: 1 }] }),
      } as unknown as Response
    }) as unknown as typeof fetch,
    ...over,
  }
}

describe('the signed statements', () => {
  it('pins the action, the domain, the owner and the target', () => {
    expect(domainAccessMessage('authorize', DOMAIN, OWNER, GUEST, 1700).split('\n')).toEqual([
      'voltz-domain:v1',
      'authorize',
      DOMAIN,
      OWNER,
      GUEST,
      '1700',
    ])
  })

  it('makes a grant and a revoke different statements', () => {
    expect(domainAccessMessage('authorize', DOMAIN, OWNER, GUEST, 1700)).not.toEqual(
      domainAccessMessage('revoke', DOMAIN, OWNER, GUEST, 1700),
    )
  })

  it('makes a signature naming one wallet unusable for another', () => {
    const other = `02${'c'.repeat(64)}`
    expect(domainAccessMessage('authorize', DOMAIN, OWNER, GUEST, 1700)).not.toEqual(
      domainAccessMessage('authorize', DOMAIN, OWNER, other, 1700),
    )
  })

  it('cannot be replayed from reading to granting', () => {
    expect(domainListMessage(DOMAIN, OWNER, 1700)).not.toEqual(
      domainAccessMessage('authorize', DOMAIN, OWNER, OWNER, 1700),
    )
  })
})

describe('the code a person reads out loud', () => {
  it('is the same on both devices for the same wallet', () => {
    expect(walletCode(GUEST)).toEqual(walletCode(GUEST.toUpperCase()))
  })

  it('changes when the key changes, which is the whole point', () => {
    // A swapped key must not produce the same code, or the owner approves the wrong wallet.
    const swapped = `03${'b'.repeat(63)}c`
    expect(walletCode(GUEST)).not.toEqual(walletCode(swapped))
  })

  it('is twelve characters a person can read aloud, in three groups', () => {
    // Crockford's base32, without I, L, O and U.
    expect(walletCode(GUEST)).toMatch(/^[0-9A-HJKMNP-TV-Z]{4} [0-9A-HJKMNP-TV-Z]{4} [0-9A-HJKMNP-TV-Z]{4}$/)
  })

  it('is the first 60 bits of SHA-256 over the key, so a swapped key cannot be ground to match', () => {
    // Computed apart from this code: sha256 of the lowercase hex, first eight bytes shifted right by
    // four, in Crockford's base32. A 32-bit code fell to a few hours of grinding keys on a CPU.
    expect(walletCode(GUEST)).toBe('FBD2 M4DZ 3AGZ')
    expect(walletCode(OWNER)).toBe('8NN3 29M1 59AZ')
  })

  it('draws a code for text that is not a key rather than throwing in a render', () => {
    expect(walletCode('not a key')).toMatch(/^\S{4} \S{4} \S{4}$/)
  })
})

describe('reading a scanned wallet', () => {
  it('accepts the bare key and the uri form', () => {
    expect(parseWalletKey(GUEST)).toBe(GUEST)
    expect(parseWalletKey(walletKeyUri(GUEST))).toBe(GUEST)
    expect(parseWalletKey(`  ${GUEST.toUpperCase()}  `)).toBe(GUEST)
  })

  it('refuses anything that is not a wallet key', () => {
    for (const junk of ['', 'hello', GUEST.slice(0, 40), `04${'b'.repeat(64)}`, `02${'z'.repeat(64)}`]) {
      expect(parseWalletKey(junk)).toBeNull()
    }
  })

  it('refuses a lightning address, which is the likely mis-scan', () => {
    expect(parseWalletKey('maria@pay.example.com')).toBeNull()
  })
})

describe('talking to the gateway', () => {
  it('sends the grant to the routed prefix, signed', async () => {
    const d = deps()
    await changeDomainAccess(d, 'authorize', GUEST)
    const [url, body] = d.sent[0]!.split('|')
    expect(url).toBe(`https://${DOMAIN}/api/domain/access`)
    expect(JSON.parse(body!)).toMatchObject({ action: 'authorize', targetPubkey: GUEST, ownerPubkey: OWNER })
    expect(d.signed[0]).toBe(domainAccessMessage('authorize', DOMAIN, OWNER, GUEST, 1_700_000_000))
  })

  it('never signs anything for a key that is not a wallet', async () => {
    const d = deps()
    await expect(changeDomainAccess(d, 'authorize', 'nonsense')).rejects.toThrow('invalid_wallet_key')
    expect(d.signed).toEqual([])
    expect(d.sent).toEqual([])
  })

  it('surfaces the gateway reason rather than a bare failure', async () => {
    const d = deps({
      request: (async () =>
        ({
          ok: false,
          status: 403,
          json: async () => ({ error: 'only_the_owner_may_authorize' }),
        }) as unknown as Response) as unknown as typeof fetch,
    })
    await expect(changeDomainAccess(d, 'authorize', GUEST)).rejects.toThrow(
      'only_the_owner_may_authorize',
    )
  })

  it('reads the list with its own statement', async () => {
    const d = deps()
    expect(await listDomainWallets(d)).toEqual([{ pubkey: GUEST, grantedAt: 1 }])
    expect(d.signed[0]).toBe(domainListMessage(DOMAIN, OWNER, 1_700_000_000))
  })
})

describe('the names the owner gives', () => {
  beforeEach(async () => {
    const file = `${RNFS.DocumentDirectoryPath}/domain-wallet-labels.json`
    if (await RNFS.exists(file)) {
      await RNFS.unlink(file)
    }
  })

  it('are kept on this device and keyed regardless of case', async () => {
    await saveLabel(GUEST.toUpperCase(), '  Maria, front desk  ')
    expect(await loadLabels()).toEqual({ [GUEST]: 'Maria, front desk' })
  })

  it('are removed when cleared', async () => {
    await saveLabel(GUEST, 'Maria')
    await saveLabel(GUEST, '   ')
    expect(await loadLabels()).toEqual({})
  })

  it('do not grow without bound', async () => {
    await saveLabel(GUEST, 'x'.repeat(200))
    expect((await loadLabels())[GUEST]!.length).toBe(40)
  })
})

it('a wallet key is recognised only in the compressed form', () => {
  expect(isWalletKey(OWNER)).toBe(true)
  expect(isWalletKey(GUEST)).toBe(true)
  expect(isWalletKey(`04${'a'.repeat(128)}`)).toBe(false)
})
