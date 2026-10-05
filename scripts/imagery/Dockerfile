# Pinned at 3.11: gdal2tiles.py in 3.14 does not write `tilemapresource.xml`, the
# file Cesium reads for the tiling scheme, and without it the globe renders nothing.
# tiles.py checks for it, then replaces its contents (see `write_manifest`).
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.11.3

# gdal2tiles holds whole overview levels in the block cache. The default, a fraction
# of RAM, thrashes in Docker's VM; level 5 needs well under 512 MB.
ENV GDAL_CACHEMAX=512

WORKDIR /work
COPY tiles.py /work/tiles.py
ENTRYPOINT ["python3", "/work/tiles.py"]
