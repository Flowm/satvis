// The demo bookmarks: the scenes of the about page's showcase, live and with a group
// or a single satellite, so they show the present. The about page's own links pin the
// moment its pictures were taken.

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
    // The default preset's own group, so this is the default view.
    query: {},
  },
  {
    id: "demo-iss",
    kind: "demo",
    name: "Follow the ISS",
    path: "/",
    thumbnail: "showcase/iss-card.jpg",
    at: 0,
    // The ISS alone: the rest of the Stations group crowds the close-up.
    query: { tags: "", sats: "ISS (ZARYA)", track: "ISS (ZARYA)", elements: "Point,Label,Orbit,3D model", layers: "VersaTiles" },
  },
  {
    id: "demo-sky",
    kind: "demo",
    name: "Sky over Lauterbrunnen",
    path: "/",
    thumbnail: "showcase/sky-card.jpg",
    at: 0,
    query: { scene: "Sky", gs: "46.5935,7.9091,Lauterbrunnen", terrain: "ReEarth", layers: "VersaTiles", stars: "DeepStar2K", tags: "GNSS" },
  },
];
