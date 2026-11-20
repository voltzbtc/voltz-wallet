import fs from 'fs'
import path from 'path'
import { __setEmergencyExitLiveForTests } from '../src/wallet/emergencyExit'
import { broadcastPackage, broadcastTx, readFunding } from '../src/wallet/chainRelay'

const ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const PARENT = 'aa00'
const CHILD = 'bb11'
const TXID = 'ab'.repeat(32)
// The txid of the step sent, which a host is asked about only after it refused for an input.
const STEP = 'de'.repeat(32)
const WTXID_A = 'c1'.repeat(32)
const WTXID_B = 'c2'.repeat(32)

const MEMPOOL = 'https://mempool.space/api'
const BLOCKSTREAM = 'https://blockstream.info/api'

const response = (status: number, text: string): Response =>
  ({ status, ok: status >= 200 && status < 300, text: async () => text }) as Response

// Answers by host, so a test states what each one says. A host left out is unreachable, as fetch
// rejects with no response.
function hosts(answers: { mempool?: Response; blockstream?: Response }): jest.MockedFunction<typeof fetch> {
  return jest.fn(async (url: RequestInfo | URL) => {
    const answer = String(url).startsWith(MEMPOOL) ? answers.mempool : answers.blockstream
    if (!answer) {
      throw new TypeError('Network request failed')
    }
    return answer
  }) as unknown as jest.MockedFunction<typeof fetch>
}

// bitcoind's submitpackage result as the two hosts relay it: one entry per wtxid, each with its own
// error when it was not taken. The refusals are the reasons recover_funds.md lists.
const packageBody = (message: string, ...errors: (string | undefined)[]): string =>
  JSON.stringify({
    package_msg: message,
    'tx-results': Object.fromEntries(
      errors.map((error, i) => [
        i === 0 ? WTXID_A : WTXID_B,
        error === undefined
          ? { txid: TXID, vsize: 150, fees: { base: 0.000003 } }
          : { txid: TXID, error },
      ]),
    ),
    'replaced-transactions': [],
  })

const SUCCESS = packageBody('success', undefined, undefined)

beforeEach(() => __setEmergencyExitLiveForTests(true))
afterEach(() => {
  __setEmergencyExitLiveForTests(null)
  jest.useRealTimers()
})

