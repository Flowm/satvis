const path = require("path");
const { merge } = require("webpack-merge");

const basePath = `${__dirname}/..`;
const common = require("./webpack.config.js");

const cesiumSource = "node_modules/cesium/Source";

module.exports = merge(common, {
  output: {
    filename: "js/[name].[chunkhash].js",
    sourceMapFilename: "js/[name].[chunkhash][ext].map",
    chunkFilename: "js/[name].[chunkhash].js",
    assetModuleFilename: "assets/[name].[contenthash][ext]",
    hashDigestLength: 8,
  },
  devtool: "source-map",
  mode: "production",
  target: "browserslist",
  module: {
    rules: [
      {
        test: /\.js$/,
        enforce: "pre",
        include: path.resolve(basePath, cesiumSource),
        sideEffects: false,
        use: [{
          loader: "webpack-strip-pragma-loader",
          options: {
            pragmas: {
              debug: false,
            },
          },
        }],
      },
    ],
  },
});
