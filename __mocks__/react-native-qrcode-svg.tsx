import React from 'react'

// Pure ESM package, and Jest does not transform node_modules. Props are preserved so tests can
// assert the encoded value without the real SVG.
export default function QRCode(props: { value: string; size?: number }): React.JSX.Element {
  return React.createElement('QRCode', props)
}
