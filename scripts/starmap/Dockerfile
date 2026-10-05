# OpenCV only reads half-float EXR and writes WebP; numpy does the reprojection.
FROM python:3.12-slim

# OpenCV gates EXR decoding behind this since 4.10; without it imread returns None.
ENV OPENCV_IO_ENABLE_OPENEXR=1
# Reprojection is memory-bandwidth bound, so more threads only oversubscribe the host.
ENV OMP_NUM_THREADS=4

# numpy is unpinned: opencv pins a compatible range, and pinning both is unsolvable.
# OpenEXR reads scanline ranges, which opencv cannot: the 32K map is 6.4 GiB as float32.
RUN pip install --no-cache-dir \
      "opencv-python-headless==4.12.*" \
      "OpenEXR==3.4.*"

WORKDIR /work
COPY cubemap.py /work/cubemap.py
ENTRYPOINT ["python", "/work/cubemap.py"]
