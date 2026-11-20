import React from 'react'
import { ConvertSpark } from './ConvertSpark'

// Spark is the only engine, so this forwards straight to ConvertSpark with nothing to dispatch on.
export function ConvertScreen(): React.JSX.Element {
  return <ConvertSpark />
}
