---
status: accepted
---

# CEOS as the satellite table's fifth contributor: the instruments a satellite carries

The satellite table says what a satellite is and where it came from (ADR 0006, 0008),
but not what it observes with. A swath is curated for 20 satellites
(`satvis.core.yaml`), and the comment above each row is the only place the instrument
is named. Showing a satellite's imagery starts with knowing which instruments it has.

Two public databases list instruments per satellite. Both were downloaded whole in
November 2026 and matched against the 5,822 satellites served outside Starlink.

|                   | CEOS MIM database                        | WMO OSCAR/Space                               |
| ----------------- | ---------------------------------------- | --------------------------------------------- |
| Access            | JSON API, beta; each list in one answer  | JSON API, 30 records a page, 36 pages at ~3 s |
| Licence           | CC BY 4.0                                | "used and redistributed freely", credit WMO   |
| Satellite key     | `norad_id`, on 546 of 1,200 missions     | none: a name, a launch date, a WIGOS id       |
| Change check      | a snapshot version, in a small answer    | none                                          |
| Served satellites | 302 missions match, 275 with instruments | 186 live ones, through CEOS's `oscar_id`      |

## Decision

**CEOS is a fifth upstream table, `ceos`, and the satellite table's fifth
contributor.** It owns one field, `instruments`: a list in which each instrument has a
`name`, and where CEOS gives them a `fullName`, a `kind`, its waveband classes
(`bands`), its finest resolution (`resolutionM`) and its nominal swath width
(`nominalSwathKm`), with `retired` on one whose mission is over.

**The table is one file put together from 21 downloads**: the missions, the
instruments, the combinations that say which mission carries which instrument, and each
of 17 wavebands with its instruments. The missions name their instruments by short name
alone, and five instruments are named "AIS", so only the combinations join the two. One
file is stored or refused whole, so no list is joined to another's copy from an earlier
day. `UpstreamSpec.assemble` is the hook: a spec that has one fetches its own file, in
place of a conditional GET.

**The file's ETag is CEOS's snapshot version**, from `/meta`, which CEOS says to ask
before downloading again: the identifier registry's hash and the time it was generated.
An unchanged snapshot costs that one request. A new one is asked for its version again
after the downloads, and the file is dropped if it differs: a snapshot loaded between
two lists would otherwise be stored half old.

**`kind` is CEOS's technology** ("Imaging radar (SAR)", 37 values), or its instrument
type where it gives none. The technology is singular and specific; the type is a
plural category ("Imaging multi-spectral radiometers (vis/IR)").

**A NORAD id is believed only where SATCAT's launch date confirms it.** CEOS records a
constellation as one mission with one unit's id, so the id alone gives BlackSky's 2016
mission to a satellite launched in 2026. A mission is kept when it launched no more
than a day before the satellite did, by calendar date in UTC:

- the same launch, within a day: 276 of the 302 matches (32 differ by a day, a launch
  near midnight UTC);
- later than the satellite: a hosted payload. The ISS has 13 missions, all later;
- earlier than the satellite: a constellation's later unit. 11 matches, the nearest
  266 days out. These are dropped.

A satellite SATCAT has no launch date for gets no instruments. That reads as "not
known", which a wrong list does not.

**Missions sharing a NORAD id are merged**: the instruments still flown first, then the
retired ones, a name counted once.

**`retired` needs CEOS to say the mission is over**: "Mission complete", or "Cancelled".
TIMED's status is "N/A", and it still flies SABER, which is listed without it.

**The info panel has an Instruments tab**, after Spacecraft, for a satellite that has
any. The ISS has 15 instruments, which as rows under the spacecraft
facts would bury them.

**`nominalSwathKm` is shown, never drawn.** It is a nominal total, 1,675 km for SLSTR against
the calibrated 1,000 and 500 per side, so the ground track and the passes keep the
curated extents (ADR 0002). The panel calls it "Nominal swath", and shows it only on a
low orbit: CEOS gives a geostationary imager 500 km.

## Consequences

