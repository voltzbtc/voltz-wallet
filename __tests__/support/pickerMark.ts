import { Text } from 'react-native'
import type ReactTestRenderer from 'react-test-renderer'
import { AssetPickerSheet, type PickerItem } from '../../src/components/AssetPickerSheet'
import { Touch } from '../../src/components/Touch'
import { TabIcon } from '../../src/components/TabIcon'

type Instance = ReactTestRenderer.ReactTestInstance

// The ids of the rows the open picker draws as chosen, read from what is rendered: a row counts only
// when it carries both the check and the selected state, so a mark without the state, or the reverse,
// reads as unmarked. A row is matched to its item by the ticker and name it shows, since two routes
// can share a ticker and differ by network.
export function markedInOpenPicker(root: Instance): string[] {
  const sheet = root.findAllByType(AssetPickerSheet).find(node => node.props.visible)
  if (!sheet) {
    throw new Error('no picker sheet is open')
  }
  const items = sheet.props.items as PickerItem[]
  return sheet
    .findAllByType(Touch)
    .filter(
      row =>
        row.props.state?.selected === true &&
        row.findAllByType(TabIcon).some(icon => icon.props.name === 'check'),
    )
    .map(row => {
      const shown = row.findAllByType(Text).map(node => node.props.children)
      const item = items.find(
        candidate => shown.includes(candidate.ticker) && (candidate.name === '' || shown.includes(candidate.name)),
      )
      if (!item) {
        throw new Error(`a marked row matches no item: ${JSON.stringify(shown)}`)
      }
      return item.assetId
    })
}
