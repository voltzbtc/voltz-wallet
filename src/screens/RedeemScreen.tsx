import React from 'react'
import { RedeemSpark } from './RedeemSpark'

// Spark is the only engine, so this forwards straight to RedeemSpark with nothing to dispatch on.
export function RedeemScreen(): React.JSX.Element {
  return <RedeemSpark />
}
