import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { getBreezLnurlDomain } from '../src/config'
import {
  NAME_STATE_TIMEOUT_MS,
  keyStep,
  nameStateMessage,
  nextStep,
  parseNameState,
  readKeyState,
  readNameState,
  type NameState,
} from '../src/wallet/nameState'

jest.mock('../src/config', () => ({ getBreezLnurlDomain: jest.fn(() => 'usevoltz.app') }))

const HOST = 'usevoltz.app'
const N = 'padaria'
const G = 'swiftotter42'
const PUB = `02${'a'.repeat(64)}`
const NOW = 1_800_000_000

// Copied from the gateway's test/nameState.test.ts, where nameStateMessage is the specification.
// Both suites stay green when only one side changes the statement, so this copy is what notices.
const VECTOR = {
  host: 'usevoltz.app',
  pubkey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  name: 'padaria',
  timestamp: 1_700_000_000,
  bytes:
    '766f6c747a2d6e616d653a76310a73746174650a757365766f6c747a2e6170700a303237396265363637656639646362626163' +
    '35356130363239356365383730623037303239626663646232646365323864393539663238313562313666383137393' +
    '80a706164617269610a31373030303030303030',
  digest: '2235956eec2c2644fd8d2e51941196376a0e7573bfe51aa5c4247b4bdd7b6e2d',
}

// The read about the key alone, copied from the same gateway suite: the name line is empty.
const KEY_VECTOR = {
  host: 'usevoltz.app',
  pubkey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  timestamp: 1_700_000_000,
  bytes:
    '766f6c747a2d6e616d653a76310a73746174650a757365766f6c747a2e6170700a303237396265363637656639646362626163' +
    '35356130363239356365383730623037303239626663646232646365323864393539663238313562313666383137393' +
    '80a0a31373030303030303030',
  digest: '800c3ee67c9dfad7c43f9814d43eac30135f3451b5e0a89e77d41bae81da6627',
}

function reply(over: Partial<NameState> = {}): Record<string, unknown> {
  return {
    host: HOST,
    name: N,
    live: null,
    takenBack: { closedBy: 'refund', closedAt: NOW - 600 },
    given: G,
    givenHeldBy: 'you',
    serverNow: NOW,
    ...over,
  }
}

function answer(status: number, body: unknown): typeof fetch {
  return jest.fn(async () => ({ status, ok: status < 300, json: async () => body })) as never
}

const deps = (request: typeof fetch, sign = jest.fn(async () => 'sig')) => ({
  pubkey: PUB,
  sign,
  now: () => NOW * 1000,
  request,
})

beforeEach(() => {
  jest.mocked(getBreezLnurlDomain).mockReturnValue(HOST)
})

describe('the statement', () => {
  test('matches the gateway golden vector byte for byte', () => {
    const statement = nameStateMessage(VECTOR.host, VECTOR.pubkey, VECTOR.name, VECTOR.timestamp)
    expect(bytesToHex(utf8ToBytes(statement))).toBe(VECTOR.bytes)
    expect(bytesToHex(sha256(utf8ToBytes(statement)))).toBe(VECTOR.digest)
    // The SDK refuses to sign the LNURL server's namespace.
    expect(statement.startsWith('breez-lnurl:')).toBe(false)
  })

  test('about the key alone matches the gateway golden vector byte for byte', () => {
    const statement = nameStateMessage(KEY_VECTOR.host, KEY_VECTOR.pubkey, '', KEY_VECTOR.timestamp)
    expect(bytesToHex(utf8ToBytes(statement))).toBe(KEY_VECTOR.bytes)
    expect(bytesToHex(sha256(utf8ToBytes(statement)))).toBe(KEY_VECTOR.digest)
  })
})

