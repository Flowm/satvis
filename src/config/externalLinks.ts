// Every entry is keyed on the NORAD catalog number alone (see the note at the bottom).

export interface ExternalLink {
  label: string;
  title: string;
  href: string;
}

/** Most authoritative first; CelesTrak is this app's data source. Each URL scheme was checked against 25544. */
export function externalLinks(satnum: string): ExternalLink[] {
  return [
    {
      label: "CelesTrak",
      title: "CelesTrak SATCAT entry — the catalog this app's data comes from",
      href: `https://celestrak.org/satcat/table-satcat.php?CATNR=${satnum}`,
    },
    {
      label: "Satcat",
      title: "satcat.com — mass, radar cross section, conjunctions",
      href: `https://www.satcat.com/sats/${satnum}`,
    },
    {
      label: "n2yo",
      title: "n2yo.com — live tracking and pass predictions",
      href: `https://www.n2yo.com/satellite/?s=${satnum}`,
    },
    {
      label: "Heavens-Above",
      title: "heavens-above.com — orbit diagrams and ground track",
      href: `https://heavens-above.com/orbit.aspx?satid=${satnum}`,
    },
    {
      label: "KeepTrack",
      title: "app.keeptrack.space — 3D orbital analysis",
      href: `https://app.keeptrack.space/?sat=${satnum}`,
    },
  ];
}

// Left out, with no public page addressable by catalog number alone: Space-Track and ESA
// DISCOSweb (login), Wikipedia, Gunter's Space Page and Jonathan's Space Report (by mission
// name), orbit.ing-now.com (needs designator and slug). CelesTrak `gp.php` is data, not a page.