describe('what a package answer means', () => {
  test('success on 200 is sent, by the first host, in parent then child order', async () => {
    const request = hosts({ mempool: response(200, SUCCESS) })
    expect(await broadcastPackage(PARENT, CHILD, STEP, { request })).toEqual({ status: 'sent', host: 'mempool.space' })
    expect(request).toHaveBeenCalledTimes(1)
    const [url, init] = request.mock.calls[0]
    expect(url).toBe(`${MEMPOOL}/v1/txs/package`)
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify([PARENT, CHILD]))
  })

  test.each([
    ['transaction failed', 'min relay fee not met, 0 < 110'],
    ['transaction failed', 'TRUC-violation, version=3 tx has unconfirmed ancestor'],
    ['transaction failed', 'non-BIP68-final'],
    ['transaction failed', 'mandatory-script-verify-flag-failed (Signature must be zero)'],
  ])('a 200 saying %s with %s is a refusal with its reason', async (message, error) => {
    const request = hosts({
      mempool: response(200, packageBody(message, error)),
      blockstream: response(200, packageBody(message, error)),
    })
    expect(await broadcastPackage(PARENT, CHILD, STEP, { request })).toEqual({ status: 'refused', reason: error })
  })

  test('a 200 with a package-wide reason and no transaction error is a refusal', async () => {
    const body = JSON.stringify({ package_msg: 'package-not-child-with-unconfirmed-parents', 'tx-results': {} })
    const request = hosts({ mempool: response(200, body), blockstream: response(200, body) })
    expect(await broadcastPackage(PARENT, CHILD, STEP, { request })).toEqual({
      status: 'refused',
      reason: 'package-not-child-with-unconfirmed-parents',
    })
  })

  test.each([
    'txn-already-in-mempool',
    'txn-already-known',
    'Transaction already in block chain',
    'Transaction outputs already in utxo set',
  ])('%s on every transaction counts as sent', async error => {
    const request = hosts({ mempool: response(200, packageBody('transaction failed', error, error)) })
    expect(await broadcastPackage(PARENT, CHILD, STEP, { request })).toEqual({ status: 'sent', host: 'mempool.space' })
  })

  test('a parent already known beside a child refused for its fee is a refusal', async () => {
    const body = packageBody('transaction failed', 'txn-already-known', 'min relay fee not met, 0 < 110')
    const request = hosts({ mempool: response(200, body), blockstream: response(200, body) })
    expect(await broadcastPackage(PARENT, CHILD, STEP, { request })).toEqual({
      status: 'refused',
      reason: 'min relay fee not met, 0 < 110',
    })
  })

  test('a parent already known beside an accepted child is sent', async () => {
    const request = hosts({
      mempool: response(200, packageBody('transaction failed', 'txn-already-known', undefined)),
    })
    expect((await broadcastPackage(PARENT, CHILD, STEP, { request })).status).toBe('sent')
  })

  test.each([
    ['not JSON', '<html>gateway</html>'],
    ['a list', '[]'],
    ['no package_msg', '{"tx-results":{}}'],
  ])('a 200 with %s is never sent', async (_name, body) => {
    const request = hosts({ mempool: response(200, body), blockstream: response(200, body) })
    expect(await broadcastPackage(PARENT, CHILD, STEP, { request })).toEqual({
      status: 'refused',
      reason: 'unreadable answer',
    })
  })

  test('a refusal status with a parent already known beside a child refused for its fee is a refusal', async () => {
    const body = packageBody('transaction failed', 'txn-already-known', 'min relay fee not met, 0 < 110')
    const request = hosts({ mempool: response(400, body), blockstream: response(400, body) })
    expect(await broadcastPackage(PARENT, CHILD, STEP, { request })).toEqual({
      status: 'refused',
      reason: 'min relay fee not met, 0 < 110',
    })
  })

  test('the same list behind an RPC prefix is a refusal', async () => {
    const body = `submitpackage RPC error: ${packageBody('transaction failed', 'txn-already-known', 'non-BIP68-final')}`
    const request = hosts({ mempool: response(400, body), blockstream: response(500, body) })
    expect(await broadcastPackage(PARENT, CHILD, STEP, { request })).toEqual({ status: 'refused', reason: 'non-BIP68-final' })
  })

  test('a refusal status listing only transactions the network has is sent', async () => {
    const body = packageBody('transaction failed', 'txn-already-known', 'txn-already-in-mempool')
    const request = hosts({ mempool: response(400, body) })
    expect(await broadcastPackage(PARENT, CHILD, STEP, { request })).toEqual({ status: 'sent', host: 'mempool.space' })
  })

  test('a refusal status with a known parent and no word on the child is sent, as on a 200', async () => {
    const request = hosts({ mempool: response(400, packageBody('transaction failed', 'txn-already-known', undefined)) })
    expect((await broadcastPackage(PARENT, CHILD, STEP, { request })).status).toBe('sent')
  })

  test.each([200, 400])('on a %i, an error it cannot read beside a known parent is no yes', async status => {
    const body = JSON.stringify({
      package_msg: 'transaction failed',
      'tx-results': {
        [WTXID_A]: { txid: TXID, error: 'txn-already-known' },
        [WTXID_B]: { txid: TXID, error: { code: -26, message: 'min relay fee not met' } },
      },
    })
    const request = hosts({ mempool: response(status, body), blockstream: response(status, body) })
    expect((await broadcastPackage(PARENT, CHILD, STEP, { request })).status).toBe('refused')
  })

  test.each([
    ['a list in plain text', 'txn-already-known\nmin relay fee not met, 0 < 110'],
    ['a list that is JSON', '[{"error":"txn-already-known"},{"error":"min relay fee not met, 0 < 110"}]'],
    ['a list cut short', packageBody('transaction failed', 'txn-already-known', 'x').split(WTXID_B)[0]],
    ['a sentence that quotes the words', 'rejected: parent txn-already-known but child has too low a fee'],
    ['a list with no reason', '{"tx-results":{}}'],
  ])('a refusal status with %s is never sent', async (_name, body) => {
    const request = hosts({ mempool: response(400, body), blockstream: response(400, body) })
    expect((await broadcastPackage(PARENT, CHILD, STEP, { request })).status).toBe('refused')
  })

  test('the two refusals measured on the hosts with a junk body stay refusals', async () => {
    const request = hosts({
      mempool: response(400, 'submitpackage RPC error'),
      blockstream: response(400, 'Invalid transaction size for item 0'),
    })
    expect(await broadcastPackage(PARENT, CHILD, STEP, { request })).toEqual({
      status: 'refused',
      reason: 'submitpackage RPC error',
    })
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      `${MEMPOOL}/v1/txs/package`,
      `${BLOCKSTREAM}/txs/package`,
    ])
  })
})

