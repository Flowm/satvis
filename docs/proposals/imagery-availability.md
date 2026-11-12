---
status: proposal
---

# Imagery for a satellite's instruments: availability, display, overpass replay

The Instruments tab says what a satellite observes with (ADR 0018). This proposal covers
the other half of that request: say which imagery is openly available for each
instrument, show it, and replay a sensing overpass. It holds the research, the owner's
decisions of 2026-11-11 and the slices that follow from them. The first slice is built;
its design is ADR 0019.

Everything below was measured on 2026-11-11 against the 740 instruments on the 254
satellites the public groups serve, 428 distinct names. "Rows" are (satellite,
instrument) pairs of that list. Each source was researched as its own job, with the
command behind every figure; a claim the design leans on was requested again by hand
and is marked **checked**.

## Decided

1. **A structured record**, not a link: a provider and a layer (`provider: gibs`,
   `layer: …`). The link to the provider's viewer is made from it, and direct
   integration builds on the same record.
2. **RGB imagery first**: true colour, natural colour and band composites. Single bands
   and derived products later.
3. **A third-party service needs a clear usage licence.**
4. **Satellite-specific products first.** Products that merge a constellation come
   after, where they add clear value; they are listed below.
5. **The Copernicus Browser is the official link for the Sentinels.** Another source is
   wanted for embedding their imagery.
6. **EUMETView:** assumed usable as a whole, to be confirmed. It is confirmed, below.
7. **Order: links, then hosted layers, then sources that need a catalogue query.**
8. **A file of its own** for the records.
9. **The existing `GOES-IR` layer can move into this structure.** GIBS's 90 days of
   geostationary history are enough; element sets degrade over that time anyway. It
   was dropped instead, once GeoColor was drawn on the globe.
10. **The first slice lists true colour and natural colour only**, one or two layers an
    instrument. The other composites wait until someone asks for them.
11. **JSTAR Mapper is out**: its tile backend is undocumented, and it keeps serving a
    Suomi NPP path after the satellite's data ended.

## Summary

- **No source publishes a key from a CEOS instrument to a layer or a collection.** The
  one machine route, NASA's own (GCMD names, then CMR, then a GIBS tag), reaches 19 rows
  and returns wrong layers without saying so. The mapping is written by hand.
- **The mapping is an imagery manifest**: a file of satellites, each instrument with the
  layers that show it, by provider and layer id, as the model manifests list what a
  model depicts (ADR 0007). `generate-groups` turns it into an `imagery` field on the
  satellite table's rows, attached to records at refresh time like every curated field.
- **Under the licence rule, five providers hold 163 satellite-specific RGB layers**, for
  21 rows on 18 satellites: NASA GIBS, EUMETView, JMA, Canada's MSC GeoMet and DWD. GIBS
  and EUMETView alone have 126 of them and reach the same 21 rows. A sixth, Geoscience
  Australia, adds Sentinel-2 per satellite, over Australia only.
- **First slice, built** (ADR 0019): the manifest with the true colour and natural
  colour layers among those 126 and three of the Copernicus Browser's datasets, the
  `imagery` field on the records, and an Imagery list per instrument in the Instruments
  tab that links each layer to its provider's viewer, in both apps. 27 entries for 24
  rows on 21 satellites.
- **Then** the same records are drawn on the globe: GIBS first, then EUMETView and JMA,
  on the web first. **Later** the catalogue sources, and with them overpass replay.

## What was asked of each source

Which instruments it has imagery for, in what form, whether a browser on another origin
can load it with no key and no proxy (CORS, range requests), how far back and how close
to real time it goes, how it indexes time, and what licence and credit it asks for.
"Picture" means what a person would call an image from the instrument: corrected
reflectance, brightness temperature, a band composite, radar backscatter. A retrieval
(aerosol, sea surface temperature, NO₂) is a "derived product". "RGB" is the narrower
set the first slice lists: a colour picture made from the instrument's own bands.

## Findings per source

Coverage of every kind of picture, of 740 rows / 254 satellites / 428 names:

