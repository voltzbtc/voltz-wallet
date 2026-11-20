import React from 'react'
import { SendSpark } from './SendSpark'

// Spark is the only engine, so this forwards straight to SendSpark with nothing to dispatch on.
export function SendScreen(): React.JSX.Element {
  return <SendSpark />
}
