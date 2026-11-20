import RNFS from 'react-native-fs'
import { connect, PaymentType } from '@breeztech/breez-sdk-spark-react-native'
import {
  MAX_NOTES_PER_WALLET,
  forgetConversionNotes,
  keepConversionNote,
  withConversionNote,
  withConversionNotes,
  type ConversionNote,
} from '../src/wallet/conversionNotes'
import { conversionLeft, directionLabel } from '../src/wallet/history'
import {
  connectSpark,
  disconnectSpark,
  sparkConfirmConvertLeg,
  sparkGetPayment,
  sparkListHistory,
  sparkPrepareConvert,
  sparkPrepareConvertBySpend,
} from '../src/wallet/spark'
import type { HistoryConversion, HistoryItem } from '../src/wallet/payment'

jest.mock('../src/config', () => ({
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => undefined,
}))
jest.mock('../src/wallet/seed', () => ({
  loadSeedFor: jest.fn(async () => 'abandon abandon abandon'),
  loadPassphraseFor: jest.fn(async () => undefined),
  PRIMARY_ID: 'primary',
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  getActiveWalletId: jest.fn(async () => 'primary'),
  ensureRegistered: jest.fn(),
}))
jest.mock('../src/wallet/fingerprint', () => ({
  fingerprintFromMnemonic: jest.fn(() => 'fp'),
  fingerprintFromMnemonicAsync: jest.fn(async () => 'fp'),
}))

const sdk = (
  jest.requireMock('@breeztech/breez-sdk-spark-react-native') as {
    __sdkInstance: Record<
      | 'receivePayment'
      | 'prepareSendPayment'
      | 'sendPayment'
      | 'getTokensMetadata'
      | 'listPayments'
      | 'getPayment',
      jest.Mock
    >
  }
).__sdkInstance

const FILE = `${RNFS.DocumentDirectoryPath}/conversion-notes.json`
const USDB_ID = 'btkn1usdb'
const DEPIX_ID = 'btkn1depix'
const RECEIVED_ID = '019a0000-0000-7000-8000-00000000abcd'

const t = (key: string, opts?: Record<string, unknown>): string =>
  key === 'home.sats' ? `${String(opts?.amount)} sats` : key === 'common.sats' ? 'sats' : `${key}:${JSON.stringify(opts)}`

const usdbToSats: ConversionNote = {
  from: { ticker: 'USDB', decimals: 6, baseUnits: '25388955' },
  to: { ticker: null, decimals: 0 },
  fee: { ticker: 'USDB', decimals: 6, baseUnits: '50956' },
}
const satsToDepix: ConversionNote = {
  from: { ticker: null, decimals: 0, baseUnits: '31473' },
  to: { ticker: 'DEPIX', decimals: 8 },
  fee: { ticker: null, decimals: 0, baseUnits: '63' },
}

function row(id: string, conversion: HistoryConversion | undefined, direction: HistoryItem['direction'] = 'converted'): HistoryItem {
  return {
    id,
    direction,
    status: 'complete',
    amountSat: 31_473,
    feesSat: 0,
    timestamp: 1,
    asset: null,
    ...(conversion ? { conversion } : {}),
  }
}