describe('what a plain broadcast answer means', () => {
  test('a txid on 200 is sent, and the body is the hex alone', async () => {
    const request = hosts({ mempool: response(200, `${TXID}\n`) })
    expect(await broadcastTx(PARENT, STEP, { request })).toEqual({ status: 'sent', host: 'mempool.space' })
    const [url, init] = request.mock.calls[0]
    expect(url).toBe(`${MEMPOOL}/tx`)
    expect(init?.body).toBe(PARENT)
  })

  test('a 200 that is not a txid is not sent', async () => {
    const request = hosts({ mempool: response(200, '<html></html>'), blockstream: response(200, '') })
    expect(await broadcastTx(PARENT, STEP, { request })).toEqual({ status: 'refused', reason: 'unreadable answer' })
  })

  test.each([
    'sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}',
    'sendrawtransaction RPC error: {"code":-27,"message":"Transaction outputs already in utxo set"}',
    'sendrawtransaction RPC error: {"code":-26,"message":"txn-already-in-mempool"}',
    'sendrawtransaction RPC error: {"code":-27,"message":"txn-already-known"}',
  ])('%s counts as sent', async body => {
    const request = hosts({ mempool: response(400, body) })
    expect((await broadcastTx(PARENT, STEP, { request })).status).toBe('sent')
  })

  test.each([
    '{"code":-27,"message":"Transaction already in block chain"}',
    JSON.stringify({ error: 'sendrawtransaction RPC error: {"code":-26,"message":"txn-already-known"}' }),
    'txn-already-known',
  ])('%s, however it is wrapped, counts as sent', async body => {
    const request = hosts({ mempool: response(400, body) })
    expect((await broadcastTx(PARENT, STEP, { request })).status).toBe('sent')
  })

  // A cooperative step resent after it confirmed, as both hosts answer it (/tx, 400).
  const MEASURED_KNOWN = {
    mempool: 'sendrawtransaction RPC error: {"code":-27,"message":"Transaction outputs already in utxo set"}',
    blockstream: 'sendrawtransaction RPC error -27: Transaction outputs already in utxo set',
  }

  test.each([
    ['mempool.space', MEASURED_KNOWN.mempool],
    ['blockstream.info', MEASURED_KNOWN.blockstream],
  ])('a step already on the chain reads as sent from %s, as it answered', async (host, body) => {
    const answers = host === 'mempool.space' ? { mempool: response(400, body) } : { blockstream: response(400, body) }
    expect(await broadcastTx(PARENT, STEP, { request: hosts(answers) })).toEqual({ status: 'sent', host })
  })

  test('with mempool.space silent, blockstream.info saying the step is on the chain is sent', async () => {
    jest.useFakeTimers()
    const request = jest.fn(async (url: RequestInfo | URL) =>
      String(url).startsWith(MEMPOOL)
        ? new Promise<Response>(() => undefined)
        : response(400, MEASURED_KNOWN.blockstream),
    ) as unknown as typeof fetch
    const answer = broadcastTx(PARENT, STEP, { request })
    await jest.advanceTimersByTimeAsync(10_000)
    expect(await answer).toEqual({ status: 'sent', host: 'blockstream.info' })
  })

  test.each([
    'sendrawtransaction RPC error -27: Transaction outputs already in utxo set.',
    'sendrawtransaction RPC error -27: Transaction already in block chain',
    'sendrawtransaction RPC error -26: txn-already-known',
    'sendrawtransaction RPC error -26: txn-already-in-mempool\n',
    'sendrawtransaction RPC error: Transaction outputs already in utxo set',
    'sendrawtransaction RPC error: {"code":-27,"message":"Transaction outputs already in utxo set."}',
  ])('%s, in plain text or JSON, counts as sent', async body => {
    const request = hosts({ blockstream: response(400, body) })
    expect(await broadcastTx(PARENT, STEP, { request })).toEqual({ status: 'sent', host: 'blockstream.info' })
  })

  test('a package a host says is on the chain, in plain text, is sent', async () => {
    const request = hosts({ blockstream: response(400, 'submitpackage RPC error -27: Transaction outputs already in utxo set') })
    expect(await broadcastPackage(PARENT, CHILD, STEP, { request })).toEqual({ status: 'sent', host: 'blockstream.info' })
  })

  test.each([
    'sendrawtransaction RPC error -25: bad-txns-inputs-missingorspent',
    'sendrawtransaction RPC error -25: Inputs missing or spent',
    'sendrawtransaction RPC error -26: min relay fee not met, 0 < 110',
    'sendrawtransaction RPC error -26: mempool min fee not met, 120 < 141',
    'sendrawtransaction RPC error -26: txn-mempool-conflict',
    'sendrawtransaction RPC error -26: insufficient fee, rejecting replacement ab, less fees than conflicting txs',
    'sendrawtransaction RPC error -26: txn-already-known, but its child has too low a fee',
    'sendrawtransaction RPC error -27: rejected, Transaction outputs already in utxo set',
    'sendrawtransaction RPC error -27: Transaction outputs already in utxo set; min relay fee not met',
    'sendrawtransaction RPC error -27:',
    'getrawtransaction RPC error -27: Transaction outputs already in utxo set',
  ])('%s stays a refusal and names the host text', async body => {
    const request = hosts({ mempool: response(400, body), blockstream: response(400, body) })
    expect(await broadcastTx(PARENT, STEP, { request })).toEqual({ status: 'refused', reason: body.trim() })
  })

  test('the refusal measured on both hosts for a spent input stays a refusal on each', async () => {
    const mempool = 'sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}'
    const blockstream = 'sendrawtransaction RPC error -25: bad-txns-inputs-missingorspent'
    expect(await broadcastTx(PARENT, STEP, { request: hosts({ mempool: response(400, mempool) }) })).toEqual({
      status: 'refused',
      reason: 'bad-txns-inputs-missingorspent',
    })
    expect(await broadcastTx(PARENT, STEP, { request: hosts({ blockstream: response(400, blockstream) }) })).toEqual({
      status: 'refused',
      reason: blockstream,
    })
  })

  test('a node reason that only mentions the words is a refusal, and it names that reason', async () => {
    const reason = 'bad-txns-inputs-missingorspent, already in mempool as a conflict'
    const body = `sendrawtransaction RPC error: ${JSON.stringify({ code: -25, message: reason })}`
    const request = hosts({ mempool: response(400, body), blockstream: response(400, body) })
    expect(await broadcastTx(PARENT, STEP, { request })).toEqual({ status: 'refused', reason })
  })

  test('a refusal keeps a bounded reason', async () => {
    const long = `sendrawtransaction RPC error: ${'x'.repeat(5000)}`
    const request = hosts({ mempool: response(400, long), blockstream: response(400, long) })
    const answer = await broadcastTx(PARENT, STEP, { request })
    expect(answer.status).toBe('refused')
    expect((answer as { reason: string }).reason.length).toBeLessThanOrEqual(200)
  })

  test('a refusal with an empty body still names one', async () => {
    const request = hosts({ mempool: response(503, ''), blockstream: response(502, '') })
    expect(await broadcastTx(PARENT, STEP, { request })).toEqual({ status: 'refused', reason: 'HTTP 503' })
  })
})

