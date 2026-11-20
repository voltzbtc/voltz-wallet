#!/usr/bin/env node
/**
 * Walks the journeys that only break on a device, and asserts on what it finds: the app starts,
 * unlocks with the PIN and shows a balance, holds a lightning address, and that address resolves
 * from outside. The unit suite runs none of this against a real SDK, a real screen or a real
 * network.
 *
 * It drives the simulator or emulator through the accessibility tree with tools a mobile setup
 * already has (xcrun simctl and idb on iOS, adb on Android). Maestro and Detox are left out: the
 * first installs by piping a remote script to a shell, and the second needs native build
 * configuration for little gain over this.
 *
 * The address check matters most. An address replaced by a generated one leaves no trace on either
 * side, so reading it on screen and resolving it from outside is how the replacement surfaces.
 *
 *   node scripts/device-smoke.mjs [--pin <pin>] [--android] [--boot-only]
 *
 * It needs a booted iOS simulator with idb (on PATH, or at IDB_PATH), or a booted Android emulator
 * with adb, and picks whichever is running; --android settles it when both are. The PIN comes from
 * --pin or the VOLTZ_TEST_PIN environment variable, and is required unless --boot-only.
 *
 * --boot-only asserts that the app starts and draws a screen of its own, and stops there. That is
 * what a fresh install can answer and what CI runs. The rest needs a wallet that already holds an
 * address, so it stays a release gate on a machine that has one.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

// IDB_PATH names the idb binary when it is not on PATH.
const IDB = process.env.IDB_PATH || 'idb'
const BUNDLE = 'app.usevoltz'
const PIN = process.argv.includes('--pin')
  ? process.argv[process.argv.indexOf('--pin') + 1]
  : process.env.VOLTZ_TEST_PIN
// Everything past the PIN needs a wallet, and CI has none, so CI runs this mode.
const BOOT_ONLY = process.argv.includes('--boot-only')

const checks = []
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (err) {
    return ''
  }
}

// Both platforms answer the same questions, so the walk below names no platform. They differ in how
// a screen is read and how the address gets off it: the emulator image has no `cmd clipboard`, so
// Android reads the address from the tree.
//
// The clipboard outlives the run that wrote it, so a run that never reached the address screen
// would read the previous run's address and have it confirmed from outside. iOS clears it before
// copying; a label read from the tree cannot survive a run it was not in.
const ios = {
  name: 'simulator',
  device() {
    const out = sh('xcrun', ['simctl', 'list', 'devices', 'booted'])
    const found = out.match(/\(([0-9A-F-]{36})\) \(Booted\)/)
    return found ? found[1] : null
  },
  restart(device) {
    sh('xcrun', ['simctl', 'terminate', device, BUNDLE])
    return sh('xcrun', ['simctl', 'launch', device, BUNDLE])
  },
  nodes(device) {
    const out = sh(IDB, ['ui', 'describe-all', '--udid', device])
    let parsed = []
    try {
      parsed = JSON.parse(out)
    } catch (err) {
      return []
    }
    const found = []
    for (const e of parsed) {
      const label = String(e.AXLabel || '').trim()
      if (label && e.frame) {
        found.push({
          label,
          x: Math.round(e.frame.x + e.frame.width / 2),
          y: Math.round(e.frame.y + e.frame.height / 2),
        })
      }
    }
    return found
  },
  press(device, x, y) {
    sh(IDB, ['ui', 'tap', '--udid', device, String(x), String(y)])
  },
  inFront(device) {
    return sh('xcrun', ['simctl', 'spawn', device, 'launchctl', 'list']).indexOf(BUNDLE) !== -1
  },
  // The screen shows the address truncated, so the copy button is the only way to the whole of it.
  // Cleared first, for the reason in the comment above this object.
  address(device) {
    sh('sh', ['-c', `printf '' | xcrun simctl pbcopy ${device}`])
    return { copyFirst: true, read: () => sh('xcrun', ['simctl', 'pbpaste', device]).trim() }
  },
}

const android = {
  name: 'emulator',
  device() {
    const out = sh('adb', ['devices'])
    const found = out.match(/^(\S+)\s+device$/m)
    return found ? found[1] : null
  },
  restart(device) {
    sh('adb', ['-s', device, 'shell', 'am', 'force-stop', BUNDLE])
    // monkey reports a refused launch on stderr and exits non-zero, which sh() would turn into ''.
    // An AVD with no hardware keys refuses monkey's default system key events (exit 251), so the one
    // launch event sends none.
    return sh('adb', ['-s', device, 'shell',
                      `monkey --pct-syskeys 0 -p ${BUNDLE} -c android.intent.category.LAUNCHER 1 2>&1; echo "exit $?"`])
  },
  nodes(device) {
    sh('adb', ['-s', device, 'shell', 'uiautomator', 'dump', '/sdcard/voltz-smoke.xml'])
    const xml = sh('adb', ['-s', device, 'shell', 'cat', '/sdcard/voltz-smoke.xml'])
    const found = []
    for (const node of xml.match(/<node[^>]*>/g) || []) {
      const text = node.match(/\stext="([^"]*)"/)
      const desc = node.match(/content-desc="([^"]*)"/)
      const box = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
      const label = ((text ? text[1] : '') || (desc ? desc[1] : '')).trim()
      if (label && box) {
        found.push({
          label,
          x: Math.round((Number(box[1]) + Number(box[3])) / 2),
          y: Math.round((Number(box[2]) + Number(box[4])) / 2),
        })
      }
    }
    return found
  },
  press(device, x, y) {
    sh('adb', ['-s', device, 'shell', 'input', 'tap', String(x), String(y)])
  },
  resumed(device) {
    const out = sh('adb', ['-s', device, 'shell', 'dumpsys', 'activity', 'activities'])
    const line = out.match(/ResumedActivity.*/)
    return line ? line[0].trim() : ''
  },
  // A crash on start leaves the launcher resumed, which is what makes this able to fail at all.
  inFront(device) {
    return android.resumed(device).indexOf(BUNDLE) !== -1
  },
  address() {
    return { copyFirst: false, read: null }
  },
}

