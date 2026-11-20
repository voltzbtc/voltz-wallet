import { createHash } from 'crypto'
import RNFS from 'react-native-fs'
import {
  TEMPLATE_MAX,
  TEMPLATE_SEPARATOR,
  expiryTemplates,
  isValidTemplate,
  joinExpiryTemplates,
  joinPaymentTemplates,
  loadRegistration,
  needsRegistration,
  paymentTemplates,
  registerDeviceMessage,
  registerDeviceMessageV3,
  registerDeviceMessageV4,
  registerDeviceMessageV5,
  registerPushDevice,
  saveRegistration,
  type PushDeps,
  type PushExpiryText,
  type PushPaymentText,
  type PushRegistration,
} from '../src/wallet/push'
import { consoleLines } from './support/consoleLines'

const DOMAIN = 'lnurl.usevoltz.app'
const PUB = '02'.padEnd(66, 'a')

function reg(over: Partial<PushRegistration> = {}): PushRegistration {
  return { pubkey: PUB, platform: 'android', token: 'tok-1', domain: DOMAIN, ...over }
}

function deps(over: Partial<PushDeps> = {}): PushDeps & { sent: string[]; signed: string[] } {
  const sent: string[] = []
  const signed: string[] = []
  return {
    sent,
    signed,
    gatewayUrl: 'https://lnurl.usevoltz.app/',
    domain: DOMAIN,
    platform: 'android',
    token: 'tok-1',
    identity: async () => PUB,
    sign: async message => {
      signed.push(message)
      return 'deadbeef'
    },
    now: () => 1_700_000_000_000,
    request: (async (url: string, init: RequestInit) => {
      sent.push(`${url}|${String(init.body)}`)
      return { ok: true, status: 200 } as Response
    }) as unknown as typeof fetch,
    ...over,
  }
}

beforeEach(async () => {
  const file = `${RNFS.DocumentDirectoryPath}/push-registration.json`
  if (await RNFS.exists(file)) {
    await RNFS.unlink(file)
  }
})

test('the signed statement pins the domain, wallet, platform and token', () => {
  const message = registerDeviceMessage(DOMAIN, PUB, 'android', 'tok-1', 1700)
  expect(message.split('\n')).toEqual([
    'voltz-push:v1',
    'register-device',
    DOMAIN,
    PUB,
    'android',
    'tok-1',
    '1700',
  ])
})

test('a first registration signs and posts', async () => {
  const d = deps()
  expect(await registerPushDevice(d)).toBe(true)
  expect(d.signed).toHaveLength(1)
  expect(d.sent[0]).toContain('https://lnurl.usevoltz.app/api/device')
  const body = JSON.parse(d.sent[0].split('|')[1])
  expect(body).toMatchObject({ pubkey: PUB, platform: 'android', token: 'tok-1', signature: 'deadbeef' })
  expect(body.timestamp).toBe(1_700_000_000)
})

test('an unchanged registration sends nothing on the next launch', async () => {
  const d = deps()
  await registerPushDevice(d)
  const again = deps()
  expect(await registerPushDevice(again)).toBe(false)
  expect(again.sent).toHaveLength(0)
  expect(again.signed).toHaveLength(0)
})

test('switching wallets re-points the same device', async () => {
  // The phone keeps its FCM token across a wallet switch, so comparing the token alone
  // would leave the new wallet with no route for its payments.
  await saveRegistration(reg())
  const other = '03'.padEnd(66, 'b')
  const d = deps({ identity: async () => other })
  expect(await registerPushDevice(d)).toBe(true)
  expect((await loadRegistration())?.pubkey).toBe(other)
})

test('a rotated token is registered again', async () => {
  await saveRegistration(reg())
  const d = deps({ token: 'tok-2' })
  expect(await registerPushDevice(d)).toBe(true)
})

test('a rejected registration is not remembered as done', async () => {
  const d = deps({
    request: (async () => ({ ok: false, status: 401 }) as Response) as unknown as typeof fetch,
  })
  await expect(registerPushDevice(d)).rejects.toThrow('401')
  expect(await loadRegistration()).toBeNull()
})

test('an empty token is refused before anything is signed', async () => {
  const d = deps({ token: '   ' })
  await expect(registerPushDevice(d)).rejects.toThrow()
  expect(d.signed).toHaveLength(0)
  expect(d.sent).toHaveLength(0)
})

test('a corrupt stored registration is treated as none, not as a crash', async () => {
  await RNFS.writeFile(`${RNFS.DocumentDirectoryPath}/push-registration.json`, '{oops', 'utf8')
  expect(await loadRegistration()).toBeNull()
  expect(needsRegistration(null, reg())).toBe(true)
})

