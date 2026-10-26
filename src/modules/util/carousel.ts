// The about page's demo carousel (about.html), there and in the About dialog. The track is a
// scroll-snapped strip, so it swipes without a script; this adds the buttons, the dots and the
// arrow keys. Whether a step animates is the CSS's `scroll-behavior` (about.css), off for reduced motion.

/** Wires the buttons, dots and arrow keys of the `.demoCarousel` `root`, and shows them. Its listeners go with its elements. */
export function attachCarousel(root: HTMLElement): void {
  const track = root.querySelector<HTMLElement>(".demoCarousel__track")!;
  const slides = [...track.children] as HTMLElement[];
  const prev = root.querySelector<HTMLButtonElement>(".demoCarousel__step--prev")!;
  const next = root.querySelector<HTMLButtonElement>(".demoCarousel__step--next")!;
  const dots = slides.map(() => document.createElement("span"));
  root.querySelector(".demoCarousel__dots")!.replaceChildren(...dots);

  // A slide's width plus the track's gap.
  const step = (): number => slides[1]!.offsetLeft - slides[0]!.offsetLeft;
  const current = (): number => Math.round(track.scrollLeft / step());
  const show = (index: number): void => track.scrollTo({ left: Math.max(0, Math.min(slides.length - 1, index)) * step() });

  function update(): void {
    const index = current();
    prev.disabled = index === 0;
    next.disabled = index === slides.length - 1;
    dots.forEach((dot, i) => dot.classList.toggle("demoCarousel__dot--current", i === index));
  }

  prev.addEventListener("click", () => show(current() - 1));
  next.addEventListener("click", () => show(current() + 1));
  root.addEventListener("keydown", (event) => {
    const offset = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (offset !== 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      show(current() + offset);
    }
  });
  track.addEventListener("scroll", update, { passive: true });
  root.querySelector<HTMLElement>(".demoCarousel__controls")!.hidden = false;
  update();
}
