#!/usr/bin/env bash
set -eu

cd "${0%/*}"
mkdir -p norad && cd norad

# https://celestrak.com/NORAD/elements/
# [...document.links].forEach(link => {if (link.href.match(/txt$/)) {console.log(link.href)}});

curl -O https://celestrak.com/NORAD/elements/tle-new.txt
curl -O https://celestrak.com/NORAD/elements/stations.txt
curl -O https://celestrak.com/NORAD/elements/visual.txt
curl -O https://celestrak.com/NORAD/elements/active.txt
curl -O https://celestrak.com/NORAD/elements/analyst.txt
curl -O https://celestrak.com/NORAD/elements/2019-006.txt
curl -O https://celestrak.com/NORAD/elements/1999-025.txt
curl -O https://celestrak.com/NORAD/elements/iridium-33-debris.txt
curl -O https://celestrak.com/NORAD/elements/cosmos-2251-debris.txt
curl -O https://celestrak.com/NORAD/elements/2012-044.txt
curl -O https://celestrak.com/NORAD/elements/weather.txt
curl -O https://celestrak.com/NORAD/elements/noaa.txt
curl -O https://celestrak.com/NORAD/elements/goes.txt
curl -O https://celestrak.com/NORAD/elements/resource.txt
curl -O https://celestrak.com/NORAD/elements/sarsat.txt
curl -O https://celestrak.com/NORAD/elements/dmc.txt
curl -O https://celestrak.com/NORAD/elements/tdrss.txt
curl -O https://celestrak.com/NORAD/elements/argos.txt
curl -O https://celestrak.com/NORAD/elements/planet.txt
curl -O https://celestrak.com/NORAD/elements/spire.txt
curl -O https://celestrak.com/NORAD/elements/geo.txt
curl -O https://celestrak.com/NORAD/elements/intelsat.txt
curl -O https://celestrak.com/NORAD/elements/ses.txt
curl -O https://celestrak.com/NORAD/elements/iridium.txt
curl -O https://celestrak.com/NORAD/elements/iridium-NEXT.txt
curl -O https://celestrak.com/NORAD/elements/starlink.txt
curl -O https://celestrak.com/NORAD/elements/orbcomm.txt
curl -O https://celestrak.com/NORAD/elements/globalstar.txt
curl -O https://celestrak.com/NORAD/elements/amateur.txt
curl -O https://celestrak.com/NORAD/elements/x-comm.txt
curl -O https://celestrak.com/NORAD/elements/other-comm.txt
curl -O https://celestrak.com/NORAD/elements/satnogs.txt
curl -O https://celestrak.com/NORAD/elements/gorizont.txt
curl -O https://celestrak.com/NORAD/elements/raduga.txt
curl -O https://celestrak.com/NORAD/elements/molniya.txt
curl -O https://celestrak.com/NORAD/elements/gps-ops.txt
curl -O https://celestrak.com/NORAD/elements/glo-ops.txt
curl -O https://celestrak.com/NORAD/elements/galileo.txt
curl -O https://celestrak.com/NORAD/elements/beidou.txt
curl -O https://celestrak.com/NORAD/elements/sbas.txt
curl -O https://celestrak.com/NORAD/elements/nnss.txt
curl -O https://celestrak.com/NORAD/elements/musson.txt
curl -O https://celestrak.com/NORAD/elements/science.txt
curl -O https://celestrak.com/NORAD/elements/geodetic.txt
curl -O https://celestrak.com/NORAD/elements/engineering.txt
curl -O https://celestrak.com/NORAD/elements/education.txt
curl -O https://celestrak.com/NORAD/elements/military.txt
curl -O https://celestrak.com/NORAD/elements/radar.txt
curl -O https://celestrak.com/NORAD/elements/cubesat.txt
curl -O https://celestrak.com/NORAD/elements/other.txt

mkdir -p ../ext
egrep -A2 '(FIRST-MOVE|MOVE-II)' --no-group-separator active.txt > ../ext/move.txt
egrep -A2 '^(SENTINEL-2A|SENTINEL-2B|SENTINEL-3A|SENTINEL-3B|AQUA|TERRA |SUOMI NPP|NOAA 20|METEOSAT-8|METEOSAT-10|METEOSAT-11|GOES 16|GOES 17|HIMAWARI-8|METOP-A|METOP-B|METOP-C|LANDSAT 8|FENGYUN 3D)' --no-group-separator active.txt > ../ext/wfs.txt
egrep -A2 '^(SENTINEL-2A|SENTINEL-2B|SENTINEL-3A|SENTINEL-3B|AQUA|TERRA |SUOMI NPP|NOAA 20|METEOSAT-8|METEOSAT-10|METEOSAT-11|GOES 16|GOES 17|HIMAWARI-8|METOP-A|METOP-B|METOP-C|LANDSAT 8|FENGYUN 3D|LANDSAT 9|NOAA 15|NOAA 18|NOAA 19|METEOR-M 1|METEOR-M 2|METEOR-M2 2|KANOPUS-V-IK)' --no-group-separator active.txt > ../ext/wfsf.txt
cat ../ext/wfsfa.txt >> ../ext/wfsf.txt
