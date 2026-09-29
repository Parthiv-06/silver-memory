"use client";

import { useState } from "react";
import GlyphPortal from "@/components/ui/glyph-portal";
import PasskeyBox from "@/components/ui/passkey-box";
import WorksWheel from "@/components/ui/works-wheel";

const GREEN = "#1F5B43";
const DARK_GREEN = "#263F35";
const MUTED = "#747B76";

export default function Home() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  return (
    <main className="min-h-screen bg-white">
      {/* =========================================================
          GLYPH PORTAL — LANDING SCREEN
      ========================================================= */}
      <GlyphPortal
        word="Hey Parthzzz!"
        scrollLength={2.4}
        interactive={false}
        annotations={false}
        enterLabel=""
        background={
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: GREEN,
            }}
          />
        }
        style={
          {
            "--gp-paper": "#FFFFFF",
            "--gp-ink": DARK_GREEN,
            "--gp-field": GREEN,
            "--gp-foreground": DARK_GREEN,
            background: "#FFFFFF",
            color: DARK_GREEN,
          } as React.CSSProperties
        }
        front={
          <>
            {/* =====================================================
                TOP HEADER
            ===================================================== */}
            <div
              style={{
                position: "absolute",
                top: "clamp(28px, 4.5vw, 48px)",
                left: "clamp(24px, 5vw, 64px)",
                right: "clamp(24px, 5vw, 64px)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "24px",
              }}
            >
              {/* Logo */}
              <span
                style={{
                  color: DARK_GREEN,
                  fontSize: "20px",
                  fontWeight: 700,
                  letterSpacing: "-0.065em",
                  lineHeight: 1,
                }}
              >
                Stay Focused!
              </span>

              {/* Category */}
              <span
                style={{
                  color: MUTED,
                  fontSize: "14px",
                  fontWeight: 400,
                  lineHeight: 1.5,
                }}
              >
                Stay Alive!!
              </span>
            </div>

            {/* =====================================================
                EYEBROW
            ===================================================== */}
            <p
              style={{
                position: "absolute",
                top: "25%",
                left: "24px",
                right: "24px",
                margin: 0,
                textAlign: "center",
                color: MUTED,
                fontSize: "clamp(13px, 1.2vw, 16px)",
                fontWeight: 400,
                lineHeight: 1.5,
                letterSpacing: "0.005em",
              }}
            >
              Symbiote: because apparently one personality wasn&apos;t enough..
            </p>

            {/* =====================================================
                SCROLL TEXT
            ===================================================== */}
            <span
              style={{
                position: "absolute",
                left: "24px",
                right: "24px",
                bottom: "7%",
                textAlign: "center",
                color: "#7C817B",
                fontSize: "12px",
                fontWeight: 400,
                lineHeight: 1.4,
                letterSpacing: "0.01em",
              }}
            >
              Scroll for a closer look ↓
            </span>
          </>
        }
      >
        {/* =========================================================
            CONTENT REVEALED AFTER PORTAL SCROLL — passkey gate.
            Nothing beyond this box exists until it's unlocked.
        ========================================================= */}
        <div
          className="min-h-screen w-full flex items-center justify-center"
          style={{
            background: "#FFFFFF",
            color: DARK_GREEN,
            padding: "24px",
          }}
        >
          <PasskeyBox onAuthenticated={() => setIsAuthenticated(true)} />
        </div>
      </GlyphPortal>

      {/* =========================================================
          PROJECTS / WORKS WHEEL — only exists once unlocked
      ========================================================= */}
      {isAuthenticated && (
        <section id="projects" className="min-h-screen bg-black">
          <WorksWheel
            label="My Projects"
            items={[
              {
                title: "CBM Platform",
                image: "/images/cbm.jpg",
                href: "#cbm-platform",
              },
              {
                title: "AI Assistant",
                image: "/images/ai-assistant.jpg",
                href: "#ai-assistant",
              },
              {
                title: "House Price Prediction",
                image: "/images/house-price.jpg",
                href: "#house-price",
              },
              {
                title: "E-Commerce Platform",
                image: "/images/ecommerce.jpg",
                href: "#ecommerce",
              },
            ]}
          />
        </section>
      )}
    </main>
  );
}
