const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const CleanWebpackPlugin = require('clean-webpack-plugin');
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const VueLoaderPlugin = require('vue-loader/lib/plugin');
const WorkboxPlugin = require('workbox-webpack-plugin');

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
      cesium: path.resolve(__dirname, cesiumSource),
      'vue$': 'vue/dist/vue.esm.js',
    }
  },
  externals: {
    Cesium: 'Cesium',
    CesiumSensorVolumes: 'CesiumSensorVolumes',
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
      test: /\.vue$/,
      loader: 'vue-loader'
    }, {
      test: /\.(png|gif|jpg|jpeg|svg|xml|json)$/,
      use: ['url-loader']
    }]
  },
  //optimization: {
  //  splitChunks: {
  //    cacheGroups: {
  //      commons: {
  //        test: /[\\/]node_modules[\\/]cesium/,
  //        name: 'cesium',
  //        chunks: 'all'
  //      }
  //    }
  //  }
  //},
  plugins: [
    new CleanWebpackPlugin(['dist']),
    new HtmlWebpackPlugin({
      template: "src/index.html"
    }),
    new MiniCssExtractPlugin({
      filename: "main.css"
    }),
    new VueLoaderPlugin(),
    new CopyWebpackPlugin([
      // Copy Cesium Assets, Widgets, and Workers to a static directory
      {from: path.join(cesiumSource, 'Assets'), to: 'dist/Assets', ignore: ["**/maki/*.png"]},
      {from: path.join(cesiumSource, 'ThirdParty'), to: 'dist/ThirdParty'},
      {from: path.join(cesiumSource, 'Widgets'), to: 'dist/Widgets'},
      {from: path.join(cesiumSource, 'Workers'), to: 'dist/Workers'},
      {from: path.join(cesiumSource, '../Build/Cesium/ThirdParty/Workers'), to: 'dist/ThirdParty/Workers', force: true},
      {from: path.join(cesiumSource, '../Build/Cesium/Workers'), to: 'dist/Workers', force: true},
      {from: path.join(cesiumSource, '../Build/Cesium/Cesium.js'), to: 'dist/'},
      {from: 'node_modules/cesium-sensor-volumes/dist/cesium-sensor-volumes.js', to: 'dist/'},
      {from: 'data', to: 'data', ignore: ["**/.git/**"]},
      {from: 'src/assets'},
    ]),
    new webpack.DefinePlugin({
      // Define relative base path in cesium for loading assets
      CESIUM_BASE_URL: JSON.stringify('dist/')
    }),
    new WorkboxPlugin.InjectManifest({
      importWorkboxFrom: 'local',
      swSrc: './src/sw.js',
      swDest: 'sw.js',
      include: [
        /\.html$/,
        /\.js$/,
        /\.css$/,
        /\.css$/,
        /dist\/Assets\/approximateTerrainHeights.json$/,
        /dist\/Assets\/.*\.png$/,
        /dist\/Assets\/.*\.jpg$/,
        /dist\/Assets\/.*\.xml$/,
        /data\/tle\/.*\.txt$/,
      ],
      exclude: [
        /dist\/ThirdParty\//,
        /dist\/Workers\//,
        /dist\/Widgets\//,
      ],
    }),
    //new webpack.ProvidePlugin({
    //  'Cesium': 'cesium/Cesium'
    //})
  ]
};
