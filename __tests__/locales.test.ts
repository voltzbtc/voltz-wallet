import fs from 'fs'
import path from 'path'

// Every locale carries exactly en-US's keys, no em-dash, the same {{interpolation}} placeholders, and
// none of the words that name custody or brokerage (docs/principles.md). Locale files are
// auto-discovered, so a new language is covered the moment it lands.
const dir = path.join(__dirname, '..', 'src', 'i18n', 'locales')
const codes = fs
  .readdirSync(dir)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace('.json', ''))

type Json = { [k: string]: string | Json }
function flatten(obj: Json, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') {
      Object.assign(out, flatten(v, key))
    } else {
      out[key] = v as string
    }
  }
  return out
}
const load = (code: string): Record<string, string> =>
  flatten(JSON.parse(fs.readFileSync(path.join(dir, `${code}.json`), 'utf8')))

const DOUBLE = /\{\{\s*\w+\s*\}\}/g
const SINGLE = /\{\s*\w+\s*\}/g
const strip = (xs: RegExpMatchArray | null): string[] => (xs ?? []).map(x => x.replace(/\s/g, ''))

// `push.*` is the only family the gateway renders instead of i18next, and it fills single braces
// (src/wallet/push.ts). Collecting only `{{double}}` would let a lost `{domain}` ship a lock screen
// notification with a hole where the domain should be.
const placeholders = (s: string, key: string): string[] => {
  const found = strip(s.match(DOUBLE))
  if (key.startsWith('push.')) {
    found.push(...strip(s.replace(DOUBLE, '').match(SINGLE)))
  }
  return found.sort()
}

const en = load('en-US')
const enKeys = Object.keys(en).sort()
const others = codes.filter(c => c !== 'en-US')

// i18next asks Intl.PluralRules for the category of a count and reads `<key>_<category>`. A category
// the locale lacks renders the en-US form, so each language needs a form for every category CLDR gives
// it: Russian and Polish use few and many, Arabic zero, two, few and many, Hebrew two, and Portuguese,
// Spanish, French and Italian many (a round million). Plural keys are recognised by the bases en-US
// declares. On a device the categories come from src/i18n/pluralRules.ts, which pluralRules.test.ts
// holds to the ICU this suite reads.
const PLURAL = /_(zero|one|two|few|many|other)$/
const CLDR_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other']
const pluralBase = (key: string) => key.replace(PLURAL, '')
const pluralBases = [...new Set(enKeys.filter(k => PLURAL.test(k)).map(pluralBase))]
const isPluralForm = (key: string) => PLURAL.test(key) && pluralBases.includes(pluralBase(key))
// Sorted, so no check depends on the order an engine lists the categories in.
const pluralCategories = (code: string) =>
  new Intl.PluralRules(code)
    .resolvedOptions()
    .pluralCategories.sort((a, b) => CLDR_ORDER.indexOf(a) - CLDR_ORDER.indexOf(b))
// A plural base stands for all its forms, so a plain key with the base's own name stays distinct.
const shape = (keys: string[]) =>
  [...new Set(keys.map(k => (isPluralForm(k) ? `${pluralBase(k)}_<plural>` : k)))].sort()

// src/i18n/index.ts replaces i18next's formatter with one that formats no named format, so a string
// written as {{value, number}} would place the value raw. No string may ask for one.
const NAMED_FORMAT = /\{\{\s*\w+\s*,[^}]*\}\}/

test('the named format check finds one', () => {
  expect(NAMED_FORMAT.test('Total {{amount, currency(USD)}}')).toBe(true)
  expect(NAMED_FORMAT.test('Total {{amount}}')).toBe(false)
})

test.each(codes)('%s asks for no named format', code => {
  expect(Object.entries(load(code)).filter(([, value]) => NAMED_FORMAT.test(value))).toEqual([])
})

test('there are at least the 24 shipped locales', () => {
  expect(codes.length).toBeGreaterThanOrEqual(24)
})

test.each(others)('%s has exactly the same keys as en-US (nothing missing or orphaned)', code => {
  expect(shape(Object.keys(load(code)))).toEqual(shape(enKeys))
})

test.each(codes)('%s has a form for exactly the plural categories its language uses', code => {
  const wanted = pluralBases.flatMap(base => pluralCategories(code).map(c => `${base}_${c}`))
  const have = Object.keys(load(code)).filter(isPluralForm)
  expect({
    missing: wanted.filter(k => !have.includes(k)),
    extra: have.filter(k => !wanted.includes(k)),
  }).toEqual({ missing: [], extra: [] })
})

