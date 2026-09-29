"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { CompleteShelfLandingPage } from "@designcodeio/threeui";
import "@designcodeio/threeui/style.css";
import { isSectionRoute } from "@/lib/sections";

export function Scene() {
  const router = useRouter();
  useEffect(() => {
    // The shelf runs in a same-origin iframe; opening a book posts its section route here.
    const open = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const route = event.data?.type === "shelf:open" ? event.data.route : null;
      if (isSectionRoute(route)) router.push(route);
    };
    window.addEventListener("message", open);
    return () => window.removeEventListener("message", open);
  }, [router]);

  return (
    <div className="shader-frame">
      <CompleteShelfLandingPage
        headingFont="iowan-old-style"
        bodyFont="inter"
        headingWeight="400"
        bodyWeight="400"
        primaryColor="#c87046"
        headingSize={60}
        bodySize={12}
        headingLetterSpacing={-0.055}
      />
    </div>
  );
}