test('wording added in a new statement version re-registers the device', () => {
  // Registration is decided field by field, so wording introduced by a later version changes nothing
  // here unless it is compared. Left out, every device already registered stays on the old statement
  // for good: it goes on receiving the expiry warnings and never the notice this version adds, with
  // nothing anywhere to notice that it did not move.
  const text = { ...v3Text(), readyTitle: 'T-ready', readyBody: 'B-ready' }
  const stored = { ...reg(), text: v3Text() }

  expect(needsRegistration(stored, { ...reg(), text })).toBe(true)
  expect(needsRegistration({ ...reg(), text }, { ...reg(), text })).toBe(false)
})

test('the signed statement matches the gateway byte for byte', () => {
  // The gateway's own tests pin this same golden vector. Both sides build this exact string; drift
  // on either end shows up in production only as rejected signatures.
  const pubkey = '02' + 'a'.repeat(64)
  expect(registerDeviceMessage('lnurl.usevoltz.app', pubkey, 'android', 'tok-1', 1700)).toBe(
    'voltz-push:v1\nregister-device\nlnurl.usevoltz.app\n02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nandroid\ntok-1\n1700',
  )
})

test('the namespace stays outside the one the SDK refuses to sign', () => {
  // breez/spark-sdk rejects any message whose prefix matches lnurl_models RESERVED_NAMESPACE
  // ("breez-lnurl:", ASCII case-insensitive), so a version string that drifted into it would make
  // every registration fail at signMessage rather than at the gateway.
  const message = registerDeviceMessage(DOMAIN, PUB, 'android', 'tok-1', 1700)
  expect(message.slice(0, 12).toLowerCase()).not.toBe('breez-lnurl:')
})

describe('notification wording', () => {
  const text = {
    locale: 'pt-BR',
    titleTemplate: 'Pagamento recebido',
    bodyTemplate: 'Você recebeu {amount} sats',
  }

  it('signs the wording, so a token holder cannot choose it', async () => {
    const d = deps({ text })
    await registerPushDevice(d)
    expect(d.signed[0]).toContain('voltz-push:v2')
    expect(d.signed[0]).toContain('Você recebeu {amount} sats')
    expect(JSON.parse(d.sent[0]!.split('|')[1]!).bodyTemplate).toBe('Você recebeu {amount} sats')
  })

  it('keeps the older form when the app sends no wording', async () => {
    const d = deps()
    await registerPushDevice(d)
    expect(d.signed[0]).toContain('voltz-push:v1')
    expect(JSON.parse(d.sent[0]!.split('|')[1]!).bodyTemplate).toBeUndefined()
  })

  it('re-registers when the app language changes', async () => {
    // Otherwise the device stays addressed in whatever language it was set up in.
    await saveRegistration({ ...reg(), text })
    expect(needsRegistration(await loadRegistration(), { ...reg(), text })).toBe(false)
    expect(
      needsRegistration(await loadRegistration(), {
        ...reg(),
        text: { locale: 'en-US', titleTemplate: 'Payment received', bodyTemplate: 'You received {amount} sats' },
      }),
    ).toBe(true)
  })
})

// The gateway fills {amount} in; i18next must not have eaten the braces on the way here.
it('every locale keeps the amount placeholder the gateway substitutes', () => {
  const fs = require('fs') as typeof import('fs')
  for (const file of fs.readdirSync('src/i18n/locales')) {
    const json = require(`../src/i18n/locales/${file}`)
    expect(typeof json.push?.receivedTitle).toBe('string')
    expect(json.push?.receivedBody).toContain('{amount}')
  }
})

// Unit separator, the byte that holds the five reminders apart inside one field of the statement.
// Spelled out here rather than imported, so a drift in the implementation moves only one side.
const US = '\u001f'
const STAGE_TITLES = ['T-month', 'T-week', 'T-lastDay', 'T-stopped', 'T-stillOff']
const STAGE_BODIES = ['B-month', 'B-week', 'B-lastDay', 'B-stopped', 'B-stillOff']

function v3Text(over: Partial<PushExpiryText> = {}): PushExpiryText {
  return {
    locale: 'pt-BR',
    titleTemplate: 'Pagamento recebido',
    bodyTemplate: 'Voce recebeu {amount} sats',
    expiryTitles: STAGE_TITLES.join(US),
    expiryBodies: STAGE_BODIES.join(US),
    ...over,
  }
}

