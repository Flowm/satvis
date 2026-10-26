// The about page's demo carousel (about.html), there and in the About dialog. The track is a
// scroll-snapped strip, so it swipes without a script; this adds the buttons and the arrow
// keys. Whether a step animates is the CSS's `scroll-behavior` (about.css), off for reduced motion.

/** Wires the buttons and arrow keys of the `.demoCarousel` `root`, and shows them. Returns the undo. */
export function attachCarousel(root: HTMLElement): () => void {
  const track = root.querySelector<HTMLElement>(".demoCarousel__track")!;
  const slides = [...track.children] as HTMLElement[];
  const controls = root.querySelector<HTMLElement>(".demoCarousel__controls")!;
  const prev = root.querySelector<HTMLButtonElement>(".demoCarousel__step--prev")!;
  const next = root.querySelector<HTMLButtonElement>(".demoCarousel__step--next")!;
  const dots = [...root.querySelectorAll<HTMLElement>(".demoCarousel__dots > *")];

  // Offsets from the first slide, which is where the track's scroll starts.
  const offset = (index: number): number => slides[index]!.offsetLeft - slides[0]!.offsetLeft;
  const current = (): number => {
    let nearest = 0;
    slides.forEach((_, index) => {
      if (Math.abs(offset(index) - track.scrollLeft) < Math.abs(offset(nearest) - track.scrollLeft)) {
        nearest = index;
      }
    });
    return nearest;
  };
  const show = (index: number): void => track.scrollTo({ left: offset(Math.max(0, Math.min(slides.length - 1, index))) });

  function update(): void {
    const index = current();
    prev.disabled = index === 0;
    next.disabled = index === slides.length - 1;
    dots.forEach((dot, i) => dot.classList.toggle("demoCarousel__dot--current", i === index));
  }

  const onPrev = (): void => show(current() - 1);
  const onNext = (): void => show(current() + 1);
  function onKey(event: KeyboardEvent): void {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (step === undefined || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    event.preventDefault();
    show(current() + step);
  }

  prev.addEventListener("click", onPrev);
  next.addEventListener("click", onNext);
  root.addEventListener("keydown", onKey);
  track.addEventListener("scroll", update, { passive: true });
  controls.hidden = false;
  update();
  return () => {
    prev.removeEventListener("click", onPrev);
    next.removeEventListener("click", onNext);
    root.removeEventListener("keydown", onKey);
    track.removeEventListener("scroll", update);
  };
}
