// Where Cesium's credit line goes while the deck is up. The case is set here; the
// offsets are in main.css, which has to fight the inline `bottom` Cesium rewrites.

import { onUnmounted } from "vue";

const BODY_CLASS = "clock-deck";

type CreditPlace = "clear" | "stacked" | "beside" | "folded";

// The credit box (206 px, or 113 px stacked) plus 10 px of air, against a surface at
// `50% − 95`. Not measured at runtime: the line is a fifth of its width until the ion logo
// loads. Above 1000 px main.css overrides the result.
const CREDIT_BESIDE_MIN_PX = 624;
const CREDIT_STACKED_MIN_PX = 448;

export function useClockDeckChrome() {
  let folded = false;

  const place = (): CreditPlace => {
    if (folded) {
      return "folded";
    }
    const width = window.innerWidth;
    if (width >= CREDIT_BESIDE_MIN_PX) {
      return "beside";
    }
    return width >= CREDIT_STACKED_MIN_PX ? "stacked" : "clear";
  };

  const apply = (): void => {
    document.body.dataset.clockDeck = place();
  };

  function attach(startFolded: boolean): void {
    folded = startFolded;
    document.body.classList.add(BODY_CLASS);
    apply();
    window.addEventListener("resize", apply);
  }

  function setFolded(value: boolean): void {
    folded = value;
    apply();
  }

  function detach(): void {
    window.removeEventListener("resize", apply);
    document.body.classList.remove(BODY_CLASS);
    delete document.body.dataset.clockDeck;
  }

  onUnmounted(detach);

  return { attach, setFolded };
}
