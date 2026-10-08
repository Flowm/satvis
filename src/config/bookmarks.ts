// The demo bookmarks: the about page's three showcase links, which the App Store
// screenshots also open. bookmarks.test.ts keeps the two in step.

import type { Bookmark } from "../modules/util/bookmarks";

/** Every demo is on the default route, whose preset its query is relative to. */
export const DEMO_BOOKMARKS: readonly Bookmark[] = [
  {
    id: "demo-globe",
    kind: "demo",
    name: "Weather satellites",
    path: "/",
    thumbnail: "showcase/globe-card.jpg",
    at: 0,
    query: { time: "2026-10-04T08:52Z" },
  },
  {
    id: "demo-iss",
    kind: "demo",
    name: "Follow the ISS",
    path: "/",
    thumbnail: "showcase/iss-card.jpg",
    at: 0,
    query: { tags: "", sats: "ISS (ZARYA)", track: "ISS (ZARYA)", elements: "Point,Label,Orbit,3D model", layers: "VersaTiles", time: "2026-10-04T02:07Z" },
  },
  {
    id: "demo-sky",
    kind: "demo",
    name: "Night sky over Lauterbrunnen",
    path: "/",
    thumbnail: "showcase/sky-card.jpg",
    at: 0,
    query: {
      scene: "Sky",
      gs: "46.5935,7.9091",
      terrain: "ReEarth",
      layers: "VersaTiles",
      stars: "DeepStar2K",
      time: "2026-10-04T19:22Z",
      tags: "GNSS,Weather,OneWeb",
      elements: "Point,Label",
      // Satellites the valley's cliffs hide, which would otherwise label the rock face.
      xsats: [
        "COSMOS 2500 (755)",
        "GSAT0220 (GALILEO 24)",
        "METEOSAT-11 (MSG-4)",
        "BEIDOU-3 M27 (C49)",
        "SES-5 (EGNOS/PRN 136)",
        "EUTELSAT 5 WEST B (EGNOS/PRN 121)",
        "BEIDOU-3 M21 (C43)",
        "METEOSAT-12 (MTG-I1)",
        "METEOSAT-10 (MSG-3)",
        "MTG-I2",
        "LUCH 5B (SDCM/PRN 125)",
        "BEIDOU-3 M8 (C28)",
        "ONEWEB-0169",
        "ONEWEB-0336",
        "BEIDOU-3 M11 (C25)",
        "ONEWEB-0112",
        "ONEWEB-0628",
        "GSAT-8 (GAGAN/PRN 127)",
        "BEIDOU-2 G5 (C05)",
        "TIANMU-1 10",
        "TIANMU-1 13",
      ].join(","),
    },
  },
];