// Bitcoin Core answers bad-txns-inputs-missingorspent both for a step already in a block whose outputs
// are spent and for one another spend beat, so the host that said it is asked whether the txid is
// confirmed, and only its yes counts.
describe('a refusal for a spent input', () => {
  const MISSING = {
    mempool: 'sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}',
    blockstream: 'sendrawtransaction RPC error -25: bad-txns-inputs-missingorspent',
  }
  // What both hosts answer for a txid in block 170, and for a txid neither knows.
  const CONFIRMED = JSON.stringify({ confirmed: true, block_height: 170, block_hash: '00'.repeat(32), block_time: 1 })
  const UNKNOWN = '{"confirmed":false}'

  // Answers by host and by route, the broadcast first and the status of a txid second. A route left
  // out is unreachable.
  function chain(answers: {
    mempool?: [Response?, Response?]
    blockstream?: [Response?, Response?]
  }): jest.MockedFunction<typeof fetch> {
    return jest.fn(async (url: RequestInfo | URL) => {
      const at = String(url)
      const [sent, status] = (at.startsWith(MEMPOOL) ? answers.mempool : answers.blockstream) ?? []
      const answer = at.endsWith('/status') ? status : sent
      if (!answer) {
        throw new TypeError('Network request failed')
      }
      return answer
    }) as unknown as jest.MockedFunction<typeof fetch>
  }

  const statusReads = (request: jest.MockedFunction<typeof fetch>) =>
    request.mock.calls.filter(([url]) => String(url).endsWith('/status'))

  test.each([
    ['mempool.space', MEMPOOL, 'mempool'],
    ['blockstream.info', BLOCKSTREAM, 'blockstream'],
  ] as const)('a step %s holds as confirmed is sent, asked of that host by its txid', async (host, api, key) => {
    const request = chain({ [key]: [response(400, MISSING[key]), response(200, CONFIRMED)] })
    expect(await broadcastTx(PARENT, STEP, { request })).toEqual({ status: 'sent', host })
    const [[url, init]] = statusReads(request)
    expect(url).toBe(`${api}/tx/${STEP}/status`)
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
  })

  test('a pair whose step a host holds as confirmed is sent, asked by the step\'s txid', async () => {
    const body = packageBody('transaction failed', 'bad-txns-inputs-missingorspent', 'bad-txns-inputs-missingorspent')
    const request = chain({ mempool: [response(200, body), response(200, CONFIRMED)] })
    expect(await broadcastPackage(PARENT, CHILD, STEP, { request })).toEqual({ status: 'sent', host: 'mempool.space' })
    expect(statusReads(request).map(([url]) => url)).toEqual([`${MEMPOOL}/tx/${STEP}/status`])
  })

  test.each([
    ['not confirmed, as for a txid a host does not know', response(200, UNKNOWN)],
    ['not found', response(404, 'Transaction not found')],
    ['a confirmation that is not true', response(200, '{"confirmed":"true"}')],
    ['a page that is not JSON', response(200, '<html>confirmed: true</html>')],
    ['an error status, whatever its body says', response(503, '{"confirmed":true}')],
  ])('a status answering %s stays a refusal with the host\'s reason', async (_name, status) => {
    const request = chain({
      mempool: [response(400, MISSING.mempool), status],
      blockstream: [response(400, MISSING.blockstream), status],
    })
    expect(await broadcastTx(PARENT, STEP, { request })).toEqual({
      status: 'refused',
      reason: 'bad-txns-inputs-missingorspent',
    })
    expect(statusReads(request)).toHaveLength(2)
  })

  test('a pair whose step is not confirmed stays a refusal', async () => {
    const body = packageBody('transaction failed', 'bad-txns-inputs-missingorspent', 'bad-txns-inputs-missingorspent')
    const request = chain({
      mempool: [response(200, body), response(200, UNKNOWN)],
      blockstream: [response(200, body), response(200, UNKNOWN)],
    })
    expect(await broadcastPackage(PARENT, CHILD, STEP, { request })).toEqual({
      status: 'refused',
      reason: 'bad-txns-inputs-missingorspent',
    })
  })

  test('a status read that fails stays a refusal', async () => {
    const request = chain({ mempool: [response(400, MISSING.mempool)] })
    expect(await broadcastTx(PARENT, STEP, { request })).toEqual({
      status: 'refused',
      reason: 'bad-txns-inputs-missingorspent',
    })
    expect(statusReads(request)).toHaveLength(1)
  })

  test('a status read that never answers is cut at 10 s, aborted, and stays a refusal', async () => {
    jest.useFakeTimers()
    const signals: (AbortSignal | null | undefined)[] = []
    const request = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/status')) {
        signals.push(init?.signal)
        return new Promise<Response>(() => undefined)
      }
      if (String(url).startsWith(MEMPOOL)) {
        return response(400, MISSING.mempool)
      }
      throw new TypeError('Network request failed')
    }) as unknown as typeof fetch
    let settled = false
    const sending = broadcastTx(PARENT, STEP, { request }).then(answer => {
      settled = true
      return answer
    })
    await jest.advanceTimersByTimeAsync(9_999)
    expect(settled).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(await sending).toEqual({ status: 'refused', reason: 'bad-txns-inputs-missingorspent' })
  })

  test('a host that refused for another reason is not asked, whatever its status would say', async () => {
    const fee = 'sendrawtransaction RPC error -26: min relay fee not met, 0 < 110'
    const request = chain({
      mempool: [response(400, MISSING.mempool), response(200, UNKNOWN)],
      blockstream: [response(400, fee), response(200, CONFIRMED)],
    })
    expect(await broadcastTx(PARENT, STEP, { request })).toEqual({
      status: 'refused',
      reason: 'bad-txns-inputs-missingorspent',
    })
    expect(statusReads(request).map(([url]) => url)).toEqual([`${MEMPOOL}/tx/${STEP}/status`])
  })

  test('a refusal for anything else asks no status', async () => {
    const fee = 'sendrawtransaction RPC error -26: min relay fee not met, 0 < 110'
    const request = chain({
      mempool: [response(400, fee), response(200, CONFIRMED)],
      blockstream: [response(400, fee), response(200, CONFIRMED)],
    })
    expect((await broadcastTx(PARENT, STEP, { request })).status).toBe('refused')
    expect(statusReads(request)).toEqual([])
  })
})

