import NfcManager, { Ndef, NfcError, NfcTech } from 'react-native-nfc-manager'
import { cancelNfcRead, nfcState, openNfcSettings, readNfcDestination } from '../src/wallet/nfc'

const PROMPT = 'Hold your phone near the tag'

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(Ndef.isType).mockReturnValue(false)
})

test('nfcState tells hardware that is missing, switched off and on apart', async () => {
  jest.mocked(NfcManager.isSupported).mockResolvedValueOnce(false)
  expect(await nfcState()).toBe('unsupported')

  jest.mocked(NfcManager.isSupported).mockResolvedValueOnce(true)
  jest.mocked(NfcManager.isEnabled).mockResolvedValueOnce(false)
  expect(await nfcState()).toBe('off')

  jest.mocked(NfcManager.isSupported).mockResolvedValueOnce(true)
  jest.mocked(NfcManager.isEnabled).mockResolvedValueOnce(true)
  expect(await nfcState()).toBe('on')
})

test('nfcState counts a binding error as no NFC', async () => {
  jest.mocked(NfcManager.isSupported).mockRejectedValueOnce(new Error('no core nfc'))
  expect(await nfcState()).toBe('unsupported')

  jest.mocked(NfcManager.isSupported).mockResolvedValueOnce(true)
  jest.mocked(NfcManager.isEnabled).mockRejectedValueOnce(new Error('adapter gone'))
  expect(await nfcState()).toBe('unsupported')
})

test('openNfcSettings opens the system setting and says whether it could', async () => {
  jest.mocked(NfcManager.goToNfcSetting).mockResolvedValueOnce(true)
  expect(await openNfcSettings()).toBe(true)
  expect(NfcManager.goToNfcSetting).toHaveBeenCalledTimes(1)

  jest.mocked(NfcManager.goToNfcSetting).mockResolvedValueOnce(false)
  expect(await openNfcSettings()).toBe(false)

  jest.mocked(NfcManager.goToNfcSetting).mockRejectedValueOnce(new Error('no activity'))
  expect(await openNfcSettings()).toBe(false)
})

test('openNfcSettings answers false where the manager has no setting to open, as on iOS', async () => {
  const goTo = NfcManager.goToNfcSetting
  delete (NfcManager as { goToNfcSetting?: unknown }).goToNfcSetting
  try {
    expect(await openNfcSettings()).toBe(false)
  } finally {
    NfcManager.goToNfcSetting = goTo
  }
})

test('readNfcDestination decodes the first URI record and releases the reader', async () => {
  jest.mocked(NfcManager.getTag).mockResolvedValueOnce({
    ndefMessage: [{ tnf: 0x01, type: [0x55], payload: [0x00, 1, 2, 3] }],
  } as never)
  jest.mocked(Ndef.isType).mockImplementation((_r, _tnf, rtd) => rtd === Ndef.RTD_URI)
  jest.mocked(Ndef.uri.decodePayload).mockReturnValueOnce('lightning:lnbc1tag')

  const dest = await readNfcDestination(PROMPT)

  expect(dest).toEqual({ kind: 'address', value: 'lightning:lnbc1tag' })
  expect(NfcManager.cancelTechnologyRequest).toHaveBeenCalled()
})

test('readNfcDestination tells a tag with no text/URI record as no address', async () => {
  jest.mocked(NfcManager.getTag).mockResolvedValueOnce({
    ndefMessage: [{ tnf: 0x02, type: [], payload: [0x00] }],
  } as never)

  expect(await readNfcDestination(PROMPT)).toEqual({ kind: 'noAddress' })
  expect(NfcManager.cancelTechnologyRequest).toHaveBeenCalled()
})

test('readNfcDestination still releases the reader when the scan throws', async () => {
  jest.mocked(NfcManager.getTag).mockRejectedValueOnce(new Error('tag lost'))

  await expect(readNfcDestination(PROMPT)).rejects.toThrow('tag lost')
  expect(NfcManager.cancelTechnologyRequest).toHaveBeenCalled()
})

test('the line on the system reading sheet is the one passed in', async () => {
  // Without it the library shows its own English default, whatever language the app is in.
  await readNfcDestination('Aproxime o celular da etiqueta')

  expect(NfcManager.requestTechnology).toHaveBeenCalledWith(NfcTech.Ndef, {
    alertMessage: 'Aproxime o celular da etiqueta',
  })
})

