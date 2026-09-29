"use client";

import { useEffect, useState } from "react";
import Demo from "@/components/ui/glyph-portal-demo";
import { Scene } from "@/components/shelf-scene";
import { hasValidSession } from "@/lib/api";

export default function Home() {
  // null while the stored session is checked, so a returning visitor doesn't flash the login.
  const [verified, setVerified] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void hasValidSession().then((ok) => { if (live) setVerified(ok); });
    return () => { live = false; };
  }, []);
  if (verified === null) return <main className="min-h-svh bg-white" aria-busy="true" />;
  return <main>{verified ? <Scene /> : <Demo onVerified={() => setVerified(true)} />}</main>;
}
