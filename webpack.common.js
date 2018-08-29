const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const CleanWebpackPlugin = require('clean-webpack-plugin');
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

// The path to the cesium source code
const cesiumSource = 'node_modules/cesium/Source';

module.exports = {
  context: __dirname,
  entry: {
    app: './src/index.js'
  },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'dist'),
    // Needed by Cesium for multiline strings
    sourcePrefix: ''
  },
  amd: {
    // Enable webpack-friendly use of require in cesium
    toUrlUndefined: true
  },
  node: {
    // Avoid including node libraries
    fs: "empty",
    Buffer: false,
    http: "empty",
    https: "empty",
    zlib: "empty"
  },
  resolve: {
    alias: {
      // Cesium module name
      cesium: path.resolve(__dirname, cesiumSource)
    }
  },
  module: {
    rules: [{
      test: /\.css$/,
      use: [
        MiniCssExtractPlugin.loader,
        'css-loader',
        'postcss-loader',
      ]
    }, {
      test: /\.(png|gif|jpg|jpeg|svg|xml|json)$/,
      use: ['url-loader']
    }]
  },
  optimization: {
    splitChunks: {
      cacheGroups: {
        commons: {
          test: /[\\/]node_modules[\\/]cesium/,
          name: 'cesium',
          chunks: 'all'
        }
      }
    }
  },
  plugins: [
    new CleanWebpackPlugin(['dist']),
    new HtmlWebpackPlugin({
      template: "src/index.html"
    }),
    new MiniCssExtractPlugin({
      filename: "main.css"
    }),
    new CopyWebpackPlugin([
      // Copy Cesium Assets, Widgets, and Workers to a static directory
      {from: path.join(cesiumSource, 'Assets'), to: 'Assets'},
      {from: path.join(cesiumSource, 'ThirdParty'), to: 'ThirdParty'},
      {from: path.join(cesiumSource, 'Widgets'), to: 'Widgets'},
      {from: path.join(cesiumSource, 'Workers'), to: 'Workers'},
      {from: path.join(cesiumSource, '../Build/Cesium/ThirdParty/Workers'), to: 'ThirdParty/Workers', force: true},
      {from: path.join(cesiumSource, '../Build/Cesium/Workers'), to: 'Workers', force: true}
    ]),
    new webpack.DefinePlugin({
      // Define relative base path in cesium for loading assets
      CESIUM_BASE_URL: JSON.stringify('')
    })
  ]
};
