const merge = require("webpack-merge");
const common = require("./webpack.prod.js");
const BundleAnalyzerPlugin = require("webpack-bundle-analyzer").BundleAnalyzerPlugin;

module.exports = merge(common, {
  plugins: [
    new BundleAnalyzerPlugin()
  ]
});
