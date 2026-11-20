import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// A react-native import missing from the warm-up list brings back a cold module require inside
// whichever test renders it first, which is how a cold runner timed out Convert's first test.
const ROOT = join(__dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

function importedFromReactNative(): Set<string> {
  const names = new Set<string>()
  for (const file of [...sources(join(ROOT, 'src')), join(ROOT, 'App.tsx')]) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'react-native'/g)) {
      if (/^import\s+type\b/.test(m[0])) continue
      for (const part of m[1]!.split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]!.trim()
        if (name && !name.startsWith('type ')) names.add(name)
      }
    }
  }
  return names
}

test('the warm-up reads every react-native export the app imports', () => {
  const warmed = new Set<string>(require('../jest.rnWarmup'))
  const reactNative = require('react-native') as Record<string, unknown>
  const imported = [...importedFromReactNative()]
  // A name the scan cannot find would make the check pass on nothing.
  expect(imported).toContain('View')
  // Type-only names have no runtime export and nothing to warm.
  const runtime = imported.filter(name => name in reactNative)
  expect(runtime.filter(name => !warmed.has(name))).toEqual([])
})
