import fs from 'fs'
import path from 'path'

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? sources(full) : /\.(ts|tsx|json)$/.test(entry.name) ? [full] : []
  })
}

// No source file links to the legacy wallet's domain, which is a separate product outside this app.
test('no source file links to the v1 wallet domain', () => {
  const files = [...sources(path.join(__dirname, '..', 'src')), path.join(__dirname, '..', 'App.tsx')]
  expect(files.length).toBeGreaterThan(50)
  const hits = files.filter(file => /lnvoltz\.com/i.test(fs.readFileSync(file, 'utf8')))
  expect(hits).toEqual([])
})