| Source                                                            | Any data           | A picture, no key                      | Follows the clock on a globe               |
| ----------------------------------------------------------------- | ------------------ | -------------------------------------- | ------------------------------------------ |
| NASA GIBS                                                         | 58 / 37 / 39       | 31 / 24 / 19                           | 22 / 20 / 15 still updated                 |
| EUMETView                                                         | 13 / 8 / 7         | 8 / 8 / 4                              | 8 / 8 / 4                                  |
| Copernicus Data Space                                             | 60 / 49 / 35       | 12 / 10 / 5, quicklooks only           | none                                       |
| NOAA                                                              | 65 / 30 / 30       | 18 / 12 / 10                           | 18 / 12 / 10, mostly undocumented services |
| Land archives (Earth Search, Planetary Computer, INPE and others) | 47 / 32 / 30       | 29 rows; 27 as full pixels             | none ready-made: scenes, not layers        |
| Other weather agencies                                            | 23 / 19 / 18       | 14 / 13 / 12, four of them value grids | 6 / 6 / 4                                  |
| **Any of them**                                                   | **162 / 90 / 104** | **71 / 48 / 50**                       | **40 / 32 / 25**                           |

274 rows are instruments that make no image at all (space environment monitors, data
collection systems, GNSS receivers). By CEOS kind, a picture exists for 24 of the 112
multi-purpose visible/infrared imagers, 10 of the 84 high-resolution optical imagers and
7 of the 42 imaging radars. The rest of those two are commercial, military, or behind an
account: 74 optical rows and 30 radar rows have nothing open (ISRO, the Chinese
agencies, KARI, Roscosmos, Airbus/CNES, ASI, CONAE and others).

### NASA GIBS

- **Form.** WMTS, time as a path segment, 1,330 layers in Web Mercator and the same
  1,330 in geographic: 198 pictures, 1,014 derived products, 76 orbit tracks as vector
  tiles, 30 reference layers. The geographic matrix sets are not powers of two, as
  `GibsImagery.ts` already notes, so Web Mercator stays the one to use.
- **Browser.** Tiles, capabilities and time domains all answer any origin. The response
  says which frame it served (`layer-time-actual`) in a header a page can read. Tiles are
  sent `no-store`, so the browser keeps none of them.
- **Time.** Daily layers go back to launch (Terra 2000, Suomi NPP 2015, NOAA-20 2018,
  NOAA-21 2023) and the current day fills in as swaths arrive, about 3.5 hours behind.
  Geostationary layers step every 10 minutes, 15 to 35 minutes behind.
- **Geostationary history is 90 days, whatever the time domain says. Checked:** the
  domain of `GOES-East_ABI_Band13_Clean_Infrared` lists frames back to 2019, a tile for
  2026-09-01 answers 200, and tiles for 2026-08-01, 2026-03-01 and 2025-06-01 answer 404.
  Worldview's own configuration calls it a 90-day rolling window.
- **Granules. Checked:** `VIIRS_NOAA20_CorrectedReflectance_TrueColor_Granule` and its
  Suomi NPP twin serve each 6-minute granule as its own frame, for the last 90 days,
  marked beta; Suomi NPP's end on 2026-11-02 and age out from there. Between 2 and 7 of every 10 sampled daytime granules had tiles. NOAA-21
  and MODIS have no such layers. No daily composite says when a pixel was taken.
- **No platform or instrument field.** Capabilities carry none; the layer metadata has a
  free-text subtitle ("NOAA-20 / VIIRS"). Geostationary layers name a position
  ("GOES-East"), not a satellite.