// Controls for the check above, which passes by default with no plural base or with a runtime whose
// Intl reports a single category for every language.
test('the plural check has bases to check and reads CLDR categories', () => {
  expect(pluralBases).toEqual(
    expect.arrayContaining(['welcome.words', 'receive.limitSats', 'deleteData.domain']),
  )
  expect(pluralCategories('ar')).toEqual(['zero', 'one', 'two', 'few', 'many', 'other'])
  expect(pluralCategories('ru')).toEqual(['one', 'few', 'many', 'other'])
  expect(pluralCategories('ja')).toEqual(['other'])
})

test.each(others)('%s uses no em-dash and preserves every interpolation placeholder', code => {
  const loc = load(code)
  for (const [key, value] of Object.entries(loc)) {
    expect(value).not.toContain('\u2014')
    // A plural form en-US lacks (Russian `_few`) carries what en-US's `_other` does.
    const reference = en[key] ?? (isPluralForm(key) ? en[`${pluralBase(key)}_other`] : undefined)
    if (reference !== undefined) {
      expect(placeholders(value, key)).toEqual(placeholders(reference, key))
    }
  }
})

// en-US is the source the other 23 are translated from, and the sweep above never loads it, so its
// own strings need their own pass.
test('en-US uses no em-dash', () => {
  for (const value of Object.values(en)) {
    expect(value).not.toContain('\u2014')
  }
})

// The placeholder teaches the shape to copy, so an example the field itself refuses teaches the
// user to fail. The Russian one was Cyrillic, which the ASCII-only validator rejects.
// The header draws this title on one line at its own size, and past this it shrinks and leaves the
// centre. 24 is what fits between the back control and the far edge on a 375pt phone.
test.each(codes)('%s keeps the dice title to what the header holds', code => {
  expect([...load(code)['dice.title']].length).toBeLessThanOrEqual(24)
})

// LUD-16 limits the part before the @, so a language written in another alphabet keeps a Latin word.
test.each(codes)('%s shows a sample name an address can hold', code => {
  expect(load(code)['useDomain.sampleName']).toMatch(/^[a-z0-9._-]+$/)
})

test.each(codes)('%s shows a domain example its own validation accepts', code => {
  const hostname = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
  const example = load(code)['useDomain.domainPlaceholder']
  expect(hostname.test(example)).toBe(true)
})

// No locale carries a word that names custody or brokerage, since the app holds no funds, takes no
// deposits, pays out no withdrawals and runs no trading venue (docs/principles.md). Convert is the
// app's own action and is not on the list.
//
// Whole words, in the scripts that separate words with spaces. Where a bare word is also the everyday
// word for something neutral, only its regulated compound is listed: French "retirer" alone is
// "remove", Hindi "जमा" alone is "accumulate", and 交易, 取引, 거래 and "giao dịch" alone are "transaction".
// Hebrew משיכה ("withdrawal") is listed in its definite form, since behind the prefix מ the bare word
// is also ממשיכה, "continues".
const REGULATED: Record<string, string[]> = {
  en: ['bank', 'banks', 'banking', 'banked', 'banker', 'bankers', 'deposit', 'deposits', 'deposited',
    'depositing', 'withdraw', 'withdraws', 'withdrew', 'withdrawn', 'withdrawing', 'withdrawal',
    'withdrawals', 'trade', 'trades', 'traded', 'trading', 'trader', 'traders', 'exchange', 'exchanges',
    'exchanged', 'exchanging', 'broker', 'brokers', 'brokered', 'brokerage'],
  pt: ['banco', 'bancos', 'bancário', 'bancária', 'depositar', 'depósito', 'depósitos', 'sacar',
    'saque', 'saques', 'negociar', 'negociação', 'corretora', 'corretoras', 'corretor',
    'casa de câmbio'],
  es: ['banco', 'bancos', 'bancario', 'bancaria', 'depositar', 'depósito', 'depósitos', 'retirar',
    'retiro', 'retiros', 'negociar', 'corredor', 'corredora', 'corretaje', 'casa de cambio'],
  fr: ['banque', 'banques', 'bancaire', 'dépôt', 'dépôts', 'déposer', 'retrait', 'retraits',
    'retirer des fonds', 'négocier', 'courtier', 'courtage', 'bourse', 'bureau de change'],
  it: ['banca', 'banche', 'bancario', 'deposito', 'depositi', 'depositare', 'prelievo', 'prelievi',
    'prelevare', 'negoziare', 'cambiavalute'],
  de: ['bank', 'banken', 'einzahlung', 'einzahlungen', 'einzahlen', 'abheben', 'abhebung', 'handel',
    'börse', 'kryptobörse', 'makler', 'wechselstube'],
  pl: ['bank', 'banku', 'banki', 'bankowy', 'depozyt', 'wpłata', 'wpłacić', 'handel', 'handlować',
    'giełda', 'giełdy', 'giełdzie', 'makler', 'kantor'],
  ru: ['банк', 'банка', 'банки', 'банков', 'банковский', 'депозит', 'вывод средств',
    'снятие средств', 'торговля', 'торговать', 'трейдинг', 'биржа', 'биржи', 'бирже', 'брокер',
    'обменник'],
  tr: ['banka', 'bankası', 'bankalar', 'mevduat', 'para yatır', 'para yatırma', 'para çek',
    'para çekme', 'ticaret', 'alım satım', 'borsa', 'borsası', 'komisyoncu', 'aracı kurum'],
  id: ['bank', 'setor', 'penyetoran', 'tarik tunai', 'penarikan', 'perdagangan', 'bursa', 'pialang'],
  vi: ['ngân hàng', 'nạp tiền', 'rút tiền', 'sàn giao dịch', 'môi giới', 'đổi tiền', 'buôn bán'],
  ar: ['بنك', 'بنوك', 'مصرف', 'مصارف', 'إيداع', 'سحب', 'تداول', 'بورصة', 'سمسار'],
  he: ['בנק', 'בנקים', 'הפקדה', 'להפקיד', 'משיכת כספים', 'המשיכה', 'למשיכה', 'במשיכה', 'מסחר', 'בורסה',
    'ברוקר'],
  hi: ['बैंक', 'जमा करें', 'जमा करना', 'जमा राशि', 'निकासी', 'ट्रेडिंग', 'व्यापार', 'एक्सचेंज',
    'ब्रोकर', 'दलाल'],
  ur: ['بینک', 'بینکنگ', 'جمع کرائیں', 'رقم نکلوائیں', 'تجارت', 'ٹریڈنگ', 'ایکسچینج', 'بروکر'],
}

