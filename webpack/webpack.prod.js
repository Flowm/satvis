const path = require('path');
const webpack = require('webpack');
const merge = require('webpack-merge');
const common = require('./webpack.common.js');

const basePath = `${__dirname}/..`;
const cesiumSource = 'node_modules/cesium/Source';

module.exports = merge(common, {
  mode: 'production',
  module: {
    rules: [{
      // Remove pragmas
      test: /\.js$/,
      enforce: 'pre',
      include: path.resolve(basePath, cesiumSource),
      use: [{
        loader: 'strip-pragma-loader',
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
      'process.env.NODE_ENV': JSON.stringify('production')
    })
  ]
});
