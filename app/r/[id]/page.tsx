// Read-only shared brief: /r/{runId}. Runs are kept for 30 days in the durable store
// (lib/store/kv.ts); without one, only the instance that planned the run can open it.

import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { connection } from "next/server";
import { forClient, getRun } from "@/lib/runs";
import { SharedBrief } from "@/components/SharedBrief";

export const metadata: Metadata = { title: "Crossover · shared brief", robots: { index: false } };

async function Run({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const run = await getRun(id);
  if (!run)
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-2xl font-semibold">This brief isn&apos;t available</h1>
        <p className="mt-2 text-muted">Shared briefs are kept for 30 days. It may have expired, or this server never stored it. Open Crossover to plan it again.</p>
        <Link className="mt-6 inline-block text-accent underline" href="/">
          Open Crossover
        </Link>
      </div>
    );
  return <SharedBrief result={forClient(run)} />;
}

export default function Page({ params }: PageProps<"/r/[id]">) {
  return (
    <Suspense fallback={<p className="mx-auto max-w-6xl px-6 py-16 text-muted">Loading the brief…</p>}>
      <Run params={params} />
    </Suspense>
  );
}