describe('domain expiry reminders', () => {
  it('pins the ceiling and the separator to the values the gateway was built against', () => {
    // The gateway holds both as constants of its own, refusing a longer part and splitting the
    // field on this byte. A drift here is invisible to every other test, since they all read the
    // constant back: the wording would be signed, refused there, and the device left with no push
    // at all rather than with an English reminder.
    expect(TEMPLATE_MAX).toBe(120)
    expect(TEMPLATE_SEPARATOR).toHaveLength(1)
    expect(TEMPLATE_SEPARATOR.charCodeAt(0)).toBe(31)
    // The local US above stays a separate literal on purpose, so that a drift moves one side only.
    expect(TEMPLATE_SEPARATOR).toBe(US)
  })

  it('the v3 statement matches the gateway byte for byte', () => {
    // The gateway's own tests pin this same golden vector. Written out rather than rebuilt from the
    // helpers the implementation uses, since a helper that changed would move both sides of the
    // comparison and assert nothing.
    const pubkey = '02' + 'a'.repeat(64)
    expect(
      registerDeviceMessageV3('lnurl.usevoltz.app', pubkey, 'android', 'tok-1', v3Text(), 1700),
    ).toBe(
      'voltz-push:v3\nregister-device\nlnurl.usevoltz.app\n' +
        '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' +
        'android\ntok-1\npt-BR\nPagamento recebido\nVoce recebeu {amount} sats\n' +
        'T-month\u001fT-week\u001fT-lastDay\u001fT-stopped\u001fT-stillOff\n' +
        'B-month\u001fB-week\u001fB-lastDay\u001fB-stopped\u001fB-stillOff\n' +
        '1700',
    )
  })

  it('hashes to what the gateway hashes, so both ends build one string', () => {
    // The vector above says what the string looks like; this says it is the same string the other
    // side builds. The gateway's own tests pin the same sha256, 294 bytes over 14 lines, so this is
    // the part that keeps failing if either end moves a byte.
    const pubkey = '02' + 'a'.repeat(64)
    const ready = { ...v3Text(), readyTitle: 'T-ready', readyBody: 'B-ready' }
    const message = registerDeviceMessageV4('lnurl.usevoltz.app', pubkey, 'android', 'tok-1', ready, 1700)

    expect(message.split('\n')).toHaveLength(14)
    expect(Buffer.byteLength(message, 'utf8')).toBe(294)
    expect(createHash('sha256').update(message, 'utf8').digest('hex')).toBe(
      'c6676f0feff75d81bf1ceba24baaf3ea1bb2236f305ecafa899f210322048fd1',
    )
  })

  it('appends the ready wording at the end, leaving every earlier field where it was', () => {
    // Compared byte for byte, like the v3 vector above and for the same reason, since the gateway
    // verifies against exactly these bytes and a field moved by one line rejects every
    // registration. The point of this one is the shape, not the wording: the expiry pair keeps its
    // position and its five parts, and the two new fields sit after it and before the timestamp.
    const pubkey = '02' + 'a'.repeat(64)
    const ready = { ...v3Text(), readyTitle: 'T-ready', readyBody: 'B-ready' }
    expect(registerDeviceMessageV4('lnurl.usevoltz.app', pubkey, 'android', 'tok-1', ready, 1700)).toBe(
      'voltz-push:v4\nregister-device\nlnurl.usevoltz.app\n' +
        '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' +
        'android\ntok-1\npt-BR\nPagamento recebido\nVoce recebeu {amount} sats\n' +
        'T-month\u001fT-week\u001fT-lastDay\u001fT-stopped\u001fT-stillOff\n' +
        'B-month\u001fB-week\u001fB-lastDay\u001fB-stopped\u001fB-stillOff\n' +
        'T-ready\nB-ready\n' +
        '1700',
    )
  })

  it('separates the statement by newline and the reminders by the unit separator', () => {
    // Swapping the two produces a statement that still looks fine here and that every device is
    // refused on, because the field count the gateway reads no longer matches.
    const fields = registerDeviceMessageV3(DOMAIN, PUB, 'android', 'tok-1', v3Text(), 1700).split(
      '\n',
    )
    expect(fields).toHaveLength(12)
    expect(fields[9]!.split(US)).toEqual(STAGE_TITLES)
    expect(fields[10]!.split(US)).toEqual(STAGE_BODIES)
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 11]) {
      expect(fields[index]).not.toContain(US)
    }
  })

  it('keeps five elements even when one reminder is empty', () => {
    // The gateway picks the wording for a stage by position, so dropping an empty part would move
    // every later reminder one stage earlier.
    expect(joinExpiryTemplates(['a', '', 'c', 'd', 'e']).split(US)).toEqual(['a', '', 'c', 'd', 'e'])
  })

  it('refuses a set that is not exactly five', () => {
    expect(() => joinExpiryTemplates(['a', 'b', 'c', 'd'])).toThrow()
    expect(() => joinExpiryTemplates(['a', 'b', 'c', 'd', 'e', 'f'])).toThrow()
  })

  it('renders the reminders in stage order', () => {
    const rendered = expiryTemplates('pt-BR', key => key)
    expect(rendered?.expiryTitles.split(US)).toEqual([
      'push.domainMonthTitle',
      'push.domainWeekTitle',
      'push.domainLastDayTitle',
      'push.domainStoppedTitle',
      'push.domainStillOffTitle',
    ])
    expect(rendered?.expiryBodies.split(US)).toEqual([
      'push.domainMonthBody',
      'push.domainWeekBody',
      'push.domainLastDayBody',
      'push.domainStoppedBody',
      'push.domainStillOffBody',
    ])
  })

  it('accepts a translation that sits exactly on the ceiling', () => {
    const exact = 'x'.repeat(TEMPLATE_MAX)
    const rendered = expiryTemplates('de', (key, locale) =>
      key === 'push.domainWeekBody' && locale === 'de' ? exact : `${locale}:${key}`,
    )
    expect(rendered?.expiryBodies.split(US)[1]).toBe(exact)
  })

  it('falls back to English past the ceiling, and cuts nothing', () => {
    // Truncating would ship half a sentence to a lock screen for a year, and refusing the whole
    // registration would cost this device its payment notifications as well.
    const tooLong = 'x'.repeat(TEMPLATE_MAX + 1)
    const rendered = expiryTemplates('de', (key, locale) =>
      key === 'push.domainWeekBody' && locale === 'de' ? tooLong : `${locale}:${key}`,
    )
    const bodies = rendered!.expiryBodies.split(US)
    expect(bodies[1]).toBe('en-US:push.domainWeekBody')
    expect(bodies[0]).toBe('de:push.domainMonthBody')
    expect(rendered!.expiryBodies).not.toContain('xxx')
  })

  it('falls back to English for a translation carrying either separator', () => {
    // A separator inside a part forges a field boundary, so the signature would cover a different
    // set of fields than the gateway reads back out of it.
    const withUnit = expiryTemplates('de', (key, locale) =>
      key === 'push.domainStoppedTitle' && locale === 'de' ? `a${US}b` : `${locale}:${key}`,
    )
    expect(withUnit!.expiryTitles.split(US)[3]).toBe('en-US:push.domainStoppedTitle')
    const withNewline = expiryTemplates('de', (key, locale) =>
      key === 'push.domainStoppedTitle' && locale === 'de' ? 'a\nb' : `${locale}:${key}`,
    )
    expect(withNewline!.expiryTitles.split(US)[3]).toBe('en-US:push.domainStoppedTitle')
  })

  it('drops the reminders when English is unusable too', () => {
    expect(expiryTemplates('de', () => '')).toBeNull()
    expect(expiryTemplates('de', () => 'x'.repeat(TEMPLATE_MAX + 1))).toBeNull()
  })

  it('registers on the older statement when the reminders had to be dropped', async () => {
    // The gateway keeps accepting v2 and answers it with its own English defaults, so a device
    // that cannot word the reminders still gets them, and still gets its payments.
    const d = deps({
      text: {
        locale: 'pt-BR',
        titleTemplate: 'Pagamento recebido',
        bodyTemplate: 'Voce recebeu {amount} sats',
      },
    })
    expect(await registerPushDevice(d)).toBe(true)
    expect(d.signed[0]).toContain('voltz-push:v2\n')
    expect(JSON.parse(d.sent[0]!.split('|')[1]!).expiryTitles).toBeUndefined()
  })

  it('signs and sends the reminders when they are there', async () => {
    const d = deps({ text: v3Text() })
    expect(await registerPushDevice(d)).toBe(true)
    expect(d.signed[0]).toContain('voltz-push:v3\n')
    expect(JSON.parse(d.sent[0]!.split('|')[1]!).expiryBodies).toBe(STAGE_BODIES.join(US))
  })

  it('re-registers when only the reminder wording changed', async () => {
    // The payment wording follows the app language on its own; without the reminders in the
    // comparison they stay in the language the device was set up in, for a year.
    await saveRegistration({ ...reg(), text: v3Text() })
    expect(needsRegistration(await loadRegistration(), { ...reg(), text: v3Text() })).toBe(false)
    expect(
      needsRegistration(await loadRegistration(), {
        ...reg(),
        text: v3Text({ expiryTitles: STAGE_TITLES.map(t => `de:${t}`).join(US) }),
      }),
    ).toBe(true)
    expect(
      needsRegistration(await loadRegistration(), {
        ...reg(),
        text: v3Text({ expiryBodies: STAGE_BODIES.map(b => `de:${b}`).join(US) }),
      }),
    ).toBe(true)
  })

  it('follows a real change of app language, and goes quiet once it has', async () => {
    // Synthetic wording cannot show this. It takes two real locales to prove the renderings differ
    // at all, and the same locale twice to prove the app is not posting on every launch for the
    // rest of the year, which is how long the gateway keeps the reminders.
    const i18n = require('../src/i18n').default as typeof import('../src/i18n').default
    const textFor = (locale: string): PushExpiryText => ({
      locale,
      titleTemplate: i18n.t('push.receivedTitle', { lng: locale }),
      bodyTemplate: i18n.t('push.receivedBody', { lng: locale }),
      ...expiryTemplates(locale, (key, lng) => i18n.t(key, { lng }))!,
    })

    const first = deps({ text: textFor('pt-BR') })
    expect(await registerPushDevice(first)).toBe(true)
    expect(first.signed[0]).toContain('voltz-push:v3\n')

    const relaunch = deps({ text: textFor('pt-BR') })
    expect(await registerPushDevice(relaunch)).toBe(false)
    expect(relaunch.sent).toHaveLength(0)

    const switched = deps({ text: textFor('ja') })
    expect(await registerPushDevice(switched)).toBe(true)
    const stored = await loadRegistration()
    expect(stored?.text?.expiryTitles).toBe(textFor('ja').expiryTitles)
    expect(stored?.text?.expiryTitles).not.toBe(textFor('pt-BR').expiryTitles)
    expect(stored?.text?.expiryBodies).not.toBe(textFor('pt-BR').expiryBodies)

    const settled = deps({ text: textFor('ja') })
    expect(await registerPushDevice(settled)).toBe(false)

    const back = deps({ text: textFor('pt-BR') })
    expect(await registerPushDevice(back)).toBe(true)
    expect(await registerPushDevice(deps({ text: textFor('pt-BR') }))).toBe(false)
  })

  it('signs nothing when the device has no token, reminders included', async () => {
    const d = deps({ token: '   ', text: v3Text() })
    await expect(registerPushDevice(d)).rejects.toThrow()
    expect(d.signed).toHaveLength(0)
    expect(d.sent).toHaveLength(0)
  })

  it('leaves the previous wording stored when the gateway refuses, so the next launch retries', async () => {
    await registerPushDevice(deps({ text: v3Text() }))
    const changed = v3Text({
      locale: 'de',
      expiryTitles: STAGE_TITLES.map(t => `de:${t}`).join(US),
    })
    const failing = deps({
      text: changed,
      request: (async () => ({ ok: false, status: 500 }) as Response) as unknown as typeof fetch,
    })
    await expect(registerPushDevice(failing)).rejects.toThrow('500')
    expect((await loadRegistration())?.text?.expiryTitles).toBe(STAGE_TITLES.join(US))
    expect(needsRegistration(await loadRegistration(), { ...reg(), text: changed })).toBe(true)
  })

  it('reports a dead gateway to the caller instead of resolving as registered', async () => {
    // App.tsx:89 and ReceiveSpark.tsx:241 call this as fire and forget with .catch, so a gateway
    // that is down must not take the screen with it, and must not be remembered as done.
    const d = deps({
      text: v3Text(),
      request: (async () => {
        throw new Error('network down')
      }) as unknown as typeof fetch,
    })
    await expect(registerPushDevice(d).catch(() => 'handled')).resolves.toBe('handled')
    expect(await loadRegistration()).toBeNull()
  })
})