// Substrings, in the scripts that do not separate words (and Korean, which fuses particles onto the
// word it follows), where a word boundary does not exist to match against.
const REGULATED_FRAGMENTS: Record<string, string[]> = {
  ja: ['銀行', '入金', '出金', '取引所', '取引量', '証券会社', 'ブローカー', 'トレード', '両替'],
  ko: ['은행', '입금', '출금', '거래소', '거래량', '중개인', '중개업', '증권사', '브로커', '트레이딩',
    '환전'],
  zh: ['银行', '存款', '取款', '提现', '提币', '交易所', '交易量', '经纪', '券商'],
  'zh-TW': ['銀行', '存款', '提款', '提現', '提幣', '交易所', '交易量', '經紀', '券商'],
  th: ['ธนาคาร', 'ฝากเงิน', 'ถอนเงิน', 'ซื้อขาย', 'เทรด', 'ตลาดแลกเปลี่ยน', 'นายหน้า', 'โบรกเกอร์'],
}

// Arabic and Hebrew attach conjunctions, prepositions and the article to the front of a word, so
// "للبنك" and "הבנק" are the listed word behind a prefix.
const PREFIX: Record<string, string> = {
  ar: '[وفبلك]{0,2}(?:ال)?',
  he: '[והבלמשכ]{0,3}',
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NOT_LETTER_BEFORE = '(?<![\\p{L}\\p{M}\\p{N}])'
const NOT_LETTER_AFTER = '(?![\\p{L}\\p{M}\\p{N}])'

// The listed entries a text contains, as written in the list.
function matcher(words: string[], fragments: string[], prefix = ''): (text: string) => string[] {
  const whole = words.map(word => ({
    word,
    re: new RegExp(`${NOT_LETTER_BEFORE}${prefix}${escapeRe(word)}${NOT_LETTER_AFTER}`, 'iu'),
  }))
  return text => [
    ...whole.filter(({ re }) => re.test(text)).map(({ word }) => word),
    ...fragments.filter(fragment => text.includes(fragment)),
  ]
}

const language = (code: string) => code.split('-')[0]
// English applies to every locale, since a loanword ("exchange", "trading") survives translation.
const regulatedIn = (code: string) =>
  matcher(
    [...REGULATED.en, ...(REGULATED[language(code)] ?? [])],
    REGULATED_FRAGMENTS[code] ?? REGULATED_FRAGMENTS[language(code)] ?? [],
    PREFIX[language(code)],
  )

// Reviewed uses, each pinned to one key, one entry and the locales that carry it. The last test fails
// when an exception stops matching, so a fixed translation takes its exception with it.
//
// The buyer's withdrawal from a purchase is the one use of the withdraw family, because it names the
// right to cancel a purchase and moves no funds out of anything the app holds. English carries the
// word only on the row that names the right; the confirm, the receipt and the states call it a
// cancellation, since "withdrawal requested" beside an amount of sats reads as money taken out. Every
// other locale uses its own term for the right, which the lists above do not hold.
const WITHDRAWAL = (key: string, word: string) => ({
  key: `withdrawal.${key}`,
  word,
  locales: ['en-US', 'en-GB'],
  why: 'the statutory withdrawal from a purchase',
})
const EXCEPTIONS: { key: string; word: string; locales: string[]; why: string }[] = [
  WITHDRAWAL('row', 'withdraw'),
]
const excepted = (code: string, key: string, word: string) =>
  EXCEPTIONS.some(e => e.key === key && e.word === word && e.locales.includes(code))

// "This update is required" is how a scam opens, so the notice points to the store and never commands
// or names a defect. Each language's own word for the store has to be in the sentences that send
// someone there, since a link in a banner is the other thing a scam leans on.
const STORE_WORD: Record<string, string> = {
  en: 'store', pt: 'loja', es: 'tienda', fr: 'boutique', 'fr-CA': 'magasin', de: 'Store', it: 'store',
  pl: 'skle', ru: 'магазин', tr: 'mağaza', id: 'toko', vi: 'cửa hàng', ja: 'ストア', ko: '스토어',
  zh: '商店', 'zh-TW': '商店', th: 'สโตร์', hi: 'स्टोर', ar: 'متجر', he: 'חנות', ur: 'اسٹور',
}
const UPDATE_KEYS = ['updateNotice.body', 'updateNotice.criticalBody', 'updateNotice.open', 'errors.updateApp']
const COMMANDED = new RegExp(
  [
    'obrigat', 'required', 'mandatory', 'must', 'urgent', 'obligatoi', 'obligator', 'obbligator',
    'erforderlich', 'pflicht', 'muss', 'wymagan', 'obowiązk', 'обязательн', 'срочно', 'zorunlu', 'wajib',
    'bắt buộc', '必須', '必须', '必需', '필수', 'จำเป็น', 'บังคับ', 'अनिवार्य', 'ज़रूरी', 'إلزامي', 'مطلوب',
    'חובה', 'لازمی', 'ضروری',
  ].join('|'),
  'iu',
)
const DEFECT = new RegExp(
  [
    '(?<!\\p{L})bug(?!\\p{L})', 'defeito', 'falha', 'erro', 'vulnerab', 'security', 'seguran', 'flaw', 'fix', 'corre',
    'risco', 'risk', 'danger', 'perig', 'fallo', 'défaut', 'faille', 'Fehler', 'Lücke', 'difetto',
    'błąd', 'luk', 'ошибк', 'уязвим', 'hata', 'açık', 'celah', 'lỗi', '漏洞', '缺陷', '不具合', '脆弱性',
    '결함', '취약', 'ช่องโหว่', 'ข้อบกพร่อง', 'खामी', 'कमज़ोरी', 'ثغرة', 'خلل', 'פגם', 'פרצה', 'خرابی',
  ].join('|'),
  'iu',
)

describe.each(codes)('%s on updating', code => {
  const loc = load(code)
  const update = Object.entries(loc).filter(([key]) => key.startsWith('updateNotice.') || key === 'errors.updateApp')

  test('points to the store in its own word', () => {
    const word = STORE_WORD[code] ?? STORE_WORD[language(code)]
    expect(word).toBeDefined()
    for (const key of UPDATE_KEYS) {
      expect(loc[key].toLowerCase()).toContain(word.toLowerCase())
    }
  })

  test('commands nothing and names no defect', () => {
    expect(update.length).toBe(7)
    for (const [, value] of update) {
      expect(value).not.toMatch(COMMANDED)
      expect(value).not.toMatch(DEFECT)
    }
  })
})

// Without a list for its language, a locale is checked against English alone and passes by being
// unread.
test.each(codes)('%s has a regulated vocabulary for its language', code => {
  const listed = REGULATED[language(code)] ?? REGULATED_FRAGMENTS[code] ?? REGULATED_FRAGMENTS[language(code)]
  expect(listed?.length).toBeGreaterThan(0)
})

// The regulated words in a locale's strings that no exception covers, as `key: word`, each once,
// since an English locale reads the English list twice.
const findings = (code: string, strings: Record<string, string>): string[] => {
  const find = regulatedIn(code)
  return [
    ...new Set(
      Object.entries(strings).flatMap(([key, value]) =>
        find(value)
          .filter(word => !excepted(code, key, word))
          .map(word => `${key}: ${word}`),
      ),
    ),
  ]
}

test.each(codes)('%s names no regulated financial service in its UI strings', code => {
  expect(findings(code, load(code))).toEqual([])
})

// A send that failed after its overlay says that and points at History. The SDK has no word on where
// the money stands at that moment, so nothing here may read as it having come back. `nav.history` is
// cut short because Polish and Russian inflect it inside a sentence.
const LATE_KEYS = [
  'send.lateFailedTitle',
  'send.lateCompleteTitle',
  'send.checkHistory',
  'notice.failedBody',
  ...['lightning', 'spark', 'bitcoin'].flatMap(rail => [`notice.failed.${rail}`, `notice.settled.${rail}`]),
]
test.each(codes)('%s reports a late failure without saying the money came back', code => {
  const strings = load(code)
  const refunded = strings['history.conversionRefunded']
  const history = strings['nav.history'].slice(0, 4)
  for (const key of LATE_KEYS) {
    expect(strings[key].trim()).not.toBe('')
    expect(strings[key]).not.toContain(refunded)
  }
  expect(strings['notice.failedBody']).toContain(history)
  expect(strings['send.checkHistory']).toContain(history)
})

// Each rail is named in every notice, in every language: Lightning and Spark by name, and the
// on-chain rail as the Bitcoin network. A notice on its way never shares the words of one that ended.
const RAIL_NAMES = { lightning: 'Lightning', spark: 'Spark', bitcoin: 'Bitcoin' } as const
const NOTICE_KINDS = ['incoming', 'received', 'sent', 'onTheWay', 'settled', 'failed']
test.each(codes)('%s names the rail in every payment notice', code => {
  const strings = load(code)
  for (const [rail, name] of Object.entries(RAIL_NAMES)) {
    for (const kind of NOTICE_KINDS) {
      expect(strings[`notice.${kind}.${rail}`]).toContain(name)
    }
    expect(strings[`notice.onTheWay.${rail}`]).not.toBe(strings[`notice.sent.${rail}`])
  }
})

// Controls for the exceptions, so a pass above means each one covered only its key, its word and its
// locales, and the word stayed a finding everywhere else.
describe('an exception', () => {
  const row = load('en-US')['withdrawal.row']

  test('covers its own key in its own locale', () => {
    expect(regulatedIn('en-US')(row)).toContain('withdraw')
    expect(findings('en-US', { 'withdrawal.row': row })).toEqual([])
  })

  test('leaves the word a finding under a key it does not pin, in or out of the withdrawal strings', () => {
    expect(findings('en-US', { 'home.title': row, 'withdrawal.receiptApple': row })).toEqual([
      'home.title: withdraw',
      'withdrawal.receiptApple: withdraw',
    ])
  })

  test('leaves the word a finding under its own key in a locale it does not list', () => {
    expect(findings('pt-BR', { 'withdrawal.row': row })).toEqual(['withdrawal.row: withdraw'])
    expect(findings('de', { 'withdrawal.row': row })).toEqual(['withdrawal.row: withdraw'])
  })
})

// Controls, so a pass above means the matcher looked and found nothing rather than could not find.
describe('the regulated vocabulary matcher', () => {
  const found = (code: string, find: (text: string) => string[]) =>
    Object.values(load(code)).some(value => find(value).length > 0)

  test('finds a whole word that is present, in any case ("Receive" in en-US)', () => {
    expect(found('en-US', matcher(['receive'], []))).toBe(true)
    expect(load('en-US')['receive.title']).toBe('Receive')
    expect(matcher(['receive'], [])(load('en-US')['receive.title'])).toEqual(['receive'])
  })

  test('does not match inside a longer word, on either side', () => {
    expect(found('en-US', matcher(['eceive'], []))).toBe(false)
    expect(found('en-US', matcher(['receiv'], []))).toBe(false)
  })

  test('finds a fragment in a script without spaces (接收 in zh)', () => {
    expect(found('zh', matcher([], ['接收']))).toBe(true)
  })

  test('finds a Hebrew word behind a prefix (ארנק in "שם הארנק")', () => {
    expect(load('he')['editWallet.name']).toBe('שם הארנק')
    expect(matcher(['ארנק'], [], PREFIX.he)(load('he')['editWallet.name'])).toEqual(['ארנק'])
    expect(matcher(['ארנק'], [])(load('he')['editWallet.name'])).toEqual([])
  })
})

// One test over the list rather than one per entry, so an empty list, which is where every fixed
// translation leads, still runs.
test('every exception still matches its string', () => {
  const stale = EXCEPTIONS.flatMap(e =>
    e.locales
      .filter(code => !regulatedIn(code)(load(code)[e.key]).includes(e.word))
      .map(code => `${code} ${e.key} (${e.word})`),
  )
  expect(stale).toEqual([])
})

// A key the code asks for and no locale holds renders as the raw key, and nothing else fails: the
// parity checks above compare locales with each other, never with the code. Dynamic keys
// (t(`errors.${code}`)) cannot be read statically and are left out; plural keys resolve through
// their _one and _other forms.
describe('the send review names no plumbing', () => {
  const ONCHAIN = /on-?chain|онч|オンチェーン|온체인|鏈上|链上|און-צ'יין|آن چین|على السلسلة/i

  test.each(codes)('%s', code => {
    const strings = load(code)
    expect(strings['send.onchainNeedsBitcoinMode']).not.toMatch(ONCHAIN)
    expect(strings['send.unsupported']).not.toContain('Spark')
    expect(strings['send.feeSpark']).not.toContain('Spark')
    expect(strings['send.netOnchain']).not.toMatch(/mainnet|メインネット|메인넷|主网|主網|مین نیٹ/i)
    expect(strings['send.netSpark']).toBeUndefined()
  })
})

describe('a conversion row', () => {
  test.each(['ar', 'he', 'ur'])('in %s its Latin figure sits in its own direction', code => {
    expect(load(code)['history.rowFrom']).toContain('\u2068{{amount}}\u2069')
  })
})

test('every literal key the code asks for exists in en-US', () => {
  const root = path.join(__dirname, '..')
  const files = [path.join(root, 'App.tsx')]
  const walk = (d: string): void => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) {
        walk(p)
      } else if (/\.tsx?$/.test(f)) {
        files.push(p)
      }
    }
  }
  walk(path.join(root, 'src'))
  const literal = /\bt\(\s*['"]([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)['"]/g
  const asked: string[] = []
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(literal)) {
      asked.push(`${path.relative(root, file)}: ${match[1]}`)
    }
  }
  const resolves = (key: string): boolean =>
    key in en || `${key}_one` in en || `${key}_other` in en
  // Guards the scan itself, which would pass on an empty tree.
  expect(asked.length).toBeGreaterThan(500)
  expect(asked.filter(entry => !resolves(entry.split(': ')[1]))).toEqual([])
})