test('a Cancel on the reading sheet resolves as cancelled, and releases the reader', async () => {
  // The library rejects a cancel with an error that has no message, so it reads as a failure unless
  // it is told apart by its class.
  jest.mocked(NfcManager.requestTechnology).mockRejectedValueOnce(new NfcError.UserCancel())

  await expect(readNfcDestination(PROMPT)).resolves.toEqual({ kind: 'cancelled' })
  expect(NfcManager.getTag).not.toHaveBeenCalled()
  expect(NfcManager.cancelTechnologyRequest).toHaveBeenCalled()
})

test('a failure that is not a cancel still rejects', async () => {
  jest.mocked(NfcManager.requestTechnology).mockRejectedValueOnce(new Error('session invalidated'))

  await expect(readNfcDestination(PROMPT)).rejects.toThrow('session invalidated')
  expect(NfcManager.cancelTechnologyRequest).toHaveBeenCalled()
})

// What the library does with a request that waits for a tag: it answers when a tag arrives or when
// the request is cancelled, and never by itself.
function waitingRequest(): { arrive: (tech: string | null) => void; rejectAs: (cause: Error) => void } {
  let arrive!: (tech: string | null) => void
  let rejectAs!: (cause: Error) => void
  jest.mocked(NfcManager.requestTechnology).mockImplementationOnce(
    () =>
      new Promise((resolve, reject) => {
        arrive = resolve as (tech: string | null) => void
        rejectAs = reject
      }) as never,
  )
  return {
    arrive: tech => arrive(tech),
    rejectAs: cause => rejectAs(cause),
  }
}

// Long enough for a read to reach requestTechnology through its awaits.
const settle = () => new Promise(resolve => setImmediate(resolve))

function tagWithAddress(address: string): void {
  jest.mocked(NfcManager.getTag).mockResolvedValueOnce({
    ndefMessage: [{ tnf: 0x01, type: [0x55], payload: [0x00, 1] }],
  } as never)
  jest.mocked(Ndef.isType).mockImplementation((_r, _tnf, rtd) => rtd === Ndef.RTD_URI)
  jest.mocked(Ndef.uri.decodePayload).mockReturnValueOnce(address)
}

describe('one read at a time', () => {
  test('a second read while one waits starts no request and answers busy', async () => {
    const tag = waitingRequest()
    const first = readNfcDestination(PROMPT)
    await settle()

    await expect(readNfcDestination(PROMPT)).resolves.toEqual({ kind: 'busy' })
    await expect(readNfcDestination(PROMPT)).resolves.toEqual({ kind: 'busy' })
    expect(NfcManager.requestTechnology).toHaveBeenCalledTimes(1)

    tagWithAddress('lnbc1first')
    tag.arrive('Ndef')
    await expect(first).resolves.toEqual({ kind: 'address', value: 'lnbc1first' })
  })

  test('a read pressed before the start finished is still only one request', async () => {
    const first = readNfcDestination(PROMPT)
    const second = readNfcDestination(PROMPT)

    await expect(second).resolves.toEqual({ kind: 'busy' })
    await first
    expect(NfcManager.requestTechnology).toHaveBeenCalledTimes(1)
  })

  test('the reader opens again once a read ended, failed reads included', async () => {
    jest.mocked(NfcManager.requestTechnology).mockRejectedValueOnce(new Error('session invalidated'))
    await expect(readNfcDestination(PROMPT)).rejects.toThrow('session invalidated')

    await expect(readNfcDestination(PROMPT)).resolves.toEqual({ kind: 'noAddress' })
    expect(NfcManager.requestTechnology).toHaveBeenCalledTimes(2)
  })

  test('the next request waits for the release of the last one', async () => {
    // Android holds cancelTechnologyRequest for a second and then unregisters, so a request made
    // inside that second would lose its registration.
    let release!: () => void
    jest.mocked(NfcManager.cancelTechnologyRequest).mockImplementationOnce(
      () => new Promise<void>(resolve => (release = resolve)) as never,
    )
    await readNfcDestination(PROMPT)

    const next = readNfcDestination(PROMPT)
    await settle()
    expect(NfcManager.requestTechnology).toHaveBeenCalledTimes(1)

    release()
    await next
    expect(NfcManager.requestTechnology).toHaveBeenCalledTimes(2)
  })

  test('a read does not wait for the release to answer', async () => {
    let release!: () => void
    jest.mocked(NfcManager.cancelTechnologyRequest).mockImplementationOnce(
      () => new Promise<void>(resolve => (release = resolve)) as never,
    )
    tagWithAddress('lnbc1quick')

    await expect(readNfcDestination(PROMPT)).resolves.toEqual({ kind: 'address', value: 'lnbc1quick' })
    release()
    await settle()
  })
})

