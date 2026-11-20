// The CI supply-chain gate fails on any high/critical npm advisory except an explicit, documented
// allowlist. The allowlist is only for advisories in code that cannot reach the shipped app
// (build-time tooling, or a dependency's Node-only build that Metro never resolves) and that has no
// patched version reachable under the locked dep tree; anything that ships (runtime deps) still
// fails the build. Kept in-repo rather than using a third-party audit tool so the gate itself adds
// nothing to audit.
import { execFileSync } from 'node:child_process'

// GHSA ids ignored on purpose, each pinned to the package it was cleared for. Adding one is a
// deliberate decision: it must be absent from the release bundles AND have no compatible patch.
//
// The package name is half the key. An advisory id is not a property of a package: the same id can
// later be reported against a different dependency, and keyed by id alone, a clearance given to
// image-size would wave through that id reported against bip39, where the wallet's seed comes from,
// with the image-size reason printed beside it.
const ALLOW = {
  // image-size reaches us only through metro (the RN bundler, dev/CI only). metro pins image-size
  // ^1.x and the fix landed in 2.x, so there is no compatible patch until metro moves. Not shipped.
  'GHSA-w3rx-r6r6-pgpr': {
    package: 'image-size',
    why: 'image-size ICNS DoS via metro (build-only, no metro-compatible patch)',
  },
  'GHSA-5p2g-fcmc-qvqq': {
    package: 'image-size',
    why: 'image-size JXL/HEIF DoS via metro (build-only, no metro-compatible patch)',
  },
  // braces enters the tree only through micromatch, which metro-file-map (the bundler's file crawler),
  // jest and fast-glob run under Node. The advisory covers every release up to 3.0.3, the latest,
  // so no patched version exists to move to. Not shipped.
  'GHSA-vfj7-8cjw-p6xm': {
    package: 'braces',
    why: 'braces nested-pattern DoS via micromatch (build/test-only, no patched release)',
  },
  // @grpc/grpc-js is the transport of Firestore's Node build, pulled by @react-native-firebase/app
  // through the firebase JS SDK. Metro resolves Firestore's react-native build, which has no grpc,
  // and the app never imports Firestore. Firestore pins ~1.9.0 up to 4.18.0 while the fix is in
  // 1.13.6, so there is no compatible patch. Not shipped.
  'GHSA-m9gg-hp2v-232j': {
    package: '@grpc/grpc-js',
    why: '@grpc/grpc-js auth context flaw via @firebase/firestore (Node build only, pinned ~1.9.0)',
  },
  // picomatch enters through micromatch, anymatch, fdir, tinyglobby and jest-util, all run under Node
  // by metro and jest over globs this repository writes; nothing in src imports a glob matcher. The
  // advisory covers every release up to 4.0.7, the latest, so no patched version exists to move to.
  // Dated, so the clearance is decided again if no fix has landed by then. Not shipped.
  'GHSA-fc5q-39xc-vjpf': {
    package: 'picomatch',
    until: '2026-12-01',
    why: 'picomatch extglob ReDoS via metro and jest tooling (build/test-only, no patched release)',
  },
}

// npm audit exits non-zero when advisories exist; the JSON still lands on stdout.
function auditJson() {
  try {
    return execFileSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    if (err.stdout) return err.stdout
    throw err
  }
}

const report = JSON.parse(auditJson())
const BLOCKING = new Set(['high', 'critical'])

// A `via` entry is a real advisory only when it carries a GHSA url; string entries are just the
// propagation of another package's advisory, not a distinct one to gate on.
const advisories = new Map()
for (const vuln of Object.values(report.vulnerabilities || {})) {
  for (const via of vuln.via || []) {
    if (typeof via !== 'object' || !via.url) continue
    const id = via.url.split('/').pop()
    // `name` is the package the advisory is reported against, and it is what turns the allowlist from
    // a list of ids into a list of decisions.
    advisories.set(id, { id, name: via.name, title: via.title, severity: via.severity, url: via.url })
  }
}

const blocking = []
const ignored = []
// An allowlisted id on a package it was never cleared for is worse than an unknown advisory, because
// it arrives wearing an approval. It blocks, and it names both packages so the reader sees the swap.
const moved = []
// A clearance given while a fix waits out the quarantine ends on its date, so the wait cannot turn
// into a standing exception.
const lapsed = []
for (const a of advisories.values()) {
  if (!BLOCKING.has(a.severity)) continue
  const entry = ALLOW[a.id]
  if (!entry) {
    blocking.push(a)
  } else if (entry.package !== a.name) {
    moved.push({ ...a, clearedFor: entry.package })
  } else if (entry.until && !(Date.now() < Date.parse(entry.until))) {
    lapsed.push({ ...a, until: entry.until })
  } else {
    ignored.push(a)
  }
}

// Print the allowlisted hits every run so the allowlist can't grow unnoticed.
if (ignored.length) {
  console.log(`Ignored ${ignored.length} allowlisted advisory(ies):`)
  for (const a of ignored) console.log(`  - ${a.id} (${a.severity}) ${a.title} (${ALLOW[a.id].why})`)
}

if (moved.length) {
  console.error(`\n${moved.length} allowlisted id(s) now reported against another package:`)
  for (const a of moved) {
    console.error(`  - ${a.id} (${a.severity}) cleared for ${a.clearedFor}, now against ${a.name}`)
    console.error(`    ${a.title}\n    ${a.url}`)
  }
  console.error('\nThe clearance does not travel with the id. Decide it again for this package.')
}

if (lapsed.length) {
  console.error(`\n${lapsed.length} allowlisted advisory(ies) past the date their clearance ran to:`)
  for (const a of lapsed) console.error(`  - ${a.id} (${a.severity}) ${a.name}, cleared until ${a.until}\n    ${a.url}`)
  console.error('\nMove the lock to the fix, then drop the entry.')
}

if (blocking.length) {
  console.error(`\n${blocking.length} high/critical advisory(ies) outside the allowlist:`)
  for (const a of blocking) console.error(`  - ${a.id} (${a.severity}) ${a.title}\n    ${a.url}`)
  console.error(
    '\nFix them, or (build-only tooling with no shipped impact and no compatible patch) allowlist with a reason.',
  )
}

if (blocking.length || moved.length || lapsed.length) {
  process.exit(1)
}

console.log('Supply-chain gate passed: no high/critical advisories outside the allowlist.')
