import { z } from "zod";
import { REGIONS } from "@/lib/geo/cities";

// Qloo rule: never send personal data. Comp names go to Qloo search, so reject
// anything that looks like an email, phone number or URL.
const PERSONAL = /[^\s@]+@[^\s@]+\.[^\s@]+|(?:\+?\d[\s().-]*){9,}|https?:\/\//i;
const name = z.string().trim().min(1).max(120);
const compName = name.refine((s) => !PERSONAL.test(s), "Enter a film, series or artist title, not contact details or links");

export const BriefSchema = z.object({
  title: name,
  format: z.enum(["film", "series", "album", "tour"]),
  logline: z.string().trim().max(400).optional(),
  comps: z.array(compName).min(2).max(4),
  regions: z.array(z.string().refine((r) => r in REGIONS, "Unsupported region")).min(1).max(2),
  budget: z.enum(["S", "M", "L"]),
  exclusions: z.array(z.string().trim().min(1).max(60)).max(8).default([]),
});

export const CompSchema = z.object({
  name,
  entityId: z.string().min(1).max(200),
  type: z.enum(["movie", "tv_show", "artist", "book", "podcast", "brand"]),
  year: z.number().optional(),
  // Display-only text from Qloo search; live descriptions can run past 600 characters, so clip rather than reject.
  descriptor: z
    .string()
    .transform((s) => s.slice(0, 400))
    .optional(),
});

export const PlanRequest = z.object({
  brief: BriefSchema,
  comps: z.array(CompSchema).min(2).max(4),
  refinements: z
    .object({ excludedPartners: z.array(name).max(20).default([]), pinnedMarkets: z.array(name).max(5).default([]) })
    .default({ excludedPartners: [], pinnedMarkets: [] }),
  priorRunId: z.string().max(64).optional(),
  presetId: z.string().max(64).optional(),
});

export const ResolveRequest = z.object({
  comps: z.array(compName).min(1).max(4),
  format: z.enum(["film", "series", "album", "tour"]),
});

export const EXAMPLE_PLAN_REQUEST = {
  brief: { title: "The Tithe", format: "film", comps: ["Hereditary", "The Witch"], regions: ["US"], budget: "M", exclusions: [] },
  comps: [
    { name: "Hereditary", entityId: "<from /api/resolve>", type: "movie" },
    { name: "The Witch", entityId: "<from /api/resolve>", type: "movie" },
  ],
};