// The gateway says only that a charge's sats were given back, not where they went, so the line names
// no recipient. A charge that bought its name or year before leaves nothing to give back and nothing to
// pay, which the line says from both sides; "nothing is owed" read as the payment owing nothing, and
// the Chinese 不欠 reads that way alone.
describe('the lines of a paid answer that owes nothing', () => {
  const GIVEN_BACK = ['recover.repaidBody', 'recover.paidAgainRepaidBody']
  const BOUGHT_BEFORE = ['recover.boughtBeforeBody', 'recover.boughtBeforeNameBody']

  test.each(['en-US', 'en-GB'])('%s names no recipient for sats given back', code => {
    const loc = load(code)
    for (const key of GIVEN_BACK) {
      expect(loc[key]).toMatch(/given back/)
      expect(loc[key]).not.toMatch(/\bto you\b/i)
    }
  })

  test.each(['en-US', 'en-GB'])('%s says a charge bought before leaves nothing to give back and nothing to pay', code => {
    const loc = load(code)
    for (const key of BOUGHT_BEFORE) {
      expect(loc[key]).toContain('nothing to give back and nothing to pay')
      expect(loc[key]).not.toMatch(/owed/)
    }
  })

  test.each(['zh', 'zh-TW'])('%s says a charge bought before leaves nothing to give back and nothing to pay', code => {
    const loc = load(code)
    for (const key of BOUGHT_BEFORE) {
      expect(loc[key]).not.toContain('不欠')
      expect(loc[key]).toMatch(/既没有要退还的，也没有要再付的|既沒有要退還的，也沒有要再付的/)
    }
  })
})

