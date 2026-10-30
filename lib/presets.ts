// One-click demo presets. Comps are real, released titles; release titles are
// fictional. Final comp choices are locked after the live coverage test (M1).

import type { Brief, EntityType } from "@/lib/types";

export type Preset = {
  id: string;
  label: string;
  blurb: string;
  brief: Brief;
  compTypes: EntityType[];
  /** Suggested comp swap for the demo's wow moment. */
  swap: { from: string; to: string };
};

export const PRESETS: Preset[] = [
  {
    id: "prestige-horror",
    label: "Prestige horror film",
    blurb: "A slow-burn folk-horror debut. Comps: Hereditary, The Witch, Midsommar.",
    brief: {
      title: "The Tithe",
      format: "film",
      logline: "A grieving family returns to a remote village where the harvest festival demands a price.",
      comps: ["Hereditary", "The Witch", "Midsommar"],
      regions: ["US", "GB"],
      budget: "M",
      exclusions: ["alcohol"],
    },
    compTypes: ["movie"],
    swap: { from: "Midsommar", to: "Lady Bird" },
  },
  {
    id: "indie-coming-of-age",
    label: "Indie coming-of-age film",
    blurb: "A funny, aching last summer before college. Comps: Lady Bird, Eighth Grade, The Perks of Being a Wallflower.",
    brief: {
      title: "Glass Summer",
      format: "film",
      logline: "Two best friends spend their last summer before college trying to become different people.",
      comps: ["Lady Bird", "Eighth Grade", "The Perks of Being a Wallflower"],
      regions: ["US"],
      budget: "S",
      exclusions: [],
    },
    compTypes: ["movie"],
    swap: { from: "The Perks of Being a Wallflower", to: "Booksmart" },
  },
  {
    id: "dark-comedy-series",
    label: "Dark comedy series",
    blurb: "A sharp, sad-funny streaming series. Comps: Fleabag, Barry, Russian Doll.",
    brief: {
      title: "Second Person",
      format: "series",
      logline: "A failed actor takes a job impersonating strangers at their own funerals.",
      comps: ["Fleabag", "Barry", "Russian Doll"],
      regions: ["US", "GB"],
      budget: "L",
      exclusions: ["gambling"],
    },
    compTypes: ["tv_show"],
    swap: { from: "Barry", to: "The Bear" },
  },
];
