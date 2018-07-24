const path = require("path")
const HtmlPlugin = require("html-webpack-plugin")
const webpack = require("webpack")

const entryFile = path.resolve(__dirname, "../src/app.js")
const outputFolder = path.resolve(__dirname, "../public")

module.exports = {
  entry: entryFile,
  output: {
    path: outputFolder,
    filename: "bundle.js",
    sourcePrefix: ""
  },
  plugins: [
    new HtmlPlugin({
      template: "./src/index.html",
      inject: "body"
    }),
    //this allow to dynamically load the unminified version of cesium
    // you can set it to prod or comment this plugin to load Cesium minified version
    new webpack.DefinePlugin({
      "process.env": {
        NODE_ENV: JSON.stringify("dev")
      }
    })
  ],
  devServer: {
    contentBase: outputFolder
  },
  module: {
    unknownContextCritical: false,
    rules: [
      { test: /\.css$/, loader: "style-loader!css-loader" },
      {
        test: /\.(png|gif|jpg|jpeg)$/,
        loader: "file-loader"
      },
      { test: /Cesium\.js$/, loader: "script-loader" }
    ]
  }
}