// No read proves funds outside the balance can still be had: the SDK's figure counts leaves too small
// to be worth recovering and leaves it never checks on chain (recover_funds.md). So no line about them
// speaks of getting them back, or of what can still be done with them.
const RECOVERY_WORDS: Record<string, string[]> = {
  en: ['recover', 'get back', 'still', ' can '],
  pt: ['recuper', 'ainda', 'dá para'],
  es: ['recuper', 'todavía', 'puedes'],
  fr: ['récupér', 'encore', 'pouvez'],
  de: ['zurück', 'weiterhin', 'kannst'],
  it: ['recuper', 'ancora', 'puoi'],
  pl: ['odzysk', 'nadal', 'możesz'],
  ru: ['верн', 'возвра', 'ещё', 'можно'],
  tr: ['geri al', 'hâlâ', 'alabilir'],
  id: ['pulih', 'masih', 'bisa'],
  vi: ['khôi phục', 'vẫn'],
  ar: ['استرد', 'لا يزال', 'بإمكان'],
  he: ['שחזר', 'שוחזר', 'עדיין', 'אפשר'],
  hi: ['वापस', 'अब भी'],
  ur: ['واپس', 'اب بھی'],
  ja: ['取り戻', 'できます'],
  ko: ['되찾', '복구'],
  zh: ['找回', '恢复', '恢復', '仍可'],
  th: ['กู้คืน', 'ยังกู้'],
}

