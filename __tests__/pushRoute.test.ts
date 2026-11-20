import {
  pushDestination,
  routeForegroundMessage,
  routePushNotification,
  setForegroundNoticeHandler,
  showForegroundNotice,
  setPushHandler,
} from '../src/wallet/pushRoute'

const NUL = String.fromCharCode(0)

// Payloads a hostile sender could put on the wire. Nothing here may reach a screen, and nothing
// here may throw, because a throw inside the notification handler is a crash on open.
const REJECTED: [string, unknown][] = [
  ['a screen name as the type', { type: 'Send' }],
  ['a screen name under another key', { screen: 'Send' }],
  ['a route under another key', { route: 'LnAddress', navigate: 'Send' }],
  ['a traversal dressed as a type', { type: '../Send' }],
  ['a path as the type', { type: 'Main/Send' }],
  ['the destination screen itself', { type: 'LnAddress' }],
  ['the allowed type capitalised', { type: 'Domain' }],
  ['the allowed type upper cased', { type: 'DOMAIN' }],
  ['the allowed type padded', { type: ' domain ' }],
  ['the allowed type with a trailing newline', { type: 'domain\n' }],
  ['the allowed type with a trailing null byte', { type: `domain${NUL}` }],
  ['a prototype key', { type: '__proto__' }],
  ['the constructor', { type: 'constructor' }],
  ['toString', { type: 'toString' }],
  ['hasOwnProperty', { type: 'hasOwnProperty' }],
  ['valueOf', { type: 'valueOf' }],
  ['an object where a string belongs', { type: {} }],
  ['an object that stringifies to the allowed type', { type: { toString: () => 'domain' } }],
  ['an array where a string belongs', { type: ['domain'] }],
  ['a numeric type', { type: 4 }],
  ['a boolean type', { type: true }],
  ['a null type', { type: null }],
  ['no type at all', { host: 'pay.bakery.com.br', stage: '4' }],
  ['an empty payload', {}],
  ['no payload', undefined],
  ['a null payload', null],
  ['a bare string payload', 'domain'],
  ['a numeric payload', 4],
  ['an array payload', ['domain']],
  ['a __proto__ key carrying the allowed type', JSON.parse('{"__proto__":{"type":"domain"}}')],
]

describe('pushDestination (the allowlist)', () => {
  it('maps the one shipped type to the one shipped destination', () => {
    expect(pushDestination({ type: 'domain' })).toBe('LnAddress')
  })

  it('ignores the rest of the payload, which is informational', () => {
    expect(
      pushDestination({
        type: 'domain',
        host: 'pay.bakery.com.br',
        stage: '4',
        screen: 'Send',
        params: { destination: 'lnbc1', assetId: 'btc' },
      }),
    ).toBe('LnAddress')
  })

  it.each(REJECTED)('refuses %s', (_label, payload) => {
    expect(pushDestination(payload)).toBeNull()
  })

  it.each(REJECTED)('does not throw on %s', (_label, payload) => {
    expect(() => pushDestination(payload)).not.toThrow()
  })

  it('refuses an enormous type without throwing', () => {
    expect(pushDestination({ type: 'a'.repeat(1_000_000) })).toBeNull()
    expect(pushDestination({ type: 'domain'.repeat(200_000) })).toBeNull()
  })

  it('refuses a type planted on Object.prototype', () => {
    const polluted = Object.prototype as unknown as Record<string, string>
    polluted.evil = 'LnAddress'
    try {
      expect(pushDestination({ type: 'evil' })).toBeNull()
    } finally {
      delete polluted.evil
    }
  })
})

describe('push router (stash + replay)', () => {
  // Registering a no-op handler flushes any stashed destination that would otherwise leak into the
  // next test.
  afterEach(() => {
    setPushHandler(() => undefined)
    setPushHandler(null)
  })

  it('routes a recognised payload and drops the rest', () => {
    const seen: string[] = []
    setPushHandler(d => seen.push(d))
    routePushNotification({ type: 'domain' })
    routePushNotification({ type: 'Send' })
    routePushNotification(null)
    expect(seen).toEqual(['LnAddress'])
  })

  it('stashes a tap that arrives with no handler, and replays it on registration', () => {
    const seen: string[] = []
    routePushNotification({ type: 'domain', host: 'pay.bakery.com.br' }) // app still locked
    expect(seen).toEqual([])
    setPushHandler(d => seen.push(d)) // navigator becomes ready
    expect(seen).toEqual(['LnAddress'])
  })

  it('replays the stashed destination once, not to every later handler', () => {
    const seen: string[] = []
    routePushNotification({ type: 'domain' })
    setPushHandler(d => seen.push(d))
    setPushHandler(d => seen.push(d)) // a second registration must not re-fire
    expect(seen).toEqual(['LnAddress'])
  })

  it('delivers once even when the handler registers the next handler', () => {
    const seen: string[] = []
    routePushNotification({ type: 'domain' })
    setPushHandler(d => {
      seen.push(`first:${d}`)
      setPushHandler(next => seen.push(`second:${next}`))
    })
    expect(seen).toEqual(['first:LnAddress'])
  })

  it('stashes nothing for a payload the table refuses', () => {
    const seen: string[] = []
    routePushNotification({ type: 'Send' })
    setPushHandler(d => seen.push(d))
    expect(seen).toEqual([])
  })

  it('stashes again after the navigator unmounts', () => {
    const seen: string[] = []
    setPushHandler(d => seen.push(`first:${d}`))
    setPushHandler(null)
    routePushNotification({ type: 'domain' })
    expect(seen).toEqual([])
    setPushHandler(d => seen.push(`second:${d}`))
    expect(seen).toEqual(['second:LnAddress'])
  })
})