- **254 served satellites carry 740 instruments.** All 20 satellites with a curated
  swath are among them, each with the instrument its swath belongs to.
- **Not every instrument has every figure**: of the 740, 687 have a full name beyond the
  short one, 735 a kind, 523 bands, 383 a resolution and 337 a nominal swath.
- **Coverage follows who answers the survey**: by GCAT purpose, 56 of 102 weather
  satellites and 33 of 70 Earth science ones, but 88 of 650 imaging ones. Commercial
  constellations and military imagers are mostly absent.
- **The served payloads grow by 4.5%**: 553 to 578 KB gzip, over the satellites of every
  group but Starlink. Names and kinds alone were 2%.
- **One request a day to CEOS**, and 23 when a snapshot is loaded: 4.7 MB, 535 KB
  stored. Its API allows 30 a second without a key.
- **`push-catalog` takes two minutes longer**, its pause before a fifth table.
- **The native app has the same tab**, with the same rows and band strips: its
  `SatelliteDetails` is held to `getSatelliteInfo`'s instruments and `wavebandCells`
  by the parity fixtures, and reads `WAVEBAND_COLUMNS` from `web-tables.json`. A press
  anywhere on a line but its image button unfolds it, where the web app's name alone
  does: a finger aims less finely than a pointer. A line and its facts are list rows
  of their own, so the list highlights the whole line as it does any row, and an
  unfolding line moves only the rows under it. VoiceOver reads the line's cells on
  its name, one element a line.
- **CEOS is CC BY 4.0.** The about page, the native app's Acknowledgements and both
  Instruments tabs credit "CEOS MIM Database".

## Alternatives rejected

- **OSCAR as the source.** It lists more per satellite (3.4 instruments against 2.9 on
  the 219 both know) and a status for each, but has no catalog number. Name and launch
  date matched 138 of its 289 satellites CEOS does not link; the rest need a hand-kept
  map.
- **Curated rows only.** Exact, but someone has to write each one, and the 254 are
  already written down upstream.
- **Joining the instrument list to the missions by short name.** One request fewer, and
  a guess wherever a name repeats.
- **A table per list**, four of them. A list changed between two downloads would be
  joined to the others' older copies, and `push-catalog` would pause six minutes more.
- **The file's digest as its ETag.** It needs all 21 downloads every day to learn that
  nothing changed.
- **CEOS's waveband text** ("13 bands in the VNIR-SWIR"). Free-form, and only in the
  same per-band answers; the classes say less, the same way every time.
- **Skipping missions named "Constellation".** "Planet Pelican" is one and does not
  say so; "COSMIC-2/FORMOSAT-7 (1)" says so and is one satellite with its own id.
- **Spreading a constellation's instruments over its units**, by GCAT programme. A
  name rule, which ADR 0002 removed.
- **Dropping retired missions.** The ISS would lose seven instruments it did carry, and
  a dead satellite its whole list; `retired` keeps both honest.
- **The instruments as rows of the Spacecraft tab.** The first version: a name and a
  kind per row. Five facts per instrument do not fit a row.

## Open questions

- **Does the version change with every change to the data?** The hash is of the
  identifiers, so the time the registry was generated is part of the ETag; whether a
  corrected figure regenerates it is not known. `/api/status` shows when the file was
  last replaced.
- **The API is a beta**, and says its paths and fields may change. A field the parser
  reads that is missing from any entry, a waveband's instrument without its
  `instrument_id`, an `instrument_details` entry without its `~`-separated fields, a
  figure that is neither a number nor null, or missions without `pagination.has_more`
  fails the parse, so the stored file stands and `/api/status` reports the error. A
  change in what a field means, or in its words, is not caught.
- **Does the mission list stay unpaged?** Sending a `limit` caps it at 100. The parser
  refuses an answer that says more pages follow.
- **The waveband classes have gaps**: Sentinel-2's MSI is VIS and SWIR, with no NIR.
- **104 operating missions have no NORAD id** (GeoEye-1, Göktürk-1). A curated row can
  give such a satellite its `instruments`.