describe('one host failing leads to the other', () => {
  test.each([
    ['down', {}],
    ['refusing', { mempool: response(400, 'min relay fee not met') }],
    ['answering 200 with a refusal', { mempool: response(200, packageBody('transaction failed', 'non-BIP68-final')) }],
  ])('the first host %s sends it through the second', async (_name, first) => {
    const request = hosts({ ...first, blockstream: response(200, SUCCESS) })
    expect(await broadcastPackage(PARENT, CHILD, STEP, { request })).toEqual({ status: 'sent', host: 'blockstream.info' })
    expect(request).toHaveBeenCalledTimes(2)
  })

  test('a plain transaction falls over the same way', async () => {
    const request = hosts({ blockstream: response(200, TXID) })
    expect(await broadcastTx(PARENT, STEP, { request })).toEqual({ status: 'sent', host: 'blockstream.info' })
    expect(request.mock.calls[1][0]).toBe(`${BLOCKSTREAM}/tx`)
  })

  test('both down is unreachable, never sent', async () => {
    expect(await broadcastPackage(PARENT, CHILD, STEP, { request: hosts({}) })).toEqual({ status: 'unreachable' })
    expect(await broadcastTx(PARENT, STEP, { request: hosts({}) })).toEqual({ status: 'unreachable' })
  })

  test('a host down beside one refusing returns the refusal', async () => {
    const request = hosts({ blockstream: response(400, 'bad-txns-inputs-missingorspent') })
    expect(await broadcastTx(PARENT, STEP, { request })).toEqual({
      status: 'refused',
      reason: 'bad-txns-inputs-missingorspent',
    })
  })

  test('a host that never answers is cut at 10 s and aborted, and the other is asked', async () => {
    jest.useFakeTimers()
    const signals: (AbortSignal | null | undefined)[] = []
    const request = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith(MEMPOOL)) {
        signals.push(init?.signal)
        return new Promise<Response>(() => undefined)
      }
      return response(200, SUCCESS)
    }) as unknown as typeof fetch
    const sending = broadcastPackage(PARENT, CHILD, STEP, { request })
    await jest.advanceTimersByTimeAsync(9_999)
    expect(request).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(await sending).toEqual({ status: 'sent', host: 'blockstream.info' })
  })
})

