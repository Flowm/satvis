# Vallado's SGP4, vendored

`SGP4.cpp` and `SGP4.h` are David Vallado's SGP4 reference implementation, the
companion code to "Revisiting Spacetrack Report #3" (AIAA 2006-6753), revision of
12 March 2020. They are unmodified; line endings are CRLF as published.

- **Source:** <https://celestrak.org/software/vallado/cpp.zip>, `cpp/JustCode/`,
  downloaded 2026-10-04. The archive's SHA-256 was
  `16276bb1e72f90efd9c94c25a83403b0e4b04977d0d5f87487685cd479cd6866`.
- **SHA-256:** `SGP4.cpp` `2ee7ad0e8f201e8251894083fe21e33a7aace2f43c871bf04357eb44a891b06e`,
  `SGP4.h` `2a5ec44e059a52b3173d78d9a28bda8142b4f6497c1eb16febc2cea4b5006b0c`.
  python-sgp4's `extension/` carries the same two files byte for byte.
- **Terms:** the code was released without restriction for any use. The `NOTICE` of
  CelesTrak's repository <https://github.com/CelesTrak/fundamentals-of-astrodynamics>
  says so, and keeps the SGP4 C++ source out of the AGPL-3.0 that covers the rest
  of that repository.

The parity tests hold it to satellite.js, which the web app propagates with: the
two agree to under a micrometre. That repository has newer revisions (an XP-data check, Alpha-5 parsing,
`sscanf` fixes), mostly in TLE input, which this app does not use. Take one only
with the parity tests passing.

Only `sgp4init` and `sgp4` are called, through `../SGP4Bridge.cpp`, which also
compiles `SGP4.cpp` by including it, so its warnings can be silenced without
editing it.
