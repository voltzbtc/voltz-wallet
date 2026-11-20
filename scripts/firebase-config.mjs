#!/usr/bin/env node
// Puts a placeholder in place of each Firebase client configuration file that is missing, so a
// checkout without a Firebase project of its own still builds. Both files stay out of git because
// they name one Firebase project. Gradle fails without android/app/google-services.json, since the
// google-services plugin reads it on every build, and Xcode fails without
// ios/VoltzWallet/GoogleService-Info.plist, since the project copies it into the app bundle.
//
// A file that exists is never replaced, whether it is a real configuration or a placeholder copied
// by an earlier run. The copy uses COPYFILE_EXCL, so the check and the write are one step. See
// docs/firebase.md.
import { constants, copyFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const FILES = [
  {
    example: 'android/app/google-services.example.json',
    target: 'android/app/google-services.json',
  },
  {
    example: 'ios/VoltzWallet/GoogleService-Info.example.plist',
    target: 'ios/VoltzWallet/GoogleService-Info.plist',
  },
]

const PUSH_OFF =
  'Push notifications stay off until a real file from a Firebase project replaces it.'

for (const { example, target } of FILES) {
  try {
    copyFileSync(ROOT + example, ROOT + target, constants.COPYFILE_EXCL)
    console.log(`${target} was missing and now holds the placeholder. ${PUSH_OFF}`)
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err
    }
    const placeholder = readFileSync(ROOT + target).equals(readFileSync(ROOT + example))
    console.log(
      placeholder
        ? `${target} is the placeholder. ${PUSH_OFF}`
        : `${target} exists and is left as it is.`,
    )
  }
}