const driver = process.argv.includes('--android') || (!ios.device() && android.device()) ? android : ios

const nodes = device => driver.nodes(device)
const labels = device => nodes(device).map(n => n.label)

const tap = (device, match) => {
  for (const n of nodes(device)) {
    if (match(n.label)) {
      driver.press(device, n.x, n.y)
      return true
    }
  }
  return false
}

const wait = ms => new Promise(r => setTimeout(r, ms))

// Waits for a condition rather than for a duration. A fixed sleep either wastes time or reports a
// failure that was only slowness, and the second is the expensive one: it sends somebody hunting.
async function until(fn, seconds) {
  for (let i = 0; i < (seconds || 45); i++) {
    if (fn()) return true
    await wait(1000)
  }
  return false
}

// The words the two first screens can show, in every language the app ships. Collected from the
// locale files so a new language is covered the moment it lands, and so this list cannot drift from
// what the app actually renders.
function firstScreenWords() {
  const dir = new URL('../src/i18n/locales/', import.meta.url)
  const words = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    let locale
    try {
      locale = JSON.parse(readFileSync(new URL(name, dir), 'utf8'))
    } catch (err) {
      continue
    }
    for (const value of [locale.pin && locale.pin.enter, locale.welcome && locale.welcome.create,
                         locale.welcome && locale.welcome.import]) {
      if (typeof value === 'string' && value !== '' && words.indexOf(value) === -1) {
        words.push(value)
      }
    }
  }
  return words
}

