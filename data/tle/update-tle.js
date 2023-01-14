#!/usr/bin/env node

const https = require("https");
const fs = require("fs");
const process = require("process");

// Change dir to the location of this script
process.chdir(__dirname);

function downloadTLE(groupName) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${groupName}&FORMAT=tle`;
  const path = "groups/";
  const filename = `${groupName}.txt`;

  https.get(url, (res) => {
    const writeStream = fs.createWriteStream(path + filename);
    res.pipe(writeStream);
    writeStream.on("finish", () => {
      writeStream.close();
      console.log(`Downloaded ${filename}`);
    });
  });
}

// https://celestrak.org/NORAD/elements/
// [...document.links].filter((link) => link.href.match(/gp.php\?GROUP=/)).map((link => link.href.match(/GROUP=(?<name>.*)&FORMAT/).groups.name));
const groups = [
  "last-30-days",
  "stations",
  // "visual",
  "active",
  // "analyst",
  // "1982-092",
  // "1999-025",
  // "iridium-33-debris",
  // "cosmos-2251-debris",
  "weather",
  // "noaa",
  // "goes",
  "resource",
  // "sarsat",
  // "dmc",
  // "tdrss",
  // "argos",
  "planet",
  "spire",
  // "geo",
  // "intelsat",
  // "ses",
  // "iridium",
  // "iridium-NEXT",
  "starlink",
  "oneweb",
  // "orbcomm",
  "globalstar",
  // "swarm",
  // "amateur",
  // "x-comm",
  // "other-comm",
  // "satnogs",
  // "gorizont",
  // "raduga",
  // "molniya",
  // "gnss",
  // "gps-ops",
  // "glo-ops",
  // "galileo",
  // "beidou",
  // "sbas",
  // "nnss",
  // "musson",
  "science",
  // "geodetic",
  // "engineering",
  // "education",
  // "military",
  // "radar",
  "cubesat",
  // "other",
];

groups.forEach((group) => {
  downloadTLE(group);
});
