// Display labels shared by server and browser code (no server imports here).

import type { Format } from "@/lib/types";

/** Who the reference audience for lift stands for, per release format. */
export function referenceLabel(format: Format): string {
  return { film: "a typical moviegoer", series: "a typical TV viewer", album: "a typical music fan", tour: "a typical music fan", special: "a typical comedy fan" }[format] ?? "a typical audience";
}

/** Lift in points (affinity × 100), signed: "+14", "−4". */
export function liftPoints(lift: number): string {
  const n = Math.round(lift * 100);
  return `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n)}`;
}
