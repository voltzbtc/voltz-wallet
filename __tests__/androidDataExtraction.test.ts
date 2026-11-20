import { readFileSync } from 'fs'
import { join } from 'path'

// From Android 12, allowBackup="false" stops cloud backup but not every maker's device-to-device
// transfer, which can carry files/ and the Keychain's ciphertexts to a new phone without the Keystore
// keys that open them. The data extraction rules exclude every domain from both.

const ROOT = join(__dirname, '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
const DOMAINS = [
  'root',
  'file',
  'database',
  'sharedpref',
  'external',
  'device_root',
  'device_file',
  'device_database',
  'device_sharedpref',
]

test('the manifest keeps backup off and names the rules', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml')
  expect(manifest).toContain('android:allowBackup="false"')
  expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"')
})

test.each(['cloud-backup', 'device-transfer'])('%s excludes every domain and includes nothing', section => {
  const rules = read('android/app/src/main/res/xml/data_extraction_rules.xml').replace(/<!--[\s\S]*?-->/g, '')
  const body = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`).exec(rules)?.[1]
  expect(body).toBeDefined()
  const excluded = [...body!.matchAll(/<exclude domain="([a-z_]+)" path="\." \/>/g)].map(m => m[1])
  expect(excluded.sort()).toEqual([...DOMAINS].sort())
  expect(body).not.toMatch(/<include/)
})