// The gateway substitutes {domain} when it sends the reminder, months later. A renderer that
// resolved it here would store one owner's host and put it on everybody else's lock screen.
it('every locale renders five usable reminders that still carry the domain placeholder', () => {
  const i18n = require('../src/i18n').default as typeof import('../src/i18n').default
  const fs = require('fs') as typeof import('fs')
  for (const file of fs.readdirSync('src/i18n/locales')) {
    const locale = file.replace(/\.json$/, '')
    const rendered = expiryTemplates(locale, (key, lng) => i18n.t(key, { lng }))
    expect(rendered).not.toBeNull()
    const titles = rendered!.expiryTitles.split(US)
    const bodies = rendered!.expiryBodies.split(US)
    expect(titles).toHaveLength(5)
    expect(bodies).toHaveLength(5)
    for (const part of [...titles, ...bodies]) {
      expect(isValidTemplate(part)).toBe(true)
    }
    for (const title of titles) {
      expect(title).toContain('{domain}')
    }
  }
})

// Version 5 adds the payment notices and the secret the provider signs the wallet's payment events with.
describe('payment webhook registration (v5)', () => {
  const SECRET = '0123456789abcdef'.repeat(4)
  const WEBHOOK_ID = 'AbCdEfGhIjKlMnOpQrStUv'
  const PAY_TITLES = ['T-lnReceived', 'T-lnSent', 'T-lnSendFailed', 'T-onchainSent', 'T-onchainReceived']
  const PAY_BODIES = ['B-lnReceived', 'B-lnSent', 'B-lnSendFailed', 'B-onchainSent', 'B-onchainReceived']

  function v5Text(over: Partial<PushPaymentText> = {}): PushPaymentText {
    return {
      ...v3Text(),
      readyTitle: 'T-ready',
      readyBody: 'B-ready',
      paymentTitles: PAY_TITLES.join(US),
      paymentBodies: PAY_BODIES.join(US),
      ...over,
    }
  }

  // A gateway that accepts v5 and answers the id the provider will post to.
  function gateway(answer: unknown = { registered: true, webhookId: WEBHOOK_ID }) {
    const sent: string[] = []
    const request = (async (url: string, init: RequestInit) => {
      sent.push(`${url}|${String(init.body)}`)
      return { ok: true, status: 200, json: async () => answer } as unknown as Response
    }) as unknown as typeof fetch
    return { sent, request }
  }

  function v5Deps(over: Partial<PushDeps> = {}) {
    const saved: string[] = []
    const forgotten: number[] = []
    const g = gateway()
    const d = deps({
      text: v5Text(),
      request: g.request,
      webhook: { secret: SECRET, held: false, save: async id => {
        saved.push(id)
      }, forgotten: async () => {
        forgotten.push(1)
      } },
      ...over,
    })
    return { d, saved, forgotten, sent: g.sent }
  }

  it('the v5 statement matches the gateway byte for byte', () => {
    // The gateway's own test pins this same string and digest, written out on both sides rather than
    // rebuilt from helpers, so a field moved on either end fails here instead of in production.
    const pubkey = '02' + 'a'.repeat(64)
    const message = registerDeviceMessageV5('lnurl.usevoltz.app', pubkey, 'android', 'tok-1', v5Text(), SECRET, 1700)
    expect(message).toBe(
      'voltz-push:v5\nregister-device\nlnurl.usevoltz.app\n' +
        '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' +
        'android\ntok-1\npt-BR\nPagamento recebido\nVoce recebeu {amount} sats\n' +
        'T-month\u001fT-week\u001fT-lastDay\u001fT-stopped\u001fT-stillOff\n' +
        'B-month\u001fB-week\u001fB-lastDay\u001fB-stopped\u001fB-stillOff\n' +
        'T-ready\nB-ready\n' +
        'T-lnReceived\u001fT-lnSent\u001fT-lnSendFailed\u001fT-onchainSent\u001fT-onchainReceived\n' +
        'B-lnReceived\u001fB-lnSent\u001fB-lnSendFailed\u001fB-onchainSent\u001fB-onchainReceived\n' +
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n' +
        '1700',
    )
    expect(message.split('\n')).toHaveLength(17)
    expect(createHash('sha256').update(message, 'utf8').digest('hex')).toBe(
      'b9c472d857d00292570b1a2184d570817de2247c7ec6b2164ee983ed5c5fb6bf',
    )
  })

  it('signs every new field, so none can be swapped under the same signature', () => {
    const pubkey = '02' + 'a'.repeat(64)
    const base = registerDeviceMessageV5(DOMAIN, pubkey, 'android', 'tok-1', v5Text(), SECRET, 1700)
    const swapped = [
      registerDeviceMessageV5(DOMAIN, pubkey, 'android', 'tok-1', v5Text(), 'f'.repeat(64), 1700),
      registerDeviceMessageV5(DOMAIN, pubkey, 'android', 'tok-1', v5Text({ paymentTitles: 'x' }), SECRET, 1700),
      registerDeviceMessageV5(DOMAIN, pubkey, 'android', 'tok-1', v5Text({ paymentBodies: 'x' }), SECRET, 1700),
    ]
    for (const other of swapped) {
      expect(other).not.toBe(base)
    }
    // The v4 lines stay where v4 has them, so the gateway's older parse is untouched.
    const v4 = registerDeviceMessageV4(DOMAIN, pubkey, 'android', 'tok-1', v5Text(), 1700).split('\n')
    expect(base.split('\n').slice(1, 13)).toEqual(v4.slice(1, 13))
  })

  it('signs v5 with the secret and the wording, and sends the same fields', async () => {
    const { d, sent } = v5Deps()
    expect(await registerPushDevice(d)).toBe(true)
    expect(d.signed[0]!.startsWith('voltz-push:v5\n')).toBe(true)
    expect(d.signed[0]).toContain(SECRET)
    const body = JSON.parse(sent[0]!.split('|')[1]!)
    expect(body).toMatchObject({
      webhookSecret: SECRET,
      paymentTitles: PAY_TITLES.join(US),
      paymentBodies: PAY_BODIES.join(US),
      readyTitle: 'T-ready',
    })
  })

  it('keeps the id the gateway answered, and never writes the secret to the registration file', async () => {
    const { d, saved } = v5Deps()
    await registerPushDevice(d)
    expect(saved).toEqual([WEBHOOK_ID])
    const file = await RNFS.readFile(`${RNFS.DocumentDirectoryPath}/push-registration.json`, 'utf8')
    expect(file).not.toContain(SECRET)
    expect(JSON.parse(file).text.paymentTitles).toBe(PAY_TITLES.join(US))
  })

  it('registers again while no id is held for the secret, however unchanged the file is', async () => {
    // A secret drawn again after a removal or a deletion has to reach the gateway, or every notice
    // signed with it is refused there.
    await registerPushDevice(v5Deps().d)
    const again = v5Deps()
    expect(await registerPushDevice(again.d)).toBe(true)
    const held = v5Deps({
      webhook: { secret: SECRET, held: true, save: async () => undefined, forgotten: async () => undefined },
    })
    expect(await registerPushDevice(held.d)).toBe(false)
    expect(held.sent).toHaveLength(0)
  })

  it('re-registers when only the payment wording changed', () => {
    const stored = { ...reg(), text: v5Text() }
    expect(needsRegistration(stored, { ...reg(), text: v5Text() })).toBe(false)
    expect(needsRegistration(stored, { ...reg(), text: v5Text({ paymentTitles: 'other' }) })).toBe(true)
    expect(needsRegistration(stored, { ...reg(), text: v5Text({ paymentBodies: 'other' }) })).toBe(true)
  })

  it('remembers nothing when the gateway accepts without a usable id, so the next connect retries', async () => {
    for (const answer of [{ registered: true }, { webhookId: '../device' }, null]) {
      const g = gateway(answer)
      const saved: string[] = []
      const d = deps({
        text: v5Text(),
        request: g.request,
        webhook: { secret: SECRET, held: false, save: async id => {
        saved.push(id)
      }, forgotten: async () => undefined },
      })
      await expect(registerPushDevice(d)).rejects.toThrow('without a webhook id')
      expect(saved).toEqual([])
      expect(await loadRegistration()).toBeNull()
    }
  })

  it('stays on v4 without a secret, and stores no payment wording it did not sign', async () => {
    const d = deps({ text: v5Text(), request: gateway().request })
    expect(await registerPushDevice(d)).toBe(true)
    expect(d.signed[0]!.startsWith('voltz-push:v4\n')).toBe(true)
    expect((await loadRegistration())?.text?.paymentTitles).toBeUndefined()
    // The secret arriving later is then a change, and moves the device to v5.
    const later = v5Deps()
    expect(await registerPushDevice(later.d)).toBe(true)
    expect(later.d.signed[0]!.startsWith('voltz-push:v5\n')).toBe(true)
  })

  it('never signs a secret that is not 64 hex characters', async () => {
    const d = deps({
      text: v5Text(),
      request: gateway().request,
      webhook: { secret: 'not-hex', held: false, save: async () => undefined, forgotten: async () => undefined },
    })
    await registerPushDevice(d)
    expect(d.signed[0]!.startsWith('voltz-push:v4\n')).toBe(true)
    expect(d.signed[0]).not.toContain('not-hex')
  })

  // A gateway that answers every registration with one refusal, counting the requests.
  function refusing(status: number, body: () => unknown) {
    const sent: string[] = []
    const request = (async (url: string, init: RequestInit) => {
      sent.push(`${url}|${String(init.body)}`)
      return { ok: false, status, json: async () => body() } as unknown as Response
    }) as unknown as typeof fetch
    return { sent, request }
  }

  it('raises nothing for a secret the gateway refused as forgotten, retires it once and keeps nothing', async () => {
    const g = refusing(410, () => ({ error: 'forgotten' }))
    const { d, saved, forgotten } = v5Deps({ request: g.request })

    expect(await registerPushDevice(d)).toBe(false)

    expect(forgotten).toHaveLength(1)
    expect(g.sent).toHaveLength(1)
    expect(saved).toEqual([])
    expect(await loadRegistration()).toBeNull()
  })

  it('never logs the secret, whatever the gateway answers', async () => {
    const lines = await consoleLines(async () => {
      await registerPushDevice(v5Deps().d)
      await registerPushDevice(v5Deps({ request: refusing(410, () => ({ error: 'forgotten' })).request }).d)
      for (const request of [
        refusing(500, () => ({ error: 'internal' })).request,
        refusing(410, () => {
          throw new SyntaxError('not json')
        }).request,
        gateway({ registered: true }).request,
        (async () => {
          throw new Error('network down')
        }) as unknown as typeof fetch,
      ]) {
        await registerPushDevice(v5Deps({ request }).d).catch(() => undefined)
      }
    })
    for (const line of lines) {
      expect(line).not.toContain(SECRET)
    }
  })

  it('retires nothing on any other refusal, which still fails so the next connect retries', async () => {
    for (const [status, body] of [
      [410, () => ({ error: 'gone' })],
      [410, () => null],
      [410, () => {
        throw new SyntaxError('not json')
      }],
      [409, () => ({ error: 'forgotten' })],
      [400, () => ({ error: 'forgotten' })],
      [500, () => ({ error: 'forgotten' })],
    ] as const) {
      const g = refusing(status, body)
      const { d, saved, forgotten } = v5Deps({ request: g.request })
      await expect(registerPushDevice(d)).rejects.toThrow(`device registration failed with ${status}`)
      expect(forgotten).toEqual([])
      expect(saved).toEqual([])
    }
  })
})

