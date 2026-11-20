import fs from 'fs'
import path from 'path'

// The dollar wallet is this install's own setting while its effect reaches the whole seed, so the
// switch and its confirmation have to say so in every language. No word list judges a sentence across
// 24 languages, so this holds the shape: the confirmation ends on a sentence the switch repeats word
// for word, and the line under the switch goes on to say what the setting cannot reach.
const SENTENCE_AT_LEAST = 8

const dir = path.join(__dirname, '..', 'src', 'i18n', 'locales')
const codes = fs
  .readdirSync(dir)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace('.json', ''))
  .sort()

type Stable = { deviceOnly: string; confirmOnBody: string; custody: string }
const stable = (code: string): Stable =>
  JSON.parse(fs.readFileSync(path.join(dir, `${code}.json`), 'utf8')).stable

// The longest ending of the confirmation that the switch also says.
function sharedEnding({ deviceOnly, confirmOnBody }: Stable): string {
  for (let start = 0; start < confirmOnBody.length; start++) {
    const ending = confirmOnBody.slice(start)
    if (deviceOnly.includes(ending)) {
      return ending.trim()
    }
  }
  return ''
}

test('every shipped locale is held here', () => {
  expect(codes).toHaveLength(24)
})

test.each(codes)('%s says the setting belongs to this device, and what it cannot reach', code => {
  const copy = stable(code)
  const shared = sharedEnding(copy)

  expect(shared.length).toBeGreaterThanOrEqual(SENTENCE_AT_LEAST)
  expect(copy.deviceOnly.endsWith(shared)).toBe(false)
})

test.each(codes.filter(code => !code.startsWith('en-')))('%s carries its own translation', code => {
  expect(sharedEnding(stable(code))).not.toBe(sharedEnding(stable('en-US')))
})

test.each(['es', 'es-MX'])('%s calls the phone a dispositivo, as the rest of the file does', code => {
  expect(Object.values(stable(code)).join(' ')).not.toMatch(/\baparato\b/)
})