describe('only hex, txids and addresses reach the wire', () => {
  test.each(['', 'abc', 'zz', 'aa bb', '["aa"]'])('%j is refused before any request', async hex => {
    const request = hosts({ mempool: response(200, SUCCESS) })
    expect((await broadcastTx(hex, STEP, { request })).status).toBe('refused')
    expect((await broadcastPackage(hex, CHILD, STEP, { request })).status).toBe('refused')
    expect((await broadcastPackage(PARENT, hex, STEP, { request })).status).toBe('refused')
    expect(request).not.toHaveBeenCalled()
  })

  test.each(['', 'ab', `${STEP}/../../address/${ADDRESS}`, 'zz'.repeat(32), `${STEP}?x=1`])(
    'txid %j is asked of no host',
    async txid => {
      const request = hosts({
        mempool: response(400, 'bad-txns-inputs-missingorspent'),
        blockstream: response(400, 'bad-txns-inputs-missingorspent'),
      })
      expect((await broadcastTx(PARENT, txid, { request })).status).toBe('refused')
      expect((await broadcastPackage(PARENT, CHILD, txid, { request })).status).toBe('refused')
      expect(request.mock.calls.map(([url]) => String(url)).filter(url => !/\/(tx|txs\/package)$/.test(url))).toEqual([])
    },
  )

  test.each(['', 'bc1', `${ADDRESS}/../../tx`, `${ADDRESS}?x=1`, '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'])(
    'address %j is read from no host',
    async address => {
      const request = hosts({ mempool: response(200, '[]') })
      expect(await readFunding(address, { request })).toEqual({ status: 'failed' })
      expect(request).not.toHaveBeenCalled()
    },
  )
})

