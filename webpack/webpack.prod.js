const path = require("path");
const webpack = require("webpack");
const merge = require("webpack-merge");
const common = require("./webpack.config.js");

const basePath = `${__dirname}/..`;
const cesiumSource = "node_modules/cesium/Source";

module.exports = merge(common, {
  output: {
    filename: "js/[name].[chunkhash:8].js",
    sourceMapFilename: "js/[name].[chunkhash:8].map",
    chunkFilename: "js/[name].[chunkhash:8].js",
  },
  devtool: "source-map",
  mode: "production",
  module: {
    rules: [{
      test: /\.js$/,
      enforce: "pre",
      include: path.resolve(basePath, cesiumSource),
      use: [{
        loader: "strip-pragma-loader",
        options: {
          pragmas: {
            debug: false
          }
        }
      }]
    }]
  },
  plugins: [
    new webpack.DefinePlugin({
      "process.env.NODE_ENV": JSON.stringify("production")
    })
  ]
});
