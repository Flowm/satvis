---
status: accepted
---

# Numbers and dates follow the device, in both apps

The iOS app wrote a count in SwiftUI's `Text` by the device's region, so under en_DE the
Satellites list read "0/16.819" and the clock's date "Sun 25. Oct". Everything it built as a
string, the info panel's details, the pass list and the bookmarks, was fixed, held to the web
app's text, and the web app wrote everything fixed: "0/16819", "Sun 25 Oct", "48.14°". One
app showed both conventions on one screen, and the two apps did not agree.

## Decision

**Both apps write numbers and dates for people in the device's conventions.** The web app
formats through one module, `src/modules/util/formats.ts`, on cached `Intl.NumberFormat` and
`Intl.DateTimeFormat`; the iOS app through `Formats` in SatvisCore, on Foundation's format
styles. Counts are grouped ("16.819"), decimals take the region's separator ("48,14°"), and
the clock deck's day, the one date written with a month's name, its order ("Sun, 25 Oct"):
the clock deck and its timeline, the Satellites list and the catalog sheet, the info panel's
details and passes, and the counts in toasts and labels.

**English words, the region's conventions.** iOS gives an English-only app the device's region
under English, en_DE for a German device. The web takes the region of the browser's first
language (`navigator.languages`; a bare "de" is maximised to DE) and formats in English for it,
`en-DE`. Formatting in the language itself was rejected: a German browser would get "So., 25.
Okt." inside an English interface.

**Every other date is ISO 8601 in every region**: the pass list's day ("10-26 00:34:02"),
the launch and decay dates ("1998-11-20"), a bookmark's time ("2026-10-05 11:00 UTC") and the
element set's epoch. "10/26", "26/10" and "26.10." each read differently to someone, and a
compact date is where the region's order would be guessed at rather than read.

**Times of day stay 24-hour UTC.** The clock, the pass times and the LTAN read "13:04:05" in
every region, as the iOS app's clock already did on purpose (`testReadsUTCOnA24HourClock`); a
"1:04:05 PM UTC" mixes a civil convention into a scientific readout.

**Rounding stays JavaScript's `toFixed`.** Only the separators change. The web formats the
`toFixed` string itself, which `Intl` reads exactly, and iOS its exact port of `toFixed` as a
`Decimal`, so the two apps still agree to the digit; `Intl` rounding a double would part from
it at 1.005.

**What is not for people keeps its fixed form:** url parameters (ADR 0001), stored values,
analytics, the element set's values, and the Locations panel's coordinate fields, which show and parse a plain decimal so
that what is typed and what is pasted from a map both read the same.

**The sky view's lock card stays fixed**, whole numbers grouped as en-US ("178° S · 33° up ·
38,362 km away"), in both apps: it is held to `skyCard.ts` by the parity fixtures, and its
fixed width is sized for those digits. **The speed ladder's rungs stay ungrouped** ("−86400×")
for the same reason: grouped, the widest took 63 of a rung's 64 px on the web.

## Consequences

- The parity fixtures are written in en-US (`scripts/parity/generate.mjs`), and the native
  suites that compare their text pin `Formats.locale` to en_US (`.formatsInEnglishUS`). The
  web's unit tests pin en-US in `src/test/setup.ts`. The formats themselves are tested under
  en-US and de-DE on both sides.
- Apple's and the browser's locale data differ in small ways for the same region: en_DE's
  clock day is "Sun 25. Oct" on iOS and "Sun, 25 Oct" in Chrome. Both follow the device;
  neither is held to the other outside en-US.
- An unnamed station is named by its coordinates in the region's decimals, "48,14°, 11,58°";
  the degree signs keep the pair readable where the decimal separator is a comma.
