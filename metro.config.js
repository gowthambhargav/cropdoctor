// metro.config.js (in project root)
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

// ✅ Tell Metro to treat .tflite as an asset
config.resolver.assetExts.push('tflite')

module.exports = config