// What the boundary makes of a Convert today: sats arrived, and nothing says what paid.
const satsArrived: HistoryConversion = { status: 'complete', automatic: false, to: { ticker: null, amount: '31473' } }
// A token arrived, bought with sats in an amount the SDK does not expose.
const depixArrived: HistoryConversion = {
  status: 'complete',
  automatic: false,
  from: { ticker: null },
  to: { ticker: 'DEPIX', amount: '100.5' },
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('the SDK outranks the note field by field', () => {
  test('a Convert into sats gains what left and the fee it had no word of', () => {
    expect(withConversionNote(row('c1', satsArrived), usdbToSats).conversion).toEqual({
      ...satsArrived,
      from: { ticker: 'USDB', amount: '25.388955', quoted: true },
      quotedFee: { ticker: 'USDB', amount: '0.050956' },
    })
  })

  test('an amount the SDK gave stays, unquoted, and only the fee comes from the note', () => {
    const conversion = { ...satsArrived, from: { ticker: 'USDB', amount: '25' } }
    expect(withConversionNote(row('c1', conversion), usdbToSats).conversion).toEqual({
      ...conversion,
      quotedFee: { ticker: 'USDB', amount: '0.050956' },
    })
  })

  test.each([
    ['on the side that arrived', { ...depixArrived, to: { ticker: 'DEPIX', amount: '100.5', fee: '0.2' } }],
    ['on the side that left', { ...depixArrived, from: { ticker: null, fee: '9' } }],
  ])('a fee the SDK gave %s leaves no quoted fee', (_, conversion) => {
    const merged = withConversionNote(row('c1', conversion), satsToDepix).conversion
    expect(merged?.quotedFee).toBeUndefined()
    expect(merged?.from?.amount).toBe('31473')
    expect(merged?.to).toEqual(conversion.to)
    expect(merged?.from?.fee).toBe(conversion.from?.fee)
  })

  test('a status the SDK gave is never touched', () => {
    const conversion = { ...satsArrived, status: 'refunded' as const, automatic: true }
    expect(withConversionNote(row('c1', conversion), usdbToSats).conversion).toMatchObject({
      status: 'refunded',
      automatic: true,
    })
  })

  test('a quoted fee of zero draws nothing, as no fee does', () => {
    const merged = withConversionNote(row('c1', satsArrived), { ...usdbToSats, fee: { ...usdbToSats.fee, baseUnits: '0' } })
    expect(merged.conversion?.quotedFee).toBeUndefined()
    expect(merged.conversion?.from?.amount).toBe('25.388955')
  })
})

describe('a note shows only on its own payment and wallet', () => {
  beforeEach(async () => {
    await keepConversionNote('w_a', 'c1', usdbToSats)
  })

  test('another row of the same wallet stays as it was', async () => {
    const other = row('c2', satsArrived)
    const [first, second] = await withConversionNotes([row('c1', satsArrived), other], 'w_a')
    expect(first.conversion?.from?.ticker).toBe('USDB')
    expect(second).toBe(other)
  })

  test('the same id on another wallet stays as it was', async () => {
    const item = row('c1', satsArrived)
    expect((await withConversionNotes([item], 'w_b'))[0]).toBe(item)
  })

  test('with no wallet connected no note is read', async () => {
    const item = row('c1', satsArrived)
    expect((await withConversionNotes([item], null))[0]).toBe(item)
  })

  test.each([
    ['a receive', row('c1', { status: 'complete', automatic: false }, 'received')],
    ['a send', row('c1', { status: 'complete', automatic: false }, 'sent')],
    ['a row with no conversion', row('c1', undefined)],
  ])('%s reads no note, even under the right id', async (_, item) => {
    // A conversion beside it, so the file is read and the row itself is what turns the note away.
    expect((await withConversionNotes([item, row('c2', satsArrived)], 'w_a'))[0]).toBe(item)
  })

  test.each([
    ['arrived', { ...satsArrived, to: { ticker: 'DEPIX', amount: '1' } }],
    ['left', { ...satsArrived, from: { ticker: 'DEPIX' } }],
  ])('a row whose %s asset is not the note\'s is not its conversion', async (_, conversion) => {
    const item = row('c1', conversion)
    expect(withConversionNote(item, usdbToSats)).toBe(item)
  })

  test.each(['constructor', '__proto__', 'toString'])('a payment id of %s finds no note', async id => {
    const item = row(id, satsArrived)
    expect((await withConversionNotes([item], 'w_a'))[0]).toBe(item)
  })
})

describe('with no note a row is what it was', () => {
  test('a second install, with no file, is untouched and reads nothing', async () => {
    const read = jest.spyOn(RNFS, 'readFile')
    const items = [row('c1', satsArrived), row('c2', undefined, 'received')]
    expect(await withConversionNotes(items, 'w_a')).toEqual(items)
    expect(read).not.toHaveBeenCalled()
  })

  test('a list with no conversion does not touch the file', async () => {
    await keepConversionNote('w_a', 'c1', usdbToSats)
    const exists = jest.spyOn(RNFS, 'exists')
    await withConversionNotes([row('c1', undefined, 'received')], 'w_a')
    expect(exists).not.toHaveBeenCalled()
  })

  test('a row with no note reads as today in the row and its label', async () => {
    const item = (await withConversionNotes([row('c9', satsArrived)], 'w_a'))[0]
    expect(conversionLeft(item, t)).toBeNull()
    expect(directionLabel(item, t)).toBe('history.convertedToBitcoin:undefined')
  })

  test('a torn file shows the row with no note and no error', async () => {
    await RNFS.writeFile(FILE, '{"w_a":{"c1"', 'utf8')
    const item = row('c1', satsArrived)
    expect((await withConversionNotes([item], 'w_a'))[0]).toBe(item)
  })

  test('a read the platform refuses shows the row with no note and no error', async () => {
    await keepConversionNote('w_a', 'c1', usdbToSats)
    jest.spyOn(RNFS, 'readFile').mockRejectedValue(new Error('refused'))
    const item = row('c1', satsArrived)
    expect((await withConversionNotes([item], 'w_a'))[0]).toBe(item)
  })

  test.each([
    ['a missing side', { to: usdbToSats.to, fee: usdbToSats.fee }],
    ['an amount that is no number', { ...usdbToSats, from: { ...usdbToSats.from, baseUnits: '1e6' } }],
    ['a fee that is no number', { ...usdbToSats, fee: { ...usdbToSats.fee, baseUnits: 'x' } }],
    ['decimals that are no count', { ...usdbToSats, from: { ...usdbToSats.from, decimals: -1 } }],
    ['a note that is no object', 'note'],
  ])('a note with %s reads as none', async (_, note) => {
    await RNFS.writeFile(FILE, JSON.stringify({ w_a: { c1: note } }), 'utf8')
    const item = row('c1', satsArrived)
    expect((await withConversionNotes([item], 'w_a'))[0]).toBe(item)
  })
})

describe('base units convert by each side\'s asset', () => {
  test('a token of 6 decimals with its fee', () => {
    const { conversion } = withConversionNote(row('c1', satsArrived), usdbToSats)
    expect(conversion?.from?.amount).toBe('25.388955')
    expect(conversion?.quotedFee?.amount).toBe('0.050956')
  })

  test('a token of 8 decimals', () => {
    const note = {
      ...usdbToSats,
      from: { ticker: 'DEPIX', decimals: 8, baseUnits: '123456789' },
      fee: { ticker: 'DEPIX', decimals: 8, baseUnits: '5' },
    }
    const { conversion } = withConversionNote(row('c1', satsArrived), note)
    expect(conversion?.from?.amount).toBe('1.23456789')
    expect(conversion?.quotedFee?.amount).toBe('0.00000005')
  })

  test('sats stay whole, with their fee in sats', () => {
    const { conversion } = withConversionNote(row('c1', depixArrived), satsToDepix)
    expect(conversion?.from).toEqual({ ticker: null, amount: '31473', quoted: true })
    expect(conversion?.quotedFee).toEqual({ ticker: null, amount: '63' })
  })
})

describe('the row reads the note as a quote', () => {
  test('what left is approximate, and the title names where it landed', () => {
    const item = withConversionNote(row('c1', satsArrived), usdbToSats)
    expect(conversionLeft(item, t)).toBe('history.rowFrom:{"amount":"≈ 25.38 USDB"}')
    expect(directionLabel(item, t)).toBe('history.convertedToBitcoin:undefined')
  })
})

describe('the file', () => {
  test.each([['a list', []], ['text', 'nope'], ['nothing', null]])(
    "an entry that is %s holds no note, and the next one replaces it",
    async (_what, entry) => {
      await RNFS.writeFile(`${RNFS.DocumentDirectoryPath}/conversion-notes.json`, JSON.stringify({ w_a: entry }), 'utf8')
      expect((await withConversionNotes([row('c1', satsArrived)], 'w_a'))[0].conversion?.quotedFee).toBeUndefined()

      await keepConversionNote('w_a', 'c1', usdbToSats)

      const stored = JSON.parse(await RNFS.readFile(`${RNFS.DocumentDirectoryPath}/conversion-notes.json`, 'utf8'))
      expect(Object.keys(stored.w_a)).toEqual(['c1'])
    },
  )

  test('keeps the two legs of a pair written at once', async () => {
    await Promise.all([keepConversionNote('w_a', 'c1', usdbToSats), keepConversionNote('w_a', 'c2', satsToDepix)])
    const [first, second] = await withConversionNotes([row('c1', satsArrived), row('c2', depixArrived)], 'w_a')
    expect(first.conversion?.quotedFee).toBeDefined()
    expect(second.conversion?.quotedFee).toBeDefined()
  })

  test('holds the latest notes of a wallet, up to its bound, and leaves the others alone', async () => {
    await keepConversionNote('w_b', 'kept', usdbToSats)
    for (let i = 0; i <= MAX_NOTES_PER_WALLET; i++) {
      await keepConversionNote('w_a', `p${i}`, usdbToSats)
    }
    const stored = JSON.parse(await RNFS.readFile(FILE, 'utf8'))
    expect(Object.keys(stored.w_a)).toHaveLength(MAX_NOTES_PER_WALLET)
    expect(stored.w_a.p0).toBeUndefined()
    expect(stored.w_a[`p${MAX_NOTES_PER_WALLET}`]).toBeDefined()
    expect(stored.w_b.kept).toBeDefined()
  })

  test('a torn file is written over, since a lost note costs only the display', async () => {
    await RNFS.writeFile(FILE, '{"w_a"', 'utf8')
    await keepConversionNote('w_a', 'c1', usdbToSats)
    expect(JSON.parse(await RNFS.readFile(FILE, 'utf8')).w_a.c1).toEqual(usdbToSats)
  })

  test('a read the platform refuses leaves the notes in place and rejects', async () => {
    await keepConversionNote('w_a', 'c1', usdbToSats)
    const before = await RNFS.readFile(FILE, 'utf8')
    // Refused for the read of the notes alone (text, then bytes), so the write after it would go through.
    jest
      .spyOn(RNFS, 'readFile')
      .mockRejectedValueOnce(new Error('refused'))
      .mockRejectedValueOnce(new Error('refused'))
    await expect(keepConversionNote('w_a', 'c2', usdbToSats)).rejects.toThrow('refused')
    expect(await RNFS.readFile(FILE, 'utf8')).toBe(before)
  })
})

describe('forgetConversionNotes', () => {
  test('forgets that wallet and no other', async () => {
    await keepConversionNote('w_a', 'c1', usdbToSats)
    await keepConversionNote('w_b', 'c2', usdbToSats)
    await forgetConversionNotes('w_a')
    expect(JSON.parse(await RNFS.readFile(FILE, 'utf8'))).toEqual({ w_b: { c2: usdbToSats } })
  })

  test('with nothing kept it writes nothing', async () => {
    await forgetConversionNotes('w_a')
    expect(await RNFS.exists(FILE)).toBe(false)
  })
})

describe('at Convert\'s send', () => {
  const flush = async () => {
    for (let i = 0; i < 40; i++) {
      await Promise.resolve()
    }
    await new Promise(resolve => setImmediate(resolve))
  }
  const stored = async () => (await RNFS.exists(FILE) ? JSON.parse(await RNFS.readFile(FILE, 'utf8')) : {})

  beforeEach(async () => {
    jest.clearAllMocks()
    jest.mocked(connect).mockResolvedValue(sdk as never)
    await disconnectSpark().catch(() => undefined)
    await connectSpark('abandon abandon abandon', 'w_a')
    sdk.receivePayment.mockResolvedValue({ paymentRequest: 'sp1self', fee: 0n })
    sdk.sendPayment.mockResolvedValue({ payment: { id: RECEIVED_ID, status: 0, amount: 31_473n } })
    sdk.getTokensMetadata.mockImplementation(async ({ tokenIdentifiers: [identifier] }: { tokenIdentifiers: string[] }) => ({
      tokensMetadata: [
        identifier === USDB_ID
          ? { identifier, ticker: 'USDB', decimals: 6 }
          : { identifier: DEPIX_ID, ticker: 'DEPIX', decimals: 8 },
      ],
    }))
  })

  const quoteIntoSats = async () => {
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'SparkAddress', inner: {} },
      amount: 31_473n,
      conversionEstimate: { amountIn: 25_388_955n, amountOut: 31_473n, fee: 50_956n },
    })
    return sparkPrepareConvertBySpend(USDB_ID, undefined, 25_388_955, 31_473)
  }

  test('a token into sats notes the token that left and its fee, under the id the send returned', async () => {
    const { handle } = await quoteIntoSats()
    await sparkConfirmConvertLeg(handle)
    await flush()
    expect(await stored()).toEqual({ w_a: { [RECEIVED_ID]: usdbToSats } })
  })

  test('sats into a token notes the sats that left, with the fee in sats', async () => {
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'SparkAddress', inner: {} },
      amount: 10_000_000_000n,
      tokenIdentifier: DEPIX_ID,
      conversionEstimate: { amountIn: 31_473n, amountOut: 10_050_000_000n, fee: 63n },
    })
    const { handle } = await sparkPrepareConvert(undefined, DEPIX_ID, 10_000_000_000)
    await sparkConfirmConvertLeg(handle)
    await flush()
    expect(await stored()).toEqual({ w_a: { [RECEIVED_ID]: satsToDepix } })
  })

  test('a token into sats by exact output notes the same sides', async () => {
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'SparkAddress', inner: {} },
      amount: 31_000n,
      conversionEstimate: { amountIn: 25_388_955n, amountOut: 31_473n, fee: 50_956n },
    })
    const { handle } = await sparkPrepareConvert(USDB_ID, undefined, 31_000)
    await sparkConfirmConvertLeg(handle)
    await flush()
    expect((await stored()).w_a[RECEIVED_ID]).toEqual(usdbToSats)
  })

  test('the list shows the note on the row the send named, through the real boundary', async () => {
    const { handle } = await quoteIntoSats()
    await sparkConfirmConvertLeg(handle)
    await flush()
    const leg = {
      id: RECEIVED_ID,
      paymentType: PaymentType.Receive,
      status: 0,
      amount: 31_473n,
      fees: 0n,
      timestamp: 1n,
      details: {
        tag: 'Spark',
        inner: { conversionInfo: { tag: 'Amm', inner: { status: 0, purpose: { tag: 'SelfTransfer' } } } },
      },
    }
    sdk.listPayments.mockResolvedValue({ payments: [leg, { ...leg, id: 'someone-else' }] })
    sdk.getPayment.mockResolvedValue({ payment: leg })

    const [noted, other] = await sparkListHistory()
    expect(noted.conversion?.from).toEqual({ ticker: 'USDB', amount: '25.388955', quoted: true })
    expect(noted.conversion?.quotedFee).toEqual({ ticker: 'USDB', amount: '0.050956' })
    expect(other.conversion?.from).toBeUndefined()
    expect((await sparkGetPayment(RECEIVED_ID)).conversion?.from?.ticker).toBe('USDB')
  })

  test('the note goes under the wallet that ran the conversion, whatever is connected when it lands', async () => {
    let land: (value: unknown) => void = () => undefined
    sdk.sendPayment.mockReturnValue(new Promise(resolve => (land = resolve)))
    const { handle } = await quoteIntoSats()
    const confirming = sparkConfirmConvertLeg(handle)
    // The switch comes once the SDK holds the send, since a connection dropped before that signs nothing.
    await flush()
    expect(sdk.sendPayment).toHaveBeenCalledTimes(1)
    await disconnectSpark()
    await connectSpark('abandon abandon abandon', 'w_b')
    land({ payment: { id: RECEIVED_ID, status: 0, amount: 31_473n } })
    await confirming
    await flush()
    expect(Object.keys(await stored())).toEqual(['w_a'])
  })

  test('a note still on its way when its wallet goes is not written after it', async () => {
    let metadata: (value: unknown) => void = () => undefined
    sdk.getTokensMetadata.mockReturnValueOnce(new Promise(resolve => (metadata = resolve)))
    const { handle } = await quoteIntoSats()
    await sparkConfirmConvertLeg(handle)

    await forgetConversionNotes('w_a')
    metadata({ tokensMetadata: [{ identifier: USDB_ID, ticker: 'USDB', decimals: 6 }] })
    await flush()

    expect(await stored()).toEqual({})
  })

  test('another wallet connected lists the same id with no note', async () => {
    const { handle } = await quoteIntoSats()
    await sparkConfirmConvertLeg(handle)
    await flush()
    await disconnectSpark()
    await connectSpark('abandon abandon abandon', 'w_b')
    const leg = {
      id: RECEIVED_ID,
      paymentType: PaymentType.Receive,
      status: 0,
      amount: 31_473n,
      fees: 0n,
      timestamp: 1n,
      details: { tag: 'Spark', inner: { conversionInfo: { tag: 'Amm', inner: { status: 0, purpose: { tag: 'SelfTransfer' } } } } },
    }
    sdk.listPayments.mockResolvedValue({ payments: [leg] })
    expect((await sparkListHistory())[0].conversion?.from).toBeUndefined()
  })

  test('a conversion that failed leaves no note', async () => {
    sdk.sendPayment.mockResolvedValue({ payment: { id: RECEIVED_ID, status: 2, amount: 0n } })
    const { handle } = await quoteIntoSats()
    expect((await sparkConfirmConvertLeg(handle)).status).toBe('failed')
    await flush()
    expect(sdk.getTokensMetadata).not.toHaveBeenCalled()
    expect(await stored()).toEqual({})
  })

  test('a quote with no estimate leaves no note', async () => {
    sdk.prepareSendPayment.mockResolvedValue({ paymentMethod: { tag: 'SparkAddress', inner: {} }, amount: 1_000n })
    const { handle } = await sparkPrepareConvert(undefined, USDB_ID, 1_000)
    await sparkConfirmConvertLeg(handle)
    await flush()
    expect(await stored()).toEqual({})
  })

  describe('the note never fails or delays the conversion', () => {
    const silent = (warn: jest.SpyInstance) => {
      const logged = JSON.stringify(warn.mock.calls)
      expect(logged).not.toContain(RECEIVED_ID)
      expect(logged).not.toContain('31473')
      expect(logged).not.toContain('25388955')
      expect(logged).not.toContain('50956')
    }

    test('a token lookup that never answers does not hold the result back', async () => {
      sdk.getTokensMetadata.mockReturnValue(new Promise(() => undefined))
      const { handle } = await quoteIntoSats()
      await expect(sparkConfirmConvertLeg(handle)).resolves.toEqual({ status: 'complete', receivedBaseUnits: 31_473 })
    })

    test('a file that is slow to read does not hold the result back', async () => {
      let release: (value: boolean) => void = () => undefined
      const slow = new Promise<boolean>(resolve => (release = resolve))
      const real = RNFS.exists.bind(RNFS)
      // The notes file alone: a disk that never answers the exit's plan holds every spend by design.
      const exists = jest
        .spyOn(RNFS, 'exists')
        .mockImplementation(path => (path.endsWith('/conversion-notes.json') ? slow : real(path)))
      const { handle } = await quoteIntoSats()
      await expect(sparkConfirmConvertLeg(handle)).resolves.toMatchObject({ status: 'complete' })
      await flush()
      expect(exists).toHaveBeenCalledWith(expect.stringMatching(/\/conversion-notes\.json$/))
      // The queue is the module's own, so a read left hanging would hold every later case.
      exists.mockRestore()
      release(false)
      await flush()
    })

    test.each([
      ['a token lookup that fails', () => sdk.getTokensMetadata.mockRejectedValue(new Error(`no ${RECEIVED_ID}`))],
      ['a token lookup that throws at once', () => sdk.getTokensMetadata.mockImplementation(() => { throw new Error('gone') })],
      ['a token nobody knows', () => sdk.getTokensMetadata.mockResolvedValue({ tokensMetadata: [] })],
      ['a disk that refuses the write', () => jest.spyOn(RNFS, 'writeFile').mockRejectedValue(new Error(`full ${RECEIVED_ID}`))],
    ])('%s is logged with no amount or id, and the screen goes on', async (_, arm) => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
      arm()
      const { handle } = await quoteIntoSats()
      await expect(sparkConfirmConvertLeg(handle)).resolves.toEqual({ status: 'complete', receivedBaseUnits: 31_473 })
      await flush()
      expect(warn).toHaveBeenCalledWith('conversion note not kept')
      silent(warn)
    })
  })
})