test.each(codes)('%s promises no recovery of funds outside the balance', code => {
  const words = RECOVERY_WORDS[language(code)]
  expect(words).toBeDefined()
  const lines = Object.entries(load(code)).filter(([key]) => key.startsWith('recoverableFunds.'))
  expect(lines.map(([key]) => key).sort()).toEqual([
    'recoverableFunds.body',
    'recoverableFunds.staleBody',
    'recoverableFunds.title',
  ])
  for (const [key, value] of lines) {
    const lower = value.toLowerCase()
    expect([key, words.filter(word => lower.includes(word))]).toEqual([key, []])
  }
})

// An old read is no firmer than a fresh one, so the stale line opens with the synced line's hedge and
// only then says the figure is from the last reading.
test.each(codes)('%s keeps the hedge on a stale read of funds outside the balance', code => {
  const lines = load(code)
  const stale = lines['recoverableFunds.staleBody']
  expect(stale.startsWith(lines['recoverableFunds.body'])).toBe(true)
  expect(stale.length).toBeGreaterThan(lines['recoverableFunds.body'].length + 1)
})

// The screen tells what the exit costs in time and money and promises no day, in every language.
test('Brazilian Portuguese names the exit as agreed', () => {
  expect(load('pt-BR')['emergencyExit.title']).toBe('Saída de emergência')
})

