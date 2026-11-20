import fs from 'fs'
import path from 'path'

// Touch lays out as a column with the 44pt floor built in. A caller that lays it across with
// flexDirection 'row' moves the floor's own centring onto the row, so the cross axis falls back to
// stretch and the content rides at the top of the box, above whatever sits beside it on the line.
// Six targets shipped that way, found only by looking at a screen, so every Touch whose style lays
// it across has to say how it aligns the cross axis.
const root = path.join(__dirname, '..', 'src')

function sources(dir: string): string[] {
  return fs.readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) {
      return sources(full)
    }
    return name.endsWith('.tsx') ? [full] : []
  })
}

// The text from `start` to where its braces close, or to `stop` outside any brace, so an arrow
// function's `>` inside a prop does not end the tag.
function scan(src: string, start: number, stop: string | null): string {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '{') {
      depth++
    } else if (c === '}') {
      depth--
      if (stop === null && depth === 0) {
        return src.slice(start, i + 1)
      }
    } else if (stop !== null && c === stop && depth === 0) {
      return src.slice(start, i + 1)
    }
  }
  return ''
}

function styleBlock(src: string, name: string): string | null {
  const at = src.search(new RegExp(`\\n  ${name}: \\{`))
  return at < 0 ? null : scan(src, src.indexOf('{', at), null)
}

test('every Touch laid across says how it aligns the cross axis', () => {
  let laidAcross = 0
  const unaligned: string[] = []
  for (const file of sources(root)) {
    const src = fs.readFileSync(file, 'utf8')
    for (const tag of src.matchAll(/<Touch\b/g)) {
      const opening = scan(src, tag.index ?? 0, '>')
      const style = opening.match(/\bstyle=\{([\s\S]*?)\}\s*(\w+=|>|\/>)/)
      for (const [, name] of style ? style[1].matchAll(/styles\.(\w+)/g) : []) {
        const block = styleBlock(src, name)
        if (block && /flexDirection: 'row'/.test(block)) {
          laidAcross++
          if (!/alignItems:/.test(block)) {
            const line = src.slice(0, tag.index).split('\n').length
            unaligned.push(`${path.relative(root, file)}:${line} styles.${name}`)
          }
        }
      }
    }
  }
  // Guards the scan itself, which would pass on a tree where it matched nothing.
  expect(laidAcross).toBeGreaterThan(20)
  expect(unaligned).toEqual([])
})