- **Suomi NPP's layers all stop on 2026-11-02**, the day NOAA ended the satellite's
  science data ([its notice](https://www.nesdis.noaa.gov/news/cessation-of-suomi-national-polar-orbiting-partnership-s-npp-data-users-onafter-november-2-2026)).
  JSTAR Mapper's last granule ends that day at 15:34 UTC. Its Suomi NPP tile path still
  answers for later days, with pictures that are not Suomi NPP's.
- **Licence: clear.** NASA's open data policy and GIBS's requested acknowledgement, with
  a line per foreign source: NOAA for GOES, JMA for Himawari, "Contains modified
  Copernicus Sentinel data [year]" for HLS and OPERA. No published rate limit.

### EUMETSAT: EUMETView

- **Form.** WMS and WMTS on GeoServer. The WMTS `EPSG:4326` set is Cesium's geographic
  tiling scheme (256 px, 2×1 at the top); a Web Mercator set with 512 px tiles also
  works. No key, any origin.
- **Instruments with a picture:** FCI on Meteosat-12 every 10 minutes, the full disc at
  0°; SEVIRI on Meteosat-10, the older service at the same position, and on Meteosat-9
  (45.5°E) every 15, SEVIRI rapid scan on Meteosat-11
  every 5 over Europe, AVHRR/3 on Metop-B and Metop-C, OLCI on Sentinel-3A and 3B.
  Derived products only for LI, ASCAT and SLSTR. Nothing for IASI, MHS, GOME-2, Metop-SG,
  Sentinel-3C or Sentinel-6.
- **Time.** Geostationary layers go back to 2020 (FCI to September 2024) with no rolling
  window, 14 to 25 minutes behind. The Metop layers are the last six orbits stacked, or
  a day's daylit side, 4.5 to 6 hours behind: not one swath. The Sentinel-3 OLCI layers
  are one swath per step, about 8.5 hours behind.
- **Traps. Checked:** a tile request needs `TIME` with milliseconds. `…T12:00:00.000Z`
  answers 200, `…T12:00:00Z` answers 500 and no `TIME` answers 400. Every image may be
  cached for a week. The server snaps to the nearest time and says which in a header a
  page cannot read. The global WMTS capabilities document is broken; each workspace's
  own works, three of them not, though their tiles do.
- **Named for a service.** The SEVIRI layers are `msg_fes`, `msg_iodc` and `msg_rss`,
  and the archive since 2020 mixes whichever satellite provided each.
- **Licence: clear, for every layer.** The Data Policy (amended 25 November 2025)
  defines an Advanced Image Product to include "visualisations of individual channels
  (e.g. used in Web Map Services)" (Annex II, **checked**), puts every SEVIRI, FCI and
  LI one in the Core class, and licenses Core under CC BY 4.0 at any latency, commercial
  use included. The fee applies to numerical Level 1 data from EUMETCast and the Data
  Store, none of which EUMETView serves. Its user guide says the OGC services "allow
  users to integrate EUMETView into other applications", and its capabilities state fees
  and access constraints as "none" (**checked**). The catalogue flags one layer,
  `msg_rss:ir039_nrt`, as needing a licence, which reads as a copied abstract; it is a
  single band and is left out. Credit: "Contains modified EUMETSAT Meteosat data [year]"
  ("Metop" for the polar layers), and "Contains modified Copernicus Sentinel data [year]"
  for Sentinel-3. This also answers `georing-mosaic`'s open question for the view
  service, not for the Data Store it downloads from.
- **The Data Store search** answers any origin with no key: each product has its sensing
  start and end, orbit number and a footprint polygon.

### Copernicus Data Space

- **The catalogue is open, the pixels are not.** STAC and OData answer any origin with
  no login: 428 collections, a footprint and start and end times on every item. Product
  files, the COG bands, Sentinel Hub's processing and openEO all refuse without a token.
  There is no public tile service. A Sentinel Hub instance id bills its owner's free
  quota (10,000 requests a month), which makes it a secret in practice.
- **The one picture with no key is the per-product quicklook**, a small image in the
  product's own geometry, behind a redirect to a host without CORS headers.
- **Its viewer takes a link.** The Copernicus Browser documents its parameters
  (dataset, place, dates). **Checked:** the link opens the dataset, behind a dialog that
  offers "Use anonymously" and asks consent to reCAPTCHA's cookies. Its datasets are a
  constellation's, not a satellite's.
- **Licence.** The data is free, full and open; "Contains modified Copernicus Sentinel
  data [year]". The terms say access to the data needs registration and say nothing of
  anonymous use of the catalogue: the data is open, the service is unstated.

### Other ways to Sentinel imagery

Asked for by decision 5: a hosted, time-indexed layer with no key, CORS and a clear
licence.

| Instrument              | Per satellite                                                                           | Merged                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| MSI (Sentinel-2)        | Geoscience Australia: `ga_s2am_ard_3`, `ga_s2bm_ard_3`, `ga_s2cm_ard_3`, Australia only | GIBS `HLS_S30_Nadir_BRDF_Adjusted_Reflectance`, global, a week behind; Digital Earth Africa              |
| C-band SAR (Sentinel-1) | none                                                                                    | GIBS `OPERA_L2_Radiometric_Terrain_Corrected_SAR_Sentinel-1`, mainly North America; Digital Earth Africa |
| OLCI (Sentinel-3)       | EUMETView `copernicus:sentinel3a_olci_l1_rgb_fullres` and `sentinel3b_…`, global        | EUMETView's daily 3A and 3B accumulation                                                                 |
| SLSTR (Sentinel-3)      | none as a picture; sea surface temperature and fire power only                          | none                                                                                                     |
| TROPOMI (Sentinel-5P)   | derived only: GIBS NO₂ and SO₂                                                          |                                                                                                          |

- **Geoscience Australia is the one source that keeps Sentinel-2's units apart.**
  **Checked:** a true-colour tile of `ga_s2cm_ard_3` for 2026-11-10 answers any origin.
  WMTS in Web Mercator, a list of acquisition days per layer, updated the same day, back
  to 2015, CC BY 4.0. Pixels from about zoom 7; below that a grey footprint.
- **EOX's Sentinel-2 cloudless** is a yearly mosaic, not a pass: a basemap if anything.
  The 2016 and 2017 mosaics are CC BY 4.0, 2018 to 2025 CC BY-NC-SA.
- **Terrascope (VITO)** documents global layers of exactly this kind, Sentinel-3 true
  colour per satellite among them, with no authentication. Its server reset every
  connection, from the research job and from a plain request made by hand. Not confirmed
  in any respect.
- **Failed a condition:** S5P-PAL's tiles (no CORS), Esri's services (licence),
  Planetary Computer's per-satellite mosaic (rate limits, terms unstated).
- So globally and per satellite, only OLCI has a hosted layer. Sentinel-2 per scene, from
  Earth Search's true-colour COGs, is the catalogue step.

### NOAA

- **The buckets are open to a browser, and hold nothing a browser can draw**: NetCDF,
  HDF5 and Himawari's own format. No bucket holds GeoColor, a COG or a tile pyramid.
- **JSTAR Mapper**, the backend of a NOAA STAR web app, serves daily global composites in
  a geographic 2×1 grid of 512 px tiles for VIIRS on Suomi NPP, NOAA-20 and NOAA-21 and
  others, back to 2013. **Checked:** it also publishes a day's VIIRS granules as
  GeoJSON, 507 polygons with start and end times for NOAA-20 on 2026-11-10, to any
  origin. STAR's disclaimer lets its images be used with credit; the tile backend itself
  is undocumented and called experimental.
- **Geostationary.** NOAA's own map services are merged composites: nowCOAST keeps 7
  hours, the NESDIS image server 24 hours of GOES-East GeoColor and an hourly merged
  archive since May 2025. Both are documented public services.
- **SSEC RealEarth** has the most per-satellite layers of all (162 RGB ones) and is
  out: another website needs a registered access key.

### Land and radar archives

- **Element 84 Earth Search** is the usable one for Sentinel-2 scenes. **Checked:** its
  search answers any origin, an item from the day before carried its sensing time,
  footprint, `platform: sentinel-2c` and `instruments: ["msi"]`, and its true-colour COG
  (8-bit RGB) answered a cross-origin range request with 206.
- **Microsoft Planetary Computer** covers Landsat, Sentinel-1, 2, 3 and 5P, MODIS and
  ASTER with keyless previews and tiles, behind a token endpoint that has been answering
  429 per address since September.
- **INPE** (CBERS-4, CBERS-4A, Amazonia-1; CC BY 4.0) is open end to end, in 16-bit.
- **USGS's own endpoints give a browser nothing.** Landsat 8 and 9 have no
  satellite-specific hosted layer under the licence rule.
- These are scenes, not layers, and none states terms for its service: all of them wait
  for the catalogue step.

### Other weather agencies

- **JMA's own Himawari tiles. Checked:** Web Mercator XYZ tiles for Himawari-9, any
  origin, with a JSON list of the frames (every 10 minutes over 36 hours; tiles answer
  for about 5 days). Six RGB composites, true colour among them, to zoom 5 for the full
  disk. Public Data License 1.0, compatible with CC BY 4.0.
- **MSC GeoMet**, Canada's WMS, has GOES-East, GOES-West and Himawari RGB layers every 10
  minutes over about 54 hours. Licensed, and it adds no satellite GIBS and JMA lack.
- **NSMC** serves a daily true-colour mosaic of MERSI-3 on FY-3F and FY-3H to any origin.
  Its site says "All Rights Reserved" and states no terms: out.
- **Closed to a page on another origin:** NICT's and JAXA P-Tree's Himawari tiles, KMA's
  GK2A and GOCI-II images, ISRO's MOSDAC, and Roshydromet's Elektro-L. So the Korean,
  Indian and Russian geostationary imagers have no layer a browser can load.

## Licences

What the terms say about a public app whose visitors' browsers fetch the tiles:

| Service                                        | Verdict                            | Credit and limits                                                                        |
| ---------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| NASA GIBS, Worldview, CMR                      | Clear                              | GIBS's acknowledgement, plus the source's for GOES, Himawari and Sentinel products       |
| EUMETView                                      | Clear, CC BY 4.0                   | "Contains modified EUMETSAT Meteosat data [year]"                                        |
| JMA Himawari tiles                             | Clear, Public Data License 1.0     | "Based on Himawari imagery (Japan Meteorological Agency)"                                |
| MSC GeoMet                                     | Clear                              | "Data Source: Environment and Climate Change Canada"; contact from 86,400 requests a day |
| DWD                                            | Clear, CC BY 4.0                   | "Quelle: Deutscher Wetterdienst"                                                         |
| Geoscience Australia DEA                       | Clear, CC BY 4.0                   | Geoscience Australia                                                                     |
| nowCOAST, NESDIS Satellite Maps                | Clear                              | NOAA; display only                                                                       |
| JAXA Earth API                                 | Clear                              | "Image: Created using JAXA Earth API"; value grids, not pictures                         |
| EOX Sentinel-2 cloudless                       | Clear while the app is free        | CC BY-NC-SA from 2018                                                                    |
| NOAA STAR JSTAR Mapper                         | Images clear, the backend unstated | NOAA/NESDIS/STAR; experimental, may change without notice                                |
| Earth Search, Planetary Computer, INPE         | Data open, service unstated        | No terms, limits or guarantee                                                            |
| Copernicus catalogue and quicklooks            | Data open, service unstated        | The terms ask users to register                                                          |
| NSMC Fengyun                                   | Unstated                           | "All Rights Reserved"                                                                    |
| SSEC RealEarth, Esri Living Atlas, JAXA P-Tree | No                                 | A key, a subscription, or non-profit use only                                            |

A link to a viewer needs no grant: the Copernicus Browser and Worldview are links.

## The join

- **CEOS's own identifiers reach every row.** All 254 satellites match a mission by
  `norad_id` and all 740 rows an instrument id. CEOS carries WMO's OSCAR id on 210 of the
  satellites, a mission-level data portal link on 104, and no COSPAR, GCMD or CMR id.
- **Names do not join.** Folding case and punctuation, 142 of the 428 instrument names
  match a GCMD instrument and 116 of the 254 satellites a GCMD platform; 8 generic names
  match the wrong instrument ("AIS" becomes the Arizona Imager Spectrograph).
- **NASA's chain reaches 19 rows.** GCMD names, then CMR collections, then the tag that
  lists GIBS layers. CMR filters platform and instrument separately, so 31 of the 136
  layers it returns for Terra and MODIS belong to CERES, GHRSST or SMAP.
- **STAC's `platform` and `instruments` are free text**, spelt differently by each
  catalogue (`sentinel-2c`, `Sentinel-2C`).
- **No source says which satellite provides a service today.** The holders changed four times
  in the last 20 months: Himawari-8 stood in for Himawari-9 from 11 October to 26
  November 2025, and Meteosat-11 for Meteosat-10 for four days in April 2026.

## The satellite-specific RGB layers

Layers a browser can load with no key, that follow time, and that show one instrument
on one satellite, at the providers the licence rule admits:

| Satellite and instrument        | Layers                      | Default                                       | Step, history                                |
| ------------------------------- | --------------------------- | --------------------------------------------- | -------------------------------------------- |
| Terra, Aqua: MODIS              | GIBS 10, 9                  | `MODIS_Terra_CorrectedReflectance_TrueColor`  | Daily, since 2000 and 2002                   |
| Terra: MISR                     | GIBS 20                     | `MISR_AM1_Ellipsoid_Radiance_RGB_AN`          | Daily per camera from 2017; ended 2022       |
| NOAA-20, NOAA-21: VIIRS         | GIBS 14, 7                  | `VIIRS_NOAA20_CorrectedReflectance_TrueColor` | Daily, since 2018 and 2023; granules 90 days |
| Suomi NPP: VIIRS                | GIBS 14                     | `VIIRS_SNPP_CorrectedReflectance_TrueColor`   | Daily since 2015; ended 2026-11-02           |
| GOES-19, GOES-18: ABI           | GIBS 4 each; GeoMet 10, 11  | `GOES-East_ABI_GeoColor`, `GOES-West_…`       | 10 minutes, 90 days                          |
| Himawari-9: AHI                 | JMA 12; GIBS 1; GeoMet 3    | JMA `fd/REP/ETC`, true colour                 | 10 minutes; 5 days at JMA, 90 at GIBS        |
| Meteosat-12: FCI                | EUMETView 8                 | `mtg_fd:rgb_geocolour`                        | 10 minutes, since September 2024             |
| Meteosat-10, Meteosat-9: SEVIRI | EUMETView 11 each           | `msg_fes:rgb_natural`, `msg_iodc:rgb_natural` | 15 minutes, since 2020                       |
| Meteosat-11: SEVIRI             | EUMETView 3                 | `msg_rss:rgb_natural_nrt`, Europe             | 5 minutes, since 2020                        |
| Metop-B, Metop-C: AVHRR/3       | EUMETView 2 each            | `eps:m01_rgb_natural_fog`, six orbits stacked | Per orbit, since 2020                        |
| Sentinel-3A, 3B: OLCI           | EUMETView 1 each            | `copernicus:sentinel3a_olci_l1_rgb_fullres`   | Per orbit, since 2020                        |
| PACE: OCI, SPEXone, HARP2       | GIBS 1 each                 | `OCI_PACE_True_Color`                         | Daily, since 2024; HARP2 ended June 2026     |
| NISAR: L-band SAR               | GIBS 1                      | `NISAR_L2_Geocoded_Polarimetric_Covariance`   | Daily, since October 2025                    |
| Sentinel-2A, 2B, 2C: MSI        | Geoscience Australia 1 each | `ga_s2am_ard_3`, Australia only               | Per acquisition day, since 2015              |

- **163 layers** at GIBS (87), EUMETView (39), GeoMet (24), JMA (12) and DWD (1), for
  21 rows on 18 satellites. Geoscience Australia adds 3 layers and 3 rows.
- **92 name their satellite. 71 name a service or a position** and reach 6 rows:
  GOES-19, GOES-18, Himawari-9, Meteosat-10, Meteosat-9 and Meteosat-11. The four
  Meteosat and Himawari rows are reachable only that way.
- **Lost to the licence rule:** Landsat 8 and 9 (RealEarth alone) and MERSI-3 on FY-3F
  and FY-3H (NSMC alone).
- **Growth.** Single bands and brightness temperatures would add about 120 layers at
  these providers, derived products about 1,100, 855 of them at GIBS.

### Products that merge satellites, by what they add

1. **GIBS `HLS_S30_Nadir_BRDF_Adjusted_Reflectance`** (Sentinel-2A, 2B, 2C): the only
   hosted, global, time-indexed Sentinel-2 imagery there is. Daily since 2015, a week
   behind.
2. **GIBS `OPERA_L2_Radiometric_Terrain_Corrected_SAR_Sentinel-1`** (Sentinel-1A, 1C,
   1D): the only hosted Sentinel-1 picture. Mainly North America; the exact area is not
   confirmed.
3. **GIBS `HLS_L30_Nadir_BRDF_Adjusted_Reflectance`** (Landsat 8, 9): the only hosted
   Landsat imagery under the licence rule, daily since 2013.
4. **EUMETView's Geo Ring RGBs** (`mumi:wideareacoverage_rgb_natural` and three more):
   the whole geostationary belt in one recipe since 2021, every 3 hours and 2 to 5 hours
   late. `georing-mosaic` is meant to do this better.
5. **NESDIS's merged GOES GeoColor, hourly**: the only GOES GeoColor older than GIBS's
   90 days, back to May 2025. Decision 9 makes that a small gain.
6. **EUMETView's daily Sentinel-3A and 3B OLCI accumulation**: a gap-free day, where the
   per-satellite layers already show each swath.

Worth adding after the satellite-specific layers: the first three. They are the only
hosted imagery their instruments have. The rest add little: Terra and Aqua's combined
reflectance, nowCOAST's mosaics and the single-band world mosaics of NSMC and DWD.

## Overpass replay: what it needs

Deferred by decision 7 to the catalogue step. The findings stand:

|                       | What is shown                                                   | Needs                                | Honest when                                                                                                   |
| --------------------- | --------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Footprints**        | Each granule's outline, appearing as the clock passes its start | A catalogue with times and polygons  | Always: it is what was acquired, at any age                                                                   |
| **Granule pixels**    | The granule's image inside that outline                         | The same, plus a picture per granule | Always, where a picture exists                                                                                |
| **Clipped composite** | A daily composite revealed along the swath                      | Drawn swath extents, a daily layer   | Low latitudes only: above 30 to 40° VIIRS's adjacent orbits overlap and a later one has overwritten the pixel |
| **Full disk**         | The time-indexed layer of a geostationary imager                | Nothing new                          | Always; there is no pass                                                                                      |

Who provides the first two, with no key, to a page on another origin:

| Instruments              | Times and footprints                | Picture per granule                      |
| ------------------------ | ----------------------------------- | ---------------------------------------- |
| VIIRS (NOAA-20)          | CMR, 6-minute granules, **checked** | GIBS granule layers, 90 days, with holes |
| VIIRS (Suomi NPP)        | the same, until 2026-11-02          | the same, ageing out                     |
| VIIRS (NOAA-21)          | CMR; JSTAR Mapper's GeoJSON         | none documented                          |
| MODIS (Terra, Aqua)      | CMR, 5-minute granules              | none                                     |
| MSI (Sentinel-2)         | Earth Search, per tile              | Earth Search preview and true-colour COG |
| OLCI, SLSTR (Sentinel-3) | Copernicus STAC, EUMETSAT search    | quicklooks, unprojected                  |
| C-band SAR (Sentinel-1)  | Copernicus STAC                     | quicklooks, in radar geometry            |
| OLI (Landsat 8, 9)       | Planetary Computer                  | Planetary Computer previews              |
| AVHRR/3, IASI (Metop)    | EUMETSAT search, whole orbits       | none                                     |

- **Of these catalogues only CMR has clear terms for this use.** It asks for a
  `Client-Id` header and answers 429 when throttled.
- **The element set limits the satellite, not the imagery.** Run backwards from today's
  element set, NOAA-20 was 1.2 km off along its track after 7 days and 3.4 km after 88: a
  best case at 824 km. The literature gives about 1.5 km a day as typical. A footprint
  from a catalogue is right at any age; the satellite drawn above it is right for about
  a month with a 3,000 km swath, a week with Landsat's or Sentinel-2's, a day for a
  narrow one.
- **Which instruments a swath model could replay at all:** 247 rows are fixed wide-swath
  scanners on a low orbit and 29 are high-resolution imagers with a fixed swath over 60
  km; 56 are agile imagers whose strip can lie hundreds of km off the track, 42 are
  radars with selectable beams, 49 are geostationary, 40 are profilers and limb
  sounders, 3 are lightning sensors, and 274 make no image.
- **ADR 0018's decision stands, and replay does not strain it.** The nominal swath is
  not drawn because it is a nominal total. A granule footprint is the acquired ground
  itself, so footprints and granule pixels need no swath model. Only the clipped
  composite needs one, and it is the kind that is wrong away from the equator.
- **Prior art.** NASA Worldview draws up to 30 VIIRS granules as separate WMTS layers,
  each clipped to its CMR polygon. No viewer found moves pixels with the satellite.
- **CesiumJS.** Clipping polygons apply to the whole globe, not to one imagery layer, and
  `cutoutRectangle` is axis-aligned. That leaves one imagery layer per granule: tens are
  workable, hundreds are not.

## Slices

**First, built: the manifest, the field and links.** ADR 0019 holds its design and the
alternatives it beat: a hand-written imagery manifest by satellite and instrument, an
`imagery` field on the records, and in the Instruments tab of both apps a link from each
layer to its provider's viewer. 27 entries for 24 rows on 21 satellites: the true colour
and natural colour layers of GIBS and EUMETView, 20 of the 126, and the Copernicus
Browser's datasets for Sentinel-2, Sentinel-3's OLCI and Landsat's OLI.

- **Left out:** the false colour and weather composites, and with them Himawari-9 and
  NISAR, whose only colour layers at GIBS are an air mass composite and a radar false
  colour; Sentinel-1, whose picture is radar backscatter and waits for a `kind` beyond
  `rgb`; SLSTR, whose dataset was not confirmed to open as a colour picture.
- **Checked** in a browser: Worldview opens a layer (`?l=<layer>`, and `&t=<date>` for
  one that stopped), EUMETView opens a layer (`productviewer?v=<workspace>:<layer>`),
  the Copernicus Browser keeps the dataset in its address behind its consent dialog.
- Nothing is fetched and nothing is drawn, so no credit line changes yet.

**Second: hosted layers on the globe, web.** GIBS and EUMETView are built (ADR 0020):
their 20 entries are drawn from the Instruments tab, one Cesium layer a frame
(`FramedImagery.ts`). EUMETView is drawn by its WMS, which needed neither the
milliseconds nor a tile set.

- The `VIIRS` map layer is drawn the same way, from the layer registry; it could
  become NOAA-20's entry drawn as a basemap. The `GOES-IR` map layer is dropped.
- Then JMA (XYZ tiles and its list of frames), which brings Himawari-9 true colour.
- Each provider's credit is shown while its layer is drawn.
- How a layer is named in the url is ADR 0001's to settle then.

**Third: the native app**, whose `Imagery.swift` has four fixed sources and daily frames
only.

**Later, in this order:** the three merged products; Geoscience Australia's Sentinel-2
layers; the geostationary mosaic when `georing-mosaic` reaches its last milestone, its
plan unchanged; then the catalogue sources: Sentinel-2 scenes from Earth Search, and
replay, footprints first.

**Beside the slices:**

- **A check script under `scripts/`**, not built, would compare the manifest with each
  provider's capabilities: the layer exists, its step and first frame match, its newest
  frame is recent. It would have reported Suomi NPP's stop. It cannot see a handover.
- **Size.** All 126 layers on 18 satellites would be about 20 kB before compression, on
  payloads of 578 kB compressed. The derived products would be ten times that, the point
  at which layers would be served once and referenced.

## Not confirmed

- Rate limits: none published for GIBS, EUMETView, JMA or Geoscience Australia.
- Whether `msg_rss:ir039_nrt`'s licence flag is a catalogue error.
- Terrascope, in every respect.
- What fills JSTAR Mapper's Suomi NPP tile path since the satellite's data ended.
- The area OPERA's Sentinel-1 product covers.
- Which Meteosat ran the SEVIRI service at 0° and the rapid scan at each date since
  2020: an entry is right from its `start` and silent before it.
- Whether EUMETView's Geo Ring layers work through WMTS.
- That SLSTR's dataset in the Copernicus Browser opens as an RGB.
- Element set error for satellites under 600 km, and across a manoeuvre.

## Open decisions

1. **Is GeoMet worth listing?** It is licensed and adds 24 RGB layers for GOES and
   Himawari, with 54 hours of history and as WMS. Proposed: not in the first slice.
2. **Should someone try Terrascope from a desk?** If it answers a browser, it may be the
   global per-satellite Sentinel source decision 5 asks for.