test.each(codes)('%s says what an emergency exit asks of the person, with no date', code => {
  const lines = load(code)
  expect(lines['emergencyExit.title']).not.toBe('')
  for (const key of ['introDays', 'introFee', 'introOpen', 'introDevice', 'introOtherDevice', 'introAll']) {
    expect(lines[`emergencyExit.${key}`]).not.toBe('')
  }
  expect(lines['emergencyExit.introOpen']).toMatch(/8/)
  expect(lines['emergencyExit.trackBody']).toMatch(/8/)
  expect(lines['emergencyExit.introDays']).not.toMatch(/\d/)
  expect(lines['emergencyExit.trackBody']).not.toMatch(/[0-79]/)
})

// Each leaf waits on relative timelocks of 1,300 to 2,000 blocks for its node and 200 to 1,900 for its
// refund, read from the SDK's own store on a real wallet: 16 to 26 days at ten minutes a block. So the
// line says weeks, in each language's own word for them.
const WEEK_WORDS: Record<string, RegExp> = {
  en: /\bweeks\b/,
  pt: /\bsemanas\b/,
  es: /\bsemanas\b/,
  fr: /\bsemaines\b/,
  de: /\bWochen\b/,
  it: /\bsettimane\b/,
  pl: /tygodni/,
  ru: /недел/,
  tr: /\bhafta\b/,
  id: /\bminggu\b/,
  vi: /\btuần\b/,
  ja: /週間/,
  ko: /주/,
  zh: /周|週/,
  th: /สัปดาห์/,
  hi: /हफ़्ते/,
  ar: /أسابيع/,
  he: /שבועות/,
  ur: /ہفتے/,
}

test.each(codes)('%s says an exit takes weeks', code => {
  expect(WEEK_WORDS[language(code)]).toBeDefined()
  expect(load(code)['emergencyExit.introDays']).toMatch(WEEK_WORDS[language(code)])
})

test.each(['pt-BR', 'pt-PT', 'es', 'es-MX'])('%s keeps the exit clear of the verbs of a payout', code => {
  const lines = Object.entries(load(code)).filter(([key]) => key.startsWith('emergencyExit.'))
  expect(lines.length).toBeGreaterThan(50)
  for (const [key, value] of lines) {
    expect([key, /\b(retir|sac[ao]|saque|deposit)/i.test(value)]).toEqual([key, false])
  }
})

// A pending payment is received or sent back, and asking to claim it reads as money held elsewhere.
const CLAIM_WORDS: Record<string, string[]> = {
  en: ['claim'],
  pt: ['reivindic'],
  es: ['reclam'],
  fr: ['réclam'],
  de: ['einlös'],
  it: ['riscatt'],
  id: ['klaim'],
  hi: ['दावा', 'क्लेम'],
  zh: ['认领', '認領'],
  th: ['เรียกรับ'],
  tr: ['talep'],
  ar: ['مطالبة'],
}

test.each(codes)('%s words pending funds without claiming', code => {
  const words = [...CLAIM_WORDS.en, ...(CLAIM_WORDS[language(code)] ?? [])]
  const pending = Object.entries(load(code)).filter(([key]) => key.startsWith('deposits.'))
  expect(pending.length).toBeGreaterThan(0)
  for (const [key, value] of pending) {
    const lower = value.toLowerCase()
    expect([key, words.filter(word => lower.includes(word))]).toEqual([key, []])
  }
})