describe('reading the funding address', () => {
  const utxo = (over: object = {}) => ({
    txid: TXID,
    vout: 1,
    value: 15_000,
    status: { confirmed: true, block_height: 900_000, block_hash: 'cd'.repeat(32), block_time: 1 },
    ...over,
  })

  test('asks the address on the first host', async () => {
    const request = hosts({ mempool: response(200, '[]') })
    await readFunding(ADDRESS, { request })
    expect(request.mock.calls[0][0]).toBe(`${MEMPOOL}/address/${ADDRESS}/utxo`)
  })

  test('an empty answer is an answer, and only then is nothing there', async () => {
    const request = hosts({ mempool: response(200, '[]') })
    expect(await readFunding(ADDRESS, { request })).toEqual({ status: 'read', confirmed: [], pendingSat: 0 })
  })

  test('a pending output does not count, and is reported as waiting', async () => {
    const pending = utxo({ txid: 'ef'.repeat(32), value: 9_000, status: { confirmed: false } })
    const request = hosts({ mempool: response(200, JSON.stringify([utxo(), pending])) })
    expect(await readFunding(ADDRESS, { request })).toEqual({
      status: 'read',
      confirmed: [{ txid: TXID, vout: 1, valueSat: 15_000 }],
      pendingSat: 9_000,
    })
  })

  test('only pending leaves nothing confirmed', async () => {
    const request = hosts({ mempool: response(200, JSON.stringify([utxo({ status: { confirmed: false } })])) })
    expect(await readFunding(ADDRESS, { request })).toEqual({ status: 'read', confirmed: [], pendingSat: 15_000 })
  })

  test('a host down, refusing or garbled leads to the other', async () => {
    const list = JSON.stringify([utxo()])
    for (const first of [undefined, response(429, 'Too Many Requests'), response(200, '<html>')]) {
      const request = hosts({ mempool: first, blockstream: response(200, list) })
      expect((await readFunding(ADDRESS, { request })).status).toBe('read')
      expect(request.mock.calls[1][0]).toBe(`${BLOCKSTREAM}/address/${ADDRESS}/utxo`)
    }
  })

  test.each([
    ['both down', {}],
    ['both refusing', { mempool: response(429, ''), blockstream: response(503, '') }],
    ['both garbled', { mempool: response(200, '{}'), blockstream: response(200, 'null') }],
  ])('%s fails and never reads as nothing arrived', async (_name, answers) => {
    expect(await readFunding(ADDRESS, { request: hosts(answers) })).toEqual({ status: 'failed' })
  })

  test.each([
    ['a value in text', { value: '15000' }],
    ['no value', { value: undefined }],
    ['a short txid', { txid: 'ab' }],
    ['a negative vout', { vout: -1 }],
    ['a negative value', { value: -1 }],
    ['no status', { status: undefined }],
    ['a status with no verdict', { status: {} }],
  ])('one entry with %s spoils the whole answer', async (_name, over) => {
    const body = JSON.stringify([utxo(), utxo(over)])
    const request = hosts({ mempool: response(200, body), blockstream: response(200, body) })
    expect(await readFunding(ADDRESS, { request })).toEqual({ status: 'failed' })
  })

  test('an output worth nothing is left out, and the read stands', async () => {
    const body = JSON.stringify([utxo(), utxo({ vout: 7, value: 0 })])
    const request = hosts({ mempool: response(200, body), blockstream: response(200, body) })
    const read = await readFunding(ADDRESS, { request })
    expect(read).toEqual({ status: 'read', confirmed: [expect.objectContaining({ valueSat: 15_000 })], pendingSat: 0 })
  })

  test('a read that never answers fails after 10 s on each host', async () => {
    jest.useFakeTimers()
    const request = jest.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch
    const read = readFunding(ADDRESS, { request })
    await jest.advanceTimersByTimeAsync(19_999)
    expect(request).toHaveBeenCalledTimes(2)
    let settled = false
    read.then(() => (settled = true))
    await jest.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    expect(await read).toEqual({ status: 'failed' })
  })
})