describe('cancelling', () => {
  test('a cancel ends the waiting read as cancelled and releases the reader', async () => {
    waitingRequest()
    const read = readNfcDestination(PROMPT)
    await settle()

    cancelNfcRead()

    await expect(read).resolves.toEqual({ kind: 'cancelled' })
    expect(NfcManager.cancelTechnologyRequest).toHaveBeenCalledTimes(1)
  })

  test('the rejection the cancel brings shows nothing and frees the reader', async () => {
    const tag = waitingRequest()
    const read = readNfcDestination(PROMPT)
    await settle()

    cancelNfcRead()
    tag.rejectAs(new Error('cancelled'))

    await expect(read).resolves.toEqual({ kind: 'cancelled' })
    await expect(readNfcDestination(PROMPT)).resolves.toEqual({ kind: 'noAddress' })
  })

  test('a request the native side never answers does not hold the reader', async () => {
    // A cancel that lands while the library is still registering finds no request to answer.
    waitingRequest()
    const read = readNfcDestination(PROMPT)
    await settle()
    cancelNfcRead()
    await read

    jest.mocked(NfcManager.requestTechnology).mockClear()
    await expect(readNfcDestination(PROMPT)).resolves.toEqual({ kind: 'noAddress' })
    expect(NfcManager.requestTechnology).toHaveBeenCalledTimes(1)
  })

  test('a tag read after the cancel does nothing', async () => {
    const tag = waitingRequest()
    const read = readNfcDestination(PROMPT)
    await settle()

    cancelNfcRead()
    tag.arrive('Ndef')

    await expect(read).resolves.toEqual({ kind: 'cancelled' })
    expect(NfcManager.getTag).not.toHaveBeenCalled()
  })

  test('a cancel while the tag is being read drops what it held', async () => {
    let answer!: (tag: unknown) => void
    jest.mocked(NfcManager.getTag).mockImplementationOnce(
      () => new Promise(resolve => (answer = resolve)) as never,
    )
    const read = readNfcDestination(PROMPT)
    await settle()

    cancelNfcRead()
    answer({ ndefMessage: [{ tnf: 0x01, type: [0x55], payload: [0x00, 1] }] })

    await expect(read).resolves.toEqual({ kind: 'cancelled' })
  })

  test('a cancel while the last release runs starts no request at all', async () => {
    let release!: () => void
    jest.mocked(NfcManager.cancelTechnologyRequest).mockImplementationOnce(
      () => new Promise<void>(resolve => (release = resolve)) as never,
    )
    await readNfcDestination(PROMPT)
    jest.mocked(NfcManager.requestTechnology).mockClear()

    const read = readNfcDestination(PROMPT)
    await settle()
    cancelNfcRead()

    await expect(read).resolves.toEqual({ kind: 'cancelled' })
    release()
    await settle()
    expect(NfcManager.requestTechnology).not.toHaveBeenCalled()
  })

  test('a cancel with nothing reading does nothing', () => {
    expect(() => cancelNfcRead()).not.toThrow()
    expect(NfcManager.cancelTechnologyRequest).not.toHaveBeenCalled()
  })
})

test('a tag the library cannot connect to reads as no address, not as a failure', async () => {
  // Android answers a tag with none of the asked technology with a null technology and no rejection.
  jest.mocked(NfcManager.requestTechnology).mockResolvedValueOnce(null as never)

  await expect(readNfcDestination(PROMPT)).resolves.toEqual({ kind: 'noAddress' })
  expect(NfcManager.getTag).not.toHaveBeenCalled()
  expect(NfcManager.cancelTechnologyRequest).toHaveBeenCalled()
})
