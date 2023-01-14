#!/usr/bin/env bash
set -u

cd "${0%/*}"

node update-tle.js

# Additional TLE groups for the satvis.space deployment
egrep -A2 '(FIRST-MOVE|MOVE-II)' --no-group-separator groups/active.txt > custom/move.txt
egrep -A2 '(LEMUR-2-ROHOVITHSA)' --no-group-separator groups/active.txt > custom/ot.txt
cat ext/ot-add.txt >> custom/ot.txt 2> /dev/null
egrep -A2 '^(SENTINEL-2A|SENTINEL-2B|SENTINEL-3A|SENTINEL-3B|AQUA|TERRA |SUOMI NPP|NOAA 20|NOAA 21|METEOSAT-8|METEOSAT-10|METEOSAT-11|GOES 16|GOES 17|GOES 18|HIMAWARI-8|METOP-A|METOP-B|METOP-C|LANDSAT 8|LANDSAT 9|FENGYUN 3D|GEO-KOMPSAT-2A)' --no-group-separator groups/active.txt > custom/wfs.txt
cat ext/wfs-add.txt >> custom/wfs.txt 2> /dev/null
