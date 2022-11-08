#!/usr/bin/env bash
set -u

cd "${0%/*}"
mkdir -p norad && cd norad

# https://celestrak.org/NORAD/elements/
# [...document.links].forEach(link => {if (link.href.match(/txt$/)) {console.log(link.href)}});

curl -O https://celestrak.org/NORAD/elements/tle-new.txt
curl -O https://celestrak.org/NORAD/elements/stations.txt
curl -O https://celestrak.org/NORAD/elements/visual.txt
curl -O https://celestrak.org/NORAD/elements/active.txt
curl -O https://celestrak.org/NORAD/elements/analyst.txt
curl -O https://celestrak.org/NORAD/elements/1982-092.txt
curl -O https://celestrak.org/NORAD/elements/2019-006.txt
curl -O https://celestrak.org/NORAD/elements/1999-025.txt
curl -O https://celestrak.org/NORAD/elements/iridium-33-debris.txt
curl -O https://celestrak.org/NORAD/elements/cosmos-2251-debris.txt
curl -O https://celestrak.org/NORAD/elements/weather.txt
curl -O https://celestrak.org/NORAD/elements/noaa.txt
curl -O https://celestrak.org/NORAD/elements/goes.txt
curl -O https://celestrak.org/NORAD/elements/resource.txt
curl -O https://celestrak.org/NORAD/elements/sarsat.txt
curl -O https://celestrak.org/NORAD/elements/dmc.txt
curl -O https://celestrak.org/NORAD/elements/tdrss.txt
curl -O https://celestrak.org/NORAD/elements/argos.txt
curl -O https://celestrak.org/NORAD/elements/planet.txt
curl -O https://celestrak.org/NORAD/elements/spire.txt
curl -O https://celestrak.org/NORAD/elements/geo.txt
curl -O https://celestrak.org/NORAD/elements/intelsat.txt
curl -O https://celestrak.org/NORAD/elements/ses.txt
curl -O https://celestrak.org/NORAD/elements/iridium.txt
curl -O https://celestrak.org/NORAD/elements/iridium-NEXT.txt
curl -O https://celestrak.org/NORAD/elements/starlink.txt
curl -O https://celestrak.org/NORAD/elements/oneweb.txt
curl -O https://celestrak.org/NORAD/elements/orbcomm.txt
curl -O https://celestrak.org/NORAD/elements/globalstar.txt
curl -O https://celestrak.org/NORAD/elements/swarm.txt
curl -O https://celestrak.org/NORAD/elements/amateur.txt
curl -O https://celestrak.org/NORAD/elements/x-comm.txt
curl -O https://celestrak.org/NORAD/elements/other-comm.txt
curl -O https://celestrak.org/NORAD/elements/satnogs.txt
curl -O https://celestrak.org/NORAD/elements/gorizont.txt
curl -O https://celestrak.org/NORAD/elements/raduga.txt
curl -O https://celestrak.org/NORAD/elements/molniya.txt
curl -O https://celestrak.org/NORAD/elements/gnss.txt
curl -O https://celestrak.org/NORAD/elements/gps-ops.txt
curl -O https://celestrak.org/NORAD/elements/glo-ops.txt
curl -O https://celestrak.org/NORAD/elements/galileo.txt
curl -O https://celestrak.org/NORAD/elements/beidou.txt
curl -O https://celestrak.org/NORAD/elements/sbas.txt
curl -O https://celestrak.org/NORAD/elements/nnss.txt
curl -O https://celestrak.org/NORAD/elements/musson.txt
curl -O https://celestrak.org/NORAD/elements/science.txt
curl -O https://celestrak.org/NORAD/elements/geodetic.txt
curl -O https://celestrak.org/NORAD/elements/engineering.txt
curl -O https://celestrak.org/NORAD/elements/education.txt
curl -O https://celestrak.org/NORAD/elements/military.txt
curl -O https://celestrak.org/NORAD/elements/radar.txt
curl -O https://celestrak.org/NORAD/elements/cubesat.txt
curl -O https://celestrak.org/NORAD/elements/other.txt
curl -O https://celestrak.org/NORAD/elements/supplemental/transporter-3.txt


mkdir -p ../ext
egrep -A2 '(FIRST-MOVE|MOVE-II)' --no-group-separator active.txt > ../ext/move.txt
egrep -A2 '(LEMUR-2-ROHOVITHSA)' --no-group-separator active.txt > ../ext/ot.txt
cat ../ext/ot-add.txt >> ../ext/ot.txt 2> /dev/null
egrep -A2 '^(SENTINEL-2A|SENTINEL-2B|SENTINEL-3A|SENTINEL-3B|AQUA|TERRA |SUOMI NPP|NOAA 20|NOAA 21|METEOSAT-8|METEOSAT-10|METEOSAT-11|GOES 16|GOES 17|HIMAWARI-8|METOP-A|METOP-B|METOP-C|LANDSAT 8|LANDSAT 9|FENGYUN 3D|GEO-KOMPSAT-2A)' --no-group-separator active.txt > ../ext/wfs.txt
cat ../ext/wfs-add.txt >> ../ext/wfs.txt 2> /dev/null