describe('a message that arrives while the app is in front', () => {
  afterEach(() => setForegroundNoticeHandler(null))

  test("the app's own notice reaches the listener as it is, and is dropped without one", () => {
    const notice = { title: 'A payment failed', body: 'See History.', destination: null }
    expect(() => showForegroundNotice(notice)).not.toThrow()

    const seen: unknown[] = []
    setForegroundNoticeHandler(n => seen.push(n))
    showForegroundNotice(notice)

    expect(seen).toEqual([notice])
  })

  it('carries the words the gateway sent, and where the tap should go', () => {
    // The system draws nothing while the app is in front, so this is the only thing between the
    // message and being lost.
    const seen: unknown[] = []
    setForegroundNoticeHandler(n => seen.push(n))

    routeForegroundMessage({
      notification: { title: 'example.com is live', body: 'Your address can receive now.' },
      data: { type: 'domain', host: 'example.com', stage: 'ready' },
    })

    expect(seen).toEqual([
      { title: 'example.com is live', body: 'Your address can receive now.', destination: 'LnAddress' },
    ])
  })

  it('shows nothing for a message with no words of its own', () => {
    // A data-only message exists to carry a payload. A banner with an empty title is worse than
    // silence: it interrupts and says nothing.
    const seen: unknown[] = []
    setForegroundNoticeHandler(n => seen.push(n))

    routeForegroundMessage({ data: { type: 'domain' } })
    routeForegroundMessage({ notification: { body: 'body with no title' }, data: { type: 'domain' } })
    routeForegroundMessage({ notification: { title: '' }, data: { type: 'domain' } })

    expect(seen).toEqual([])
  })

  it('leaves a payment to the wallet, which announces it better and already does', () => {
    // The gateway sends the payment notice as a title and a body and no data at all. Meanwhile the
    // app is already showing IncomingBanner and then ReceivedOverlay, driven by the SDK event, with
    // the amount and the fiat line. A banner on top of that is the same news twice, once worse.
    const seen: unknown[] = []
    setForegroundNoticeHandler(n => seen.push(n))

    routeForegroundMessage({ notification: { title: 'Payment received', body: 'You received 1 000 sats' } })
    routeForegroundMessage({ notification: { title: 'Payment received' }, data: {} })
    routeForegroundMessage({ notification: { title: 'Payment received' }, data: { host: 'x' } })

    expect(seen).toEqual([])
  })

  it('shows the words even when the tap has nowhere to go', () => {
    // A type this build does not know is not a reason to withhold the news. The destination is null
    // and the banner still says what happened; only the tap goes nowhere.
    const seen: { destination: unknown }[] = []
    setForegroundNoticeHandler(n => seen.push(n))

    routeForegroundMessage({ notification: { title: 'Something' }, data: { type: 'from-a-newer-server' } })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.destination).toBeNull()
  })

  it('survives anything off the wire, since a throw here is a crash on arrival', () => {
    setForegroundNoticeHandler(() => undefined)
    for (const hostile of [null, undefined, 'text', 7, [], { notification: 'text' }, { notification: null }]) {
      expect(() => routeForegroundMessage(hostile)).not.toThrow()
    }
  })

  it('drops an arrival nobody is there to read, rather than stashing it', () => {
    // Unlike a tap, which is somebody asking to go somewhere and has to survive a wait that can be
    // long. The window with no listener here is the lock screen, seconds, and whoever opens the app
    // in them sees the state on the address screen itself.
    routeForegroundMessage({ notification: { title: 'while nobody listened' }, data: { type: 'domain' } })

    const seen: unknown[] = []
    setForegroundNoticeHandler(n => seen.push(n))

    expect(seen).toEqual([])
  })
})
