const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const SizePlugin = require("size-plugin");
const { CleanWebpackPlugin } = require("clean-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const VueLoaderPlugin = require("vue-loader/lib/plugin");
const WorkboxPlugin = require("workbox-webpack-plugin");

const basePath = `${__dirname}/..`;
const cesiumSource = "node_modules/cesium/Source";

module.exports = {
  context: basePath,
  entry: {
    app: "./src/app.js",
    move: "./src/move.js",
    ot: "./src/ot.js",
    test: "./src/test/test.js",
  },
  output: {
    filename: "js/[name].js",
    sourceMapFilename: "js/[name][ext].map",
    chunkFilename: "js/[name].js",
    path: path.resolve(basePath, "dist"),
    // Needed by Cesium for multiline strings
    sourcePrefix: "",
  },
  amd: {
    // Enable webpack-friendly use of require in Cesium
    toUrlUndefined: true,
  },
  devServer: {
    compress: true,
    contentBase: path.resolve(basePath, "dist"),
    hot: true,
    port: 8080,
    stats: {
      assets: false,
      modules: false,
      entrypoints: false,
    },
    historyApiFallback: {
      index: "index.html",
    },
  },
  devtool: "eval-source-map",
  mode: "development",
  target: "web",
  module: {
    rules: [
      {
        test: /\.js$/,
        use: {
          loader: "babel-loader",
          options: {
            presets: ["@babel/preset-env"],
          },
        },
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
        use: ["url-loader"],
      },
    ],
    unknownContextCritical: false,
  },
  resolve: {
    modules: [
      path.resolve(__dirname, "./src"),
      "node_modules",
    ],
    alias: {
      // Cesium module name
      cesium: path.resolve(basePath, cesiumSource),
    },
  },
  externals: {
    // CesiumSensorVolumes: "CesiumSensorVolumes",
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
          test: /[\\/]node_modules[\\/]cesium/,
          chunks: "all",
        },
      },
    },
  },
  plugins: [
    new CleanWebpackPlugin(),
    new HtmlWebpackPlugin({
      filename: "index.html",
      template: "src/index.html",
      chunks: ["app"],
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
        { from: path.join(cesiumSource, "../Build/Cesium/Assets"), to: "cesium/Assets", globOptions: { ignore: ["**/maki/*.png"] }},
        // Copy Cesium non-JS widget-bits (CSS, SVG, etc.)
        { from: path.join(cesiumSource, "../Build/Cesium/Widgets"), to: "cesium/Widgets" },
        // Copy Cesium Almond-bundled-and-minified Web Worker scripts
        { from: path.join(cesiumSource, "../Build/Cesium/Workers"), to: "cesium/Workers" },
        // Copy Cesium minified third-party scripts
        { from: path.join(cesiumSource, "../Build/Cesium/ThirdParty"), to: "cesium/ThirdParty" },
        // Copy prebuilt CesiumSensorVolumes
        // {from: "node_modules/cesium-sensor-volumes/dist/cesium-sensor-volumes.min.js", to: "cesium/"},
        {from: "data", to: "data", globOptions: { ignore: ["**/.git/**"] }},
        {from: "src/assets"},
      ],
    }),
    new webpack.DefinePlugin({
      // Define relative base path in cesium for loading assets
      CESIUM_BASE_URL: JSON.stringify("cesium/"),
    }),
    new SizePlugin({
      exclude: "cesium/**/*",
    }),
    new WorkboxPlugin.InjectManifest({
      swSrc: "./src/sw.js",
      swDest: "sw.js",
      include: [
        /\.css$/,
        /\.css$/,
        /\.html$/,
        /\.js$/,
        /\.png$/,
        /data\/tle\/.*\.txt$/,
        /dist\/Assets\/.*\.jpg$/,
        /dist\/Assets\/.*\.png$/,
        /dist\/Assets\/.*\.xml$/,
        /dist\/Assets\/approximateTerrainHeights.json$/,
      ],
      exclude: [
        /dist\/ThirdParty\//,
        /dist\/Workers\//,
        /dist\/Widgets\//,
      ],
    }),
  ],
};
