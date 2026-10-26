// The standalone about page (about.html), which has no app around it.

import { attachCarousel } from "./modules/util/carousel";

for (const carousel of document.querySelectorAll<HTMLElement>(".demoCarousel")) {
  attachCarousel(carousel);
}
