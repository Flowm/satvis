const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const { VueLoaderPlugin } = require("vue-loader");
const WorkboxPlugin = require("workbox-webpack-plugin");

const basePath = `${__dirname}/..`;
const cesiumEngineSource = "node_modules/@cesium/engine/Source";
const cesiumWidgetsSource = "node_modules/@cesium/widgets/Source";

module.exports = {
  context: basePath,
  entry: {
    index: "./src/index.js",
    move: "./src/move.js",
    ot: "./src/ot.js",
    test: "./src/test/test.js",
  },
  output: {
    clean: true,
    filename: "js/[name].js",
    sourceMapFilename: "js/[name][ext].map",
    chunkFilename: "js/[name].js",
    assetModuleFilename: "assets/[name][ext]",
    path: path.resolve(basePath, "dist"),
  },
  devServer: {
    client: {
      overlay: {
        errors: true,
        warnings: false,
      },
    },
    compress: true,
    devMiddleware: {
      stats: {
        assets: false,
        modules: false,
        entrypoints: false,
      },
    },
    hot: true,
    port: 8080,
    static: {
      directory: path.resolve(basePath, "dist"),
    },
    historyApiFallback: true,
  },
  devtool: "eval-source-map",
  mode: "development",
  target: "web",
  module: {
    rules: [
      {
        test: /\.(ts|js)x?$/,
        loader: "babel-loader",
        exclude: /node_modules/,
      }, {
        test: /\.vue$/,
        loader: "vue-loader",
      }, {
        test: /\.css$/,
        use: [
          MiniCssExtractPlugin.loader,
          "css-loader",
          "postcss-loader",
        ],
      }, {
        test: /\.(png|gif|jpg|jpeg|svg|xml|json)$/,
        type: "asset",
      }, {
        test: /\.ecss$/,
        loader: "css-loader",
        options: {
          esModule: false,
        }
      },
    ],
    unknownContextCritical: false,
  },
  resolve: {
    alias: {
      // Cesium module name
      Cesium: path.resolve(basePath, cesiumEngineSource),
    },
    extensions: [".ts", ".tsx", ".js", ".json"],
    fallback: { https: false, zlib: false, http: false, url: false },
  },
  optimization: {
    splitChunks: {
      chunks: "all",
      cacheGroups: {
        vendors: {
          name: "vendors",
          test: /[\\/]node_modules[\\/]/,
          priority: -10,
          chunks: "initial",
        },
        commons: {
          name: "cesium",
          test: /[\\/]node_modules[\\/]@cesium/,
          chunks: "all",
        },
      },
    },
  },
  plugins: [
    new HtmlWebpackPlugin({
      filename: "index.html",
      template: "src/index.html",
      chunks: ["index"],
    }),
    new HtmlWebpackPlugin({
      filename: "move.html",
      template: "src/index.html",
      chunks: ["move"],
    }),
    new HtmlWebpackPlugin({
      filename: "ot.html",
      template: "src/index.html",
      chunks: ["ot"],
    }),
    new HtmlWebpackPlugin({
      filename: "embedded.html",
      template: "src/embedded.html",
      chunks: [],
    }),
    new HtmlWebpackPlugin({
      filename: "test.html",
      chunks: ["test"],
    }),
    new MiniCssExtractPlugin({
      filename: "js/[name].[chunkhash].css",
      chunkFilename: "js/[name].[chunkhash].css",
    }),
    new VueLoaderPlugin(),
    new CopyWebpackPlugin({
      patterns: [
        // Copy Cesium Assets
        { from: path.join(cesiumEngineSource, "Assets"), to: "cesium/Assets", globOptions: { ignore: ["**/maki/*.png"] } },
        // Copy Cesium minified third-party scripts
        { from: path.join(cesiumEngineSource, "ThirdParty"), to: "cesium/ThirdParty" },
        // Copy Cesium Almond-bundled-and-minified Web Worker scripts
        { from: path.join(cesiumEngineSource, "../Build/Workers"), to: "cesium/Workers" },
        // Copy Cesium Widget
        { from: path.join(cesiumEngineSource, "Widget"), to: "cesium/Widgets/CesiumWidget" },
        // Copy all other Cesium Widgets
        { from: cesiumWidgetsSource, to: "cesium/Widgets" },
        // Copy assets
        { from: "data", to: "data", globOptions: { ignore: ["**/.git/**", "**/custom/**"] } },
        { from: "data/custom/dist", to: "data" },
        { from: "src/assets" },
      ],
    }),
    new webpack.DefinePlugin({
      // Define relative base path in cesium for loading assets
      CESIUM_BASE_URL: JSON.stringify("cesium/"),
      __VUE_OPTIONS_API__: true,
      __VUE_PROD_DEVTOOLS__: false,
    }),
    new WorkboxPlugin.InjectManifest({
      swSrc: "./src/sw.js",
      swDest: "sw.js",
      maximumFileSizeToCacheInBytes: 5000000,
      include: [
        /\.css$/,
        /\.html$/,
        /\.js$/,
        /\.png$/,
        /cesium\/Assets\/.*\.jpg$/,
        /cesium\/Assets\/.*\.png$/,
        /cesium\/Assets\/.*\.xml$/,
        /cesium\/Assets\/approximateTerrainHeights\.json$/,
        /data\/tle\/.*\.txt$/,
        /site\.webmanifest$/,
      ],
      exclude: [
        /cesium\/ThirdParty\//,
        /cesium\/Widgets\//,
        /cesium\/Workers\//,
      ],
    }),
  ],
};