describe('payment wording', () => {
  // Every notice states the amount but the on-chain send, whose amount the provider never defines.
  const render = (key: string, locale: string) =>
    key.startsWith('push.onchainSent') ? `${locale}:${key}` : `${locale}:${key} {amount}`

  it('renders the five notices in the order the gateway reads them', () => {
    const rendered = paymentTemplates('pt-BR', render)
    expect(rendered?.paymentTitles.split(US)).toEqual([
      'pt-BR:push.lnReceivedTitle {amount}',
      'pt-BR:push.lnSentTitle {amount}',
      'pt-BR:push.lnSendFailedTitle {amount}',
      'pt-BR:push.onchainSentTitle',
      'pt-BR:push.onchainReceivedTitle {amount}',
    ])
    expect(rendered?.paymentBodies.split(US)[2]).toBe('pt-BR:push.lnSendFailedBody {amount}')
    expect(rendered?.paymentBodies.split(US)[3]).toBe('pt-BR:push.onchainSentBody')
  })

  it('falls back to English for a body that lost the amount, or one past the ceiling', () => {
    const lossy = (key: string, locale: string) =>
      locale === 'en-US' ? render(key, locale) : key === 'push.lnSentBody' ? 'no amount here' : 'x'.repeat(121)
    const rendered = paymentTemplates('de', lossy)
    expect(rendered?.paymentBodies.split(US)[1]).toBe('en-US:push.lnSentBody {amount}')
    expect(rendered?.paymentTitles.split(US)[0]).toBe('en-US:push.lnReceivedTitle {amount}')
  })

  it('falls back to English for an on-chain send body that states an amount', () => {
    // The provider's `total_amount` is the exit's total, never said to be what the recipient got, so
    // a translation that names a figure there would state one nobody verified.
    const stating = (key: string, locale: string) => (locale === 'de' ? `${locale}:${key} {amount}` : render(key, locale))
    const bodies = paymentTemplates('de', stating)!.paymentBodies.split(US)
    expect(bodies[3]).toBe('en-US:push.onchainSentBody')
    expect(bodies[4]).toBe('de:push.onchainReceivedBody {amount}')
    // English stating one too leaves the device on v4 rather than send it.
    expect(paymentTemplates('de', (key, locale) => `${locale}:${key} {amount}`)).toBeNull()
  })

  it('falls back to English for an on-chain send title that asks for an amount, as the gateway refuses it', () => {
    const stating = (key: string, locale: string) =>
      locale === 'de' && key === 'push.onchainSentTitle' ? 'Gesendet {amount}' : render(key, locale)
    const titles = paymentTemplates('de', stating)!.paymentTitles.split(US)
    expect(titles[3]).toBe('en-US:push.onchainSentTitle')
    // Another notice's title may still name it.
    expect(titles[1]).toBe('de:push.lnSentTitle {amount}')
  })

  it('drops the payment wording when English is unusable too', () => {
    expect(paymentTemplates('de', () => 'no placeholder')).toBeNull()
  })

  it('keeps five elements and refuses any other count', () => {
    expect(joinPaymentTemplates(['a', '', 'c', 'd', 'e']).split(US)).toHaveLength(5)
    expect(() => joinPaymentTemplates(['a', 'b'])).toThrow('exactly 5')
  })
})

