module.exports = (on, config) => {
  on("before:browser:launch", (browser = {}, args) => {
    if (browser.name === "chrome") {
      args.push("--disable-web-security");

      console.log(browser, args);
      return args
    }
  })
}