async function main() {
  if (!BOOT_ONLY && !PIN) {
    console.error('no PIN. Pass --pin <pin> or set VOLTZ_TEST_PIN, or run with --boot-only.')
    process.exit(2)
  }
  const device = driver.device()
  if (!device) {
    console.error(`no booted ${driver.name}. Start one and install the app first.`)
    process.exit(2)
  }
  console.log(`${driver.name} ${device}\n`)

  const launched = driver.restart(device)

  if (BOOT_ONLY) {
    // Two halves, because either alone passes on a crash. A process can be alive and have no window,
    // and a tree can be full while the launcher is what is drawing it, which is what a crash on start
    // looks like from here.
    //
    // Only words this app owns count. A React Native crash box is drawn by the app process and sits
    // in front like any screen, so "some labels are on screen" passes while the app is dying.
    //
    // Either of the two first screens counts, since a device with a wallet asks for the PIN and a
    // fresh install offers to make one, in whatever language the device is set to. The words come
    // from the locale files, so a healthy app passes in every language it ships.
    const OWN_WORDS = firstScreenWords()
    let seen = []
    let front = false
    const drew = await until(() => {
      // Captured at the moment the condition holds, not read again afterwards. A second read lands
      // mid-transition often enough to report an empty screen for a check that just passed, and a
      // passing line that says nothing is the same shape as one that measured nothing.
      front = driver.inFront(device)
      seen = front ? labels(device) : []
      return seen.some(label => OWN_WORDS.indexOf(label) !== -1)
    }, 90)
    record('the app starts and draws a screen of its own', drew,
           drew ? seen.filter(l => OWN_WORDS.indexOf(l) !== -1).join(' / ')
                : front ? `on screen: ${seen.slice(0, 3).join(' / ') || '(an empty tree)'}`
                : 'the app is not in front')
    // On CI the emulator is gone by the time anyone looks, and a crash on start is only in logcat on
    // the device, so it is printed now or never.
    if (!drew && driver === android) {
      // A launch that never happened and a start that died without a crash log both leave the error
      // log clean, and only these three tell them apart.
      console.log(`\n--- launch ---\n${launched.trim() || '(no output)'}`)
      console.log(`resumed: ${android.resumed(device) || '(none)'}`)
      console.log(`process: ${sh('adb', ['-s', device, 'shell', 'pidof', BUNDLE]).trim() || '(not running)'}`)
      console.log('\n--- logcat (errors, last 60 lines) ---')
      console.log(sh('adb', ['-s', device, 'logcat', '-d', '-t', '60', '*:E']))
    }
    const boot = checks.filter(c => !c.ok)
    console.log(`\n${checks.length - boot.length}/${checks.length} passed`)
    process.exit(boot.length ? 1 : 0)
  }

  record('the app starts and asks for the PIN', await until(() => labels(device).some(l => /PIN|senha/i.test(l))))

  // Each tap re-reads the tree, so the keypad has to be there when the tap resolves, not when the
  // loop started. Waiting for the digit to be present is what makes this work on a cold simulator,
  // where the first render lands after the screen has already been reported.
  for (const digit of PIN) {
    await until(() => labels(device).includes(digit), 15)
    tap(device, l => l === digit)
    await wait(600)
  }

  // The wallet connects to the SDK before it can answer, which is slower than the screen appearing,
  // and on a cold simulator or a busy machine it takes more than a minute.
  const home = await until(() => labels(device).some(l => /sats/.test(l)), 120)
  // On failure the detail is what was on screen instead. A check that only says it failed sends
  // somebody to reproduce it by hand, which is the cost this file exists to remove.
  const balance = home
    ? labels(device).find(l => /sats/.test(l)) || ''
    : `on screen: ${labels(device).slice(0, 4).join(' / ') || '(nothing)'}`
  record('it unlocks and shows a balance', home, balance)

  // The address, read from the screen and then resolved from outside. Either half alone lies: the
  // screen shows a cached copy that survives the address being gone, and resolving a name nobody
  // typed proves nothing about what this wallet holds.
  tap(device, l => /^Receber$|^Receive$/.test(l))
  await wait(9000)
  tap(device, l => /^Lightning$/.test(l))
  await wait(9000)
  const source = driver.address(device)
  let address = ''
  if (source.copyFirst) {
    tap(device, l => /^Copiar$|^Copy$/.test(l))
    await wait(2500)
    address = source.read()
  } else {
    await until(() => labels(device).some(l => l.indexOf('@') !== -1), 20)
    address = (labels(device).find(l => l.indexOf('@') !== -1) || '').trim()
  }

  const looksLikeAddress = /^[a-z0-9][a-z0-9._-]*@[a-z0-9.-]+\.[a-z]{2,}$/i.test(address)
  record('the wallet holds a lightning address', looksLikeAddress, address || '(none)')

  if (looksLikeAddress) {
    const [name, host] = address.split('@')
    const status = sh('curl', ['-s', '-m', '15', '-o', '/dev/null', '-w', '%{http_code}',
                               `https://${host}/.well-known/lnurlp/${name}`]).trim()
    record('and it answers from outside', status === '200', `${address} -> ${status}`)

    // A generated name where a chosen one belongs is the shape of the address being replaced. It is
    // not proof on its own, since a fresh wallet legitimately holds one, so it warns rather than
    // fails: what it costs to miss is a customer's address, and what it costs to warn is a line.
    if (/^[a-z]+[a-z]+\d{2}$/.test(name)) {
      console.log(`  note  ${name} looks generated. If a name was chosen on this wallet, it was replaced.`)
    }
  }

  const failed = checks.filter(c => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  process.exit(2)
})
