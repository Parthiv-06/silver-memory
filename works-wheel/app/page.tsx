"use client";

import GlyphPortal from "@/components/ui/glyph-portal";
import WorksWheel from "@/components/ui/works-wheel";

const GREEN = "#1F5B43";
const DARK_GREEN = "#263F35";
const MUTED = "#747B76";

export default function Home() {
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
              Symbiote: because apparently one personality wasn’t enough..
            </p>

            {/* =====================================================
                SUPPORTING TEXT
            ===================================================== */}
            <p
              style={{
                position: "absolute",
                top: "64%",
                left: "24px",
                right: "24px",
                margin: 0,
                textAlign: "center",
                color: "#646B66",
                fontSize: "clamp(15px, 1.4vw, 18px)",
                fontWeight: 400,
                lineHeight: 1.5,
              }}
            >
            
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
            CONTENT REVEALED AFTER PORTAL SCROLL
        ========================================================= */}
        <div
          className="min-h-screen w-full"
          style={{
            background: "#FFFFFF",
            color: DARK_GREEN,
          }}
        >
          <section className="mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-center px-6 py-24 md:px-12">
            <p
              className="mb-5 text-sm uppercase"
              style={{
                color: MUTED,
                letterSpacing: "0.2em",
              }}
            >
              Hello, I'm Parthzzz.
            </p>

            <h1
              className="max-w-5xl"
              style={{
                color: DARK_GREEN,
                fontSize: "clamp(42px, 7vw, 96px)",
                fontWeight: 400,
                lineHeight: 1.05,
                letterSpacing: "-0.045em",
              }}
            >
              I build things with code,
              <br />
              AI and curiosity.
            </h1>

            <p
              className="mt-8 max-w-2xl"
              style={{
                color: "#68716B",
                fontSize: "clamp(16px, 1.5vw, 20px)",
                lineHeight: 1.7,
              }}
            >
              Welcome to my portfolio. Explore my projects,
              experiments and work across software, artificial
              intelligence and engineering.
            </p>

            <div className="mt-10">
              <a
                href="#projects"
                className="inline-flex items-center gap-7 rounded-[10px] px-6 py-3.5 transition-all duration-200"
                style={{
                  background: DARK_GREEN,
                  color: "#FFFFFF",
                  fontSize: "14px",
                  fontWeight: 500,
                  boxShadow: "0 2px 6px rgba(20,43,34,0.12)",
                }}
              >
                View my work
                <span
                  aria-hidden="true"
                  style={{
                    fontSize: "18px",
                    lineHeight: 1,
                  }}
                >
                  ↘
                </span>
              </a>
            </div>
          </section>
        </div>
      </GlyphPortal>

      {/* =========================================================
          PROJECTS / WORKS WHEEL
      ========================================================= */}
      <section
        id="projects"
        className="min-h-screen bg-black"
      >
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
    </main>
  );
}