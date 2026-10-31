"use client";

import Link from "next/link";
import type { RunResult } from "@/lib/types";
import { Results } from "./Results";

const noop = () => {};

/** A stored run, opened from a share link: the full results without swap, refine or exclude. */
export function SharedBrief({ result }: { result: RunResult }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
      <header className="flex items-center justify-between py-5 print:hidden">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Crossover
        </Link>
        <Link href="/" className="text-sm text-accent hover:underline">
          Plan your own release →
        </Link>
      </header>
      <Results
        result={result}
        previous={null}
        busy={false}
        steps={[]}
        preset={null}
        refinements={{ excludedPartners: [], pinnedMarkets: [] }}
        onRefine={noop}
        onSwap={noop}
        onRelax={noop}
        readOnly
      />
    </div>
  );
}
