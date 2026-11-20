import React from 'react'
import { useRoute, type RouteProp } from '@react-navigation/native'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { HistoryScreen } from './HistoryScreen'

// Every movement of one asset, as the History tab draws them.
export function AssetHistoryScreen(): React.JSX.Element {
  const { assetId } = useRoute<RouteProp<RootStackParamList, 'AssetHistory'>>().params
  return <HistoryScreen assetId={assetId} />
}