describe('with the switch off', () => {
  beforeEach(() => __setEmergencyExitLiveForTests(false))

  test('no host is asked, and nothing reads as sent', async () => {
    const request = hosts({ mempool: response(200, SUCCESS), blockstream: response(200, TXID) })
    expect(await broadcastPackage(PARENT, CHILD, STEP, { request })).toEqual({ status: 'unreachable' })
    expect(await broadcastTx(PARENT, STEP, { request })).toEqual({ status: 'unreachable' })
    expect(await readFunding(ADDRESS, { request })).toEqual({ status: 'failed' })
    expect(request).not.toHaveBeenCalled()
  })
})

describe('the relay is the one place that knows the chain hosts', () => {
  const root = path.join(__dirname, '../src')
  const sources = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        return sources(full)
      }
      return /\.tsx?$/.test(entry.name) ? [full] : []
    })
  const relative = (file: string): string => path.relative(root, file)

  test('no other source reaches their API', () => {
    const files = sources(root)
    expect(files.length).toBeGreaterThan(100)
    expect(files.map(relative)).toContain('wallet/chainRelay.ts')
    const reaching = files
      .filter(file => /(?:mempool\.space|blockstream\.info)\/api|txs\/package/.test(fs.readFileSync(file, 'utf8')))
      .map(relative)
    expect(reaching).toEqual(['wallet/chainRelay.ts'])
  })

  // The explorer presets name the same sites, as a link that opens in the browser.
  test('elsewhere the two names only appear as the explorer presets', () => {
    const naming = sources(root)
      .filter(file => /mempool\.space|blockstream\.info/.test(fs.readFileSync(file, 'utf8')))
      .map(relative)
      .sort()
    expect(naming).toEqual(['wallet/chainRelay.ts', 'wallet/settings.ts'])
    const presets = fs
      .readFileSync(path.join(root, 'wallet/settings.ts'), 'utf8')
      .split('\n')
      .filter(line => /mempool\.space|blockstream\.info/.test(line) && !line.trim().startsWith('/'))
    expect(presets.map(line => line.trim())).toEqual([
      "{ id: 'mempool', url: 'https://mempool.space' },",
      "{ id: 'blockstream', url: 'https://blockstream.info' },",
    ])
  })

  test('it reads nothing of the wallet, so it can only be handed hex, txids and addresses', () => {
    const source = fs.readFileSync(path.join(root, 'wallet/chainRelay.ts'), 'utf8')
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1])
    expect(imports.sort()).toEqual(['./answerWithin', './emergencyExit'])
  })
})
