"use client";

import { useEffect, useState } from "react";
import Demo from "@/components/ui/glyph-portal-demo";
import { Scene } from "@/components/shelf-scene";
import { hasValidSession } from "@/lib/api";

export default function Home() {
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    let live = true;
    void hasValidSession().then((ok) => { if (live && ok) setVerified(true); });
    return () => { live = false; };
  }, []);
  return <main>{verified ? <Scene /> : <Demo onVerified={() => setVerified(true)} />}</main>;
}
