import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { colors, primarySoftSurface } from '../src/theme'

// The soft accent fill that paints a warning or a chosen option has one definition,
// primarySoftSurface in theme.ts, so a change to that surface reaches every card. A style that names
// the colour itself keeps the old fill when the token moves. The sources are read so that a
// style added anywhere in src meets the rule too.

const ROOT = join(__dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return sources(path)
    }
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

test('the surface is the soft accent fill and nothing else', () => {
  expect(primarySoftSurface).toEqual({ backgroundColor: colors.primarySoft })
})

test('no file but theme.ts names the soft accent colours', () => {
  const named = sources(join(ROOT, 'src'))
    .map(path => relative(ROOT, path))
    .filter(path => path !== join('src', 'theme.ts'))
    .filter(path => /colors\.primarySoft\b/.test(readFileSync(join(ROOT, path), 'utf8')))
    .sort()
  expect(named).toEqual([])
})
