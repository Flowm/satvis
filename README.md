# SatVis

Satellite orbit visualization with [CesiumJS](https://cesiumjs.org).

![Screenshot](https://user-images.githubusercontent.com/1117666/47623704-f0c3e900-db14-11e8-9cf9-7bf13acb267c.png)

## Features
- Calculate posistion and orbit of satellites from TLE
- Set groundstation through geolocation or pick on map
- Calculate passes for groundstation
- Local browser notifications for passes
- Serverless architecture
- Works offline as Progressive Web App

## Built With
- [CesiumJS](https://cesiumjs.org)
- [Satellite.js](https://github.com/shashwatak/satellite-js)
- [Vue.js](https://vuejs.org)
- [Workbox](https://developers.google.com/web/tools/workbox)

## Development

### Setup
Initialize submodules and install npm build dependencies:
```
git submodule update --init
npm install
```

### Run
- `npm run start-dev` for the dev server
- `npm run build` to build the application (output in `dist` folder)
- `npm run serve-prod` to build the application and serve with static webserver

## License
This project is licensed under the MIT License - see `LICENSE` file for details.