describe('parseNameState', () => {
  test('a whole reply about the name asked is an answer', () => {
    expect(parseNameState(reply(), HOST, N)).toEqual({
      host: HOST,
      name: N,
      live: null,
      // A gateway older than the withdrawal flag sends none, which reads as no withdrawal.
      takenBack: { closedBy: 'refund', closedAt: NOW - 600, withdrawal: false },
      given: G,
      givenHeldBy: 'you',
      // A gateway older than the field never sends it.
      askedHeldBy: null,
      serverNow: NOW,
    })
    expect(parseNameState(reply({ askedHeldBy: 'another' }), HOST, N)?.askedHeldBy).toBe('another')
    expect(parseNameState(reply({ askedHeldBy: null }), HOST, N)?.askedHeldBy).toBeNull()
    expect(
      parseNameState(reply({ takenBack: null, given: null, givenHeldBy: null }), HOST, N),
    ).toMatchObject({
      takenBack: null,
      given: null,
      givenHeldBy: null,
    })
  })

  test('a name taken back by the buyer\'s withdrawal says so, and is still a refund\'s take-back', () => {
    const withdrawn = { closedBy: 'refund', closedAt: NOW - 600, withdrawal: true }
    expect(parseNameState(reply({ takenBack: withdrawn as never }), HOST, N)?.takenBack).toEqual(withdrawn)
    expect(
      parseNameState(reply({ takenBack: { closedBy: 'refund', closedAt: NOW, withdrawal: false } as never }), HOST, N)?.takenBack,
    ).toEqual({ closedBy: 'refund', closedAt: NOW, withdrawal: false })
    // Only true is a withdrawal; any other value is a gateway field this build reads as absent.
    expect(
      parseNameState(reply({ takenBack: { closedBy: 'refund', closedAt: NOW, withdrawal: 'yes' } as never }), HOST, N)?.takenBack,
    ).toEqual({ closedBy: 'refund', closedAt: NOW, withdrawal: false })
    // The name is gone either way, so the next step is the one a refund takes.
    const state = parseNameState(reply({ takenBack: withdrawn as never }), HOST, N)
    expect(nextStep(state, N)).toEqual(nextStep(parseNameState(reply(), HOST, N), N))
    expect(nextStep(state, N)).toEqual({ kind: 'registerGiven', username: G })
  })

  test.each<[string, unknown]>([
    ['not an object', 'ok'],
    ['null', null],
    ['an array', [reply()]],
    ['about another host', reply({ host: 'outro.app' })],
    ['about another name', reply({ name: G })],
    ['live missing', { ...reply(), live: undefined }],
    ['live of another type', reply({ live: 7 as never })],
    ['live not in the exact form', reply({ live: 'Padaria' })],
    ['takenBack of another type', reply({ takenBack: 'refund' as never })],
    [
      'takenBack for a reason not known',
      reply({ takenBack: { closedBy: 'chargeback', closedAt: NOW } as never }),
    ],
    ['takenBack with no date', reply({ takenBack: { closedBy: 'refund' } as never })],
    ['given not in the exact form', reply({ given: 'swift otter' })],
    ['given with no holder', reply({ givenHeldBy: null })],
    ['a holder with no given', reply({ given: null, givenHeldBy: 'you' })],
    ['a holder word not known', reply({ givenHeldBy: 'me' as never })],
    ['no clock', { ...reply(), serverNow: undefined }],
    ['a clock that is not a number', reply({ serverNow: String(NOW) as never })],
    ['an askedHeldBy word not known', reply({ askedHeldBy: 'me' as never })],
    ['an askedHeldBy of another type', reply({ askedHeldBy: 1 as never })],
    ['about the key alone when a name was asked', reply({ name: null, takenBack: null })],
  ])('a reply with %s is no answer', (_what, body) => {
    expect(parseNameState(body, HOST, N)).toBeNull()
  })

  const keyReply = (over: Partial<NameState> = {}) =>
    reply({ name: null, takenBack: null, askedHeldBy: null, ...over })

  test('a whole reply about the key alone is an answer', () => {
    expect(parseNameState(keyReply(), HOST, null)).toEqual({
      host: HOST,
      name: null,
      live: null,
      takenBack: null,
      given: G,
      givenHeldBy: 'you',
      askedHeldBy: null,
      serverNow: NOW,
    })
    expect(parseNameState({ ...keyReply(), askedHeldBy: undefined }, HOST, null)).not.toBeNull()
  })

  test.each<[string, unknown]>([
    ['about a name', reply({ takenBack: null })],
    ['with a name taken back', keyReply({ takenBack: { closedBy: 'refund', closedAt: NOW } })],
    ['with a holder of a name', keyReply({ askedHeldBy: 'you' })],
    ['about another host', keyReply({ host: 'outro.app' })],
  ])('a reply about the key alone %s is no answer', (_what, body) => {
    expect(parseNameState(body, HOST, null)).toBeNull()
  })
})