// A claim the notices must not make (that funds return to the wallet), in English and pt-BR, so a
// revert in either is caught by name.
const EN_RETURN_CLAIM = /return to your wallet|voltam para a sua carteira/

// The gateway fills {amount} in and sends these while the app is closed, in the language the
// device registered with.
it('every locale renders five usable payment notices, with the amount wherever one is defined', () => {
  const i18n = require('../src/i18n').default as typeof import('../src/i18n').default
  const fs = require('fs') as typeof import('fs')
  const english = paymentTemplates('en-US', (key, lng) => i18n.t(key, { lng }))!
  for (const file of fs.readdirSync('src/i18n/locales')) {
    const locale = file.replace(/\.json$/, '')
    const json = require(`../src/i18n/locales/${file}`)
    for (const event of ['lnReceived', 'lnSent', 'lnSendFailed', 'onchainSent', 'onchainReceived']) {
      // Read from the file, so a key missing from a locale fails here rather than borrowing English.
      expect(typeof json.push[`${event}Title`]).toBe('string')
      if (event === 'onchainSent') {
        expect(json.push[`${event}Title`]).not.toContain('{amount}')
        expect(json.push[`${event}Body`]).not.toContain('{amount}')
      } else {
        expect(json.push[`${event}Body`]).toContain('{amount}')
      }
    }
    // A failed send states no outcome for the sats: nothing measured that they are back.
    expect(json.push.lnSendFailedBody).not.toMatch(EN_RETURN_CLAIM)
    expect(json.push.lnSendFailedBody).toContain('Voltz')
    const rendered = paymentTemplates(locale, (key, lng) => i18n.t(key, { lng }))
    expect(rendered).not.toBeNull()
    const bodies = rendered!.paymentBodies.split(US)
    expect(bodies).toHaveLength(5)
    for (const part of [...rendered!.paymentTitles.split(US), ...bodies]) {
      expect(isValidTemplate(part)).toBe(true)
    }
    if (!locale.startsWith('en')) {
      // Translated, not the English fallback.
      expect(rendered!.paymentBodies).not.toBe(english.paymentBodies)
    }
  }
})
