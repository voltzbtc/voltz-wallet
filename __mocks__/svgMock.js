// .svg imports go through react-native-svg-transformer, which runs only in Metro. A host node is
// enough for the tree to mount.
const React = require('react')

function SvgMock(props) {
  return React.createElement('SvgMock', props, props.children)
}

module.exports = SvgMock
module.exports.default = SvgMock