describe('readNameState', () => {
  test('signs the statement for the fields it sends and posts them to the build domain', async () => {
    const request = answer(200, reply())
    const sign = jest.fn(async () => 'sig')

    expect(await readNameState(deps(request, sign), HOST, N)).toMatchObject({ given: G })

    expect(sign).toHaveBeenCalledWith(nameStateMessage(HOST, PUB, N, NOW))
    const [url, init] = jest.mocked(request).mock.calls[0]
    expect(url).toBe('https://usevoltz.app/api/name/state')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      host: HOST,
      name: N,
      pubkey: PUB,
      signature: 'sig',
      timestamp: NOW,
    })
  })

  test('a custom host is asked about at the build domain, never at itself', async () => {
    const request = answer(200, { ...reply(), host: 'pay.bakery.com.br' })

    await readNameState(deps(request), 'pay.bakery.com.br', N)

    expect(jest.mocked(request).mock.calls[0][0]).toBe('https://usevoltz.app/api/name/state')
  })

  test('with no build domain nothing is signed or sent', async () => {
    jest.mocked(getBreezLnurlDomain).mockReturnValue(undefined)
    const request = answer(200, reply())
    const sign = jest.fn(async () => 'sig')

    expect(await readNameState(deps(request, sign), HOST, N)).toBeNull()
    expect(sign).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  test.each<[string, typeof fetch]>([
    ['a network error', jest.fn(async () => Promise.reject(new Error('offline'))) as never],
    ['401', answer(401, { error: 'invalid_signature' })],
    ['503', answer(503, { error: 'name_holder_unavailable' })],
    ['404 from a gateway without the route', answer(404, { error: 'not_found' })],
    ['a 200 that is not the reply', answer(200, '<html>ok</html>')],
    [
      'a body that is not JSON',
      jest.fn(async () => ({
        status: 200,
        json: async () => Promise.reject(new SyntaxError('bad')),
      })) as never,
    ],
  ])('%s is no answer, and never a rejection', async (_what, request) => {
    await expect(readNameState(deps(request), HOST, N)).resolves.toBeNull()
  })

  test('a signature the wallet refuses to make is no answer, and nothing is sent', async () => {
    const request = answer(200, reply())
    const sign = jest.fn(async () =>
      Promise.reject(new Error('spark connected as another identity')),
    )

    await expect(readNameState(deps(request, sign), HOST, N)).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  test('a gateway that never answers is no answer after the timeout, and the request is aborted', async () => {
    jest.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const request = jest.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined
        return new Promise<Response>(() => {})
      })
      let settled: NameState | null | 'pending' = 'pending'
      const read = readNameState(deps(request as never), HOST, N).then(value => {
        settled = value
      })

      await jest.advanceTimersByTimeAsync(NAME_STATE_TIMEOUT_MS - 1)
      expect(settled).toBe('pending')
      await jest.advanceTimersByTimeAsync(1)
      await read

      expect(settled).toBeNull()
      expect(signal?.aborted).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('readKeyState', () => {
  const keyBody = { ...reply({ name: null, takenBack: null }), askedHeldBy: null }

  test('signs the statement with the name line empty and sends no name', async () => {
    const request = answer(200, keyBody)
    const sign = jest.fn(async () => 'sig')

    expect(await readKeyState(deps(request, sign), HOST)).toMatchObject({ name: null, given: G })

    expect(sign).toHaveBeenCalledWith(nameStateMessage(HOST, PUB, '', NOW))
    expect(sign.mock.calls[0]).toEqual([['voltz-name:v1', 'state', HOST, PUB, '', String(NOW)].join('\n')])
    const [url, init] = jest.mocked(request).mock.calls[0]
    expect(url).toBe('https://usevoltz.app/api/name/state')
    const sent = JSON.parse(String(init?.body))
    expect(sent).toEqual({ host: HOST, pubkey: PUB, signature: 'sig', timestamp: NOW })
    expect('name' in sent).toBe(false)
  })

  test.each<[string, typeof fetch]>([
    ['a gateway older than the read, which refuses a body with no name', answer(400, { error: 'missing_fields' })],
    ['a gateway without the route', answer(404, { error: 'not_found' })],
    ['a 503', answer(503, { error: 'name_holder_unavailable' })],
    ['an answer about a name', answer(200, reply())],
    ['a network failure', jest.fn(async () => Promise.reject(new Error('offline'))) as never],
  ])('%s is no answer', async (_what, request) => {
    expect(await readKeyState(deps(request), HOST)).toBeNull()
  })
})

describe('keyStep', () => {
  const state = (over: Partial<NameState> = {}): NameState =>
    parseNameState(
      { ...reply({ name: null, takenBack: null }), askedHeldBy: null, ...over },
      HOST,
      null,
    )!

  test('no answer mints, as before', () => {
    expect(keyStep(null)).toEqual({ kind: 'mint' })
  })

  test('a live address is noted and nothing is registered over it, whichever name it is', () => {
    expect(keyStep(state({ live: N }))).toEqual({ kind: 'noteLive', username: N })
    expect(keyStep(state({ live: G }))).toEqual({ kind: 'noteLive', username: G })
    expect(keyStep(state({ live: N, given: null, givenHeldBy: null }))).toEqual({
      kind: 'noteLive',
      username: N,
    })
  })

  test('a first name held for this wallet, or by nobody, is registered and never a generated one', () => {
    expect(keyStep(state())).toEqual({ kind: 'registerGiven', username: G })
    expect(keyStep(state({ givenHeldBy: 'nobody' }))).toEqual({ kind: 'registerGiven', username: G })
  })

  test('no first name mints, as a new wallet does', () => {
    expect(keyStep(state({ given: null, givenHeldBy: null }))).toEqual({ kind: 'mint' })
  })

  test('a first name held by another wallet registers nothing, and says why', () => {
    expect(keyStep(state({ givenHeldBy: 'another' }))).toEqual({
      kind: 'stop',
      warn: 'given_held_by_another',
    })
  })
})

describe('nextStep', () => {
  const state = (over: Partial<NameState> = {}): NameState => parseNameState(reply(over), HOST, N)!

  test('no answer claims the remembered name back, as before', () => {
    expect(nextStep(null, N)).toEqual({ kind: 'claimHeld' })
  })

  test('a name live for this wallet that is not its first is left alone, whatever else is said', () => {
    expect(nextStep(state({ live: N }), N)).toEqual({ kind: 'stop' })
    expect(nextStep(state({ live: 'mercearia' }), N)).toEqual({ kind: 'stop' })
    expect(nextStep(state({ live: N, takenBack: null }), N)).toEqual({ kind: 'stop' })
    expect(nextStep(state({ live: 'mercearia', given: null, givenHeldBy: null }), N)).toEqual({
      kind: 'stop',
    })
  })

  test('the first name live for this wallet is registered again, even beside a name taken back', () => {
    expect(nextStep(state({ live: G }), N)).toEqual({ kind: 'registerGiven', username: G })
  })

  test('nothing taken back claims the remembered name back, as before', () => {
    expect(nextStep(state({ takenBack: null }), N)).toEqual({ kind: 'claimHeld' })
  })

  test('a name taken back with a first name to go to registers that one', () => {
    expect(nextStep(state(), N)).toEqual({ kind: 'registerGiven', username: G })
    expect(nextStep(state({ givenHeldBy: 'nobody' }), N)).toEqual({
      kind: 'registerGiven',
      username: G,
    })
  })

  test('a name taken back with no first name runs the generated-name loop', () => {
    expect(nextStep(state({ given: null, givenHeldBy: null }), N)).toEqual({ kind: 'mint' })
  })

  test('a first name held for another wallet is not asked for, and says why', () => {
    expect(nextStep(state({ givenHeldBy: 'another' }), N)).toEqual({
      kind: 'stop',
      warn: 'given_held_by_another',
    })
  })

  test('the name taken back is never the one registered, even when it was the first', () => {
    expect(nextStep(state({ given: N }), N)).toEqual({ kind: 'stop', warn: 'given_was_taken_back' })
  })

  test('a remembered name another wallet holds, as after a transfer, moves on like one taken back', () => {
    const moved = { takenBack: null, askedHeldBy: 'another' as const }
    expect(nextStep(state(moved), N)).toEqual({ kind: 'registerGiven', username: G })
    expect(nextStep(state({ ...moved, givenHeldBy: 'nobody' }), N)).toEqual({
      kind: 'registerGiven',
      username: G,
    })
    expect(nextStep(state({ ...moved, given: null, givenHeldBy: null }), N)).toEqual({ kind: 'mint' })
    // The name moved away was the first one: it is another wallet's, and nothing is registered.
    expect(nextStep(state({ ...moved, given: N, givenHeldBy: 'another' }), N)).toEqual({
      kind: 'stop',
      warn: 'given_held_by_another',
    })
    // Live still wins.
    expect(nextStep(state({ ...moved, live: 'mercearia' }), N)).toEqual({ kind: 'stop' })
  })

  test('a remembered name held for this wallet or by nobody, and not taken back, is claimed back as before', () => {
    expect(nextStep(state({ takenBack: null, askedHeldBy: 'you' }), N)).toEqual({ kind: 'claimHeld' })
    expect(nextStep(state({ takenBack: null, askedHeldBy: 'nobody' }), N)).toEqual({
      kind: 'claimHeld',
    })
  })
})
