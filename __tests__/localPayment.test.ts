import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// A payment method on the screen is a promise. The purchase opens on card alone for now, so no
// locale names PIX, Brazil's included, while the Bitcoin token DePix keeps its name.
const DIR = join(__dirname, '../src/i18n/locales')
const locales = readdirSync(DIR).map(file => file.replace('.json', ''))
const LOCAL_METHOD = /(?<![a-z])pix/i

function strings(node: unknown, prefix = ''): [string, string][] {
  if (typeof node === 'string') {
    return [[prefix, node]]
  }
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    strings(value, prefix ? `${prefix}.${key}` : key),
  )
}

const read = (locale: string) => JSON.parse(readFileSync(join(DIR, `${locale}.json`), 'utf8'))

test('reads all 24 locales', () => {
  expect(locales).toHaveLength(24)
})

test.each(locales)('%s names no PIX', locale => {
  expect(strings(read(locale)).filter(([, text]) => LOCAL_METHOD.test(text))).toEqual([])
})

test('the pattern reads a name beside Japanese text and leaves DePix alone', () => {
  expect('PIXまたはカード').toMatch(LOCAL_METHOD)
  expect('DePix').not.toMatch(LOCAL_METHOD)
})