// A live exit spends what sits at its fee address, child after child, so a line that sends the person
// to open that address elsewhere belongs to the screen of a finished exit alone.
test('only the end of an exit tells where the fee address opens', () => {
  for (const code of codes) {
    const texts = load(code)
    const opening = Object.keys(texts).filter(key => key.startsWith('emergencyExit.') && texts[key].includes('BIP84'))
    expect([code, opening]).toEqual([code, ['emergencyExit.doneLeft']])
  }
})

// A check answers Valid with the chain down, so the time under the follow-up dates the app's last try
// and never a check that confirmed anything. Each language's word for a check stays out of it.
const CHECK_WORDS: Record<string, RegExp> = {
  en: /check|confirm|verif/i,
  pt: /checag|verifica|confirm/i,
  es: /revisi|comprobaci|verifica/i,
  fr: /vérifi|contrôl/i,
  de: /geprüft|prüf/i,
  it: /controll|verific/i,
  pl: /sprawdz/i,
  ru: /провер/i,
  tr: /kontrol/i,
  id: /periksa/i,
  vi: /kiểm tra/i,
  ja: /確認/,
  ko: /확인/,
  zh: /检查|檢查|确认|確認/,
  th: /ตรวจ/,
  hi: /जाँच|जांच/,
  ar: /فحص|تحقق/,
  he: /בדיקה|אימות/,
  ur: /جانچ|تصدیق/,
}

test.each(codes)('%s dates the last try at an exit, never a check', code => {
  const line = load(code)['emergencyExit.trackCheckedAt']
  expect(CHECK_WORDS[language(code)]).toBeDefined()
  expect(line).not.toMatch(CHECK_WORDS[language(code)])
  expect(line).not.toMatch(CHECK_WORDS.en)
})

test.each(['en-US', 'en-GB'])('%s calls the time under the follow-up an attempt', code => {
  expect(load(code)['emergencyExit.trackCheckedAt']).toMatch(/\battempt\b/i)
})

// The exit moves sat leaves and no token, so its first screen never speaks of the whole balance.
test('the first screen of an exit keeps tokens out of what it promises', () => {
  for (const code of codes) {
    const line = load(code)['emergencyExit.introAll']
    expect([code, line.includes('USDB') && line.includes('DePix')]).toEqual([code, true])
  }
  expect(load('en-US')['emergencyExit.introAll']).not.toMatch(/whole balance/)
  expect(load('pt-BR')['emergencyExit.introAll']).not.toMatch(/todo o seu saldo/)
})

// An invoice already used may hold this wallet's own payment, which the SDK finishes on a later sync,
// so its line never sends the person off for a new invoice. Each locale's expired-invoice line ends
// with its own words for that, which are the probe: the last sentence, or the last phrase in a
// script that ends a sentence with a space (th).
const askNew = (code: string): string => {
  const line = load(code)['send.invoiceRanOut'].trim().replace(/[.。۔।]$/, '')
  const sentences = line.split(/[.。۔।]\s*/)
  const last = sentences.length > 1 ? sentences[sentences.length - 1] : line.split(/\s+/).pop() ?? ''
  return last.trim().toLowerCase()
}

test('the probe for asking for a new invoice is the last sentence, or the last phrase in Thai', () => {
  expect(askNew('en-US')).toBe('ask for a new one')
  expect(askNew('pt-BR')).toBe('peça uma nova')
  expect(askNew('zh')).toBe('请索取新的发票')
  expect(askNew('th')).toBe('ขอใบใหม่')
})

test.each(codes)('%s never asks for a new invoice on one already used', code => {
  expect(load(code)['errors.invoiceUsed'].toLowerCase()).not.toContain(askNew(code))
})

// Chinese text takes the full-width comma (U+FF0C), so an ASCII one beside a Han character is a slip.
const HAN = '\\u3400-\\u4dbf\\u4e00-\\u9fff'
const ASCII_COMMA_BY_HAN = new RegExp(`[${HAN}],|,[${HAN}]`)

test('the comma check finds one', () => {
  expect(ASCII_COMMA_BY_HAN.test('保留,地址')).toBe(true)
  expect(ASCII_COMMA_BY_HAN.test('sats,手续费')).toBe(true)
  expect(ASCII_COMMA_BY_HAN.test('保留，地址')).toBe(false)
  expect(ASCII_COMMA_BY_HAN.test('Spark, Lightning')).toBe(false)
})

test.each(['zh', 'zh-TW'])('%s puts no ASCII comma beside a Han character', code => {
  const slips = Object.entries(load(code))
    .filter(([, value]) => ASCII_COMMA_BY_HAN.test(value))
    .map(([key]) => key)
  expect(slips).toEqual([])
})
