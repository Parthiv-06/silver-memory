"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { findSection } from "@/lib/sections";
import { hasValidSession } from "@/lib/api";

export function SectionPage({ slug }: { slug: string }) {
  const section = findSection(slug)!;
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let live = true;
    // Sections sit behind the code word; without a valid session, go back to the login.
    void hasValidSession().then((ok) => {
      if (!live) return;
      if (ok) setAllowed(true);
      else router.replace("/");
    });
    return () => { live = false; };
  }, [router]);

  if (!allowed) return <main className="min-h-svh bg-[#171a24]" aria-busy="true" />;

  return (
    <main className="min-h-svh bg-[#171a24] text-[#f4eee6]">
      <div className="mx-auto flex min-h-svh w-full max-w-5xl flex-col px-6 py-8 md:px-10">
        <header className="flex items-center justify-between gap-4">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center gap-2 text-xs uppercase tracking-[0.14em] text-[#b9b4ae] hover:text-[#f4eee6] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#c87046]"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="m10.5 3.5-4.5 4.5 4.5 4.5" />
            </svg>
            Back to shelf
          </Link>
          <span className="font-serif text-lg tracking-[-0.05em]">Working Volumes</span>
        </header>

        <section className="flex flex-1 flex-col justify-center gap-5 py-16">
          <span aria-hidden="true" className="h-1.5 w-16 rounded-full" style={{ background: section.color, boxShadow: `inset 0 0 0 1px ${section.foil}` }} />
          <h1 className="font-serif text-5xl font-normal tracking-[-0.055em] md:text-7xl">{section.title}</h1>
          <p className="max-w-md text-base text-[#b9b4ae]">{section.note}</p>
          <p className="mt-6 max-w-md border-t border-white/10 pt-6 text-sm text-[#b9b4ae]">Nothing here yet.</p>
        </section>
      </div>
    </main>
  );
}
