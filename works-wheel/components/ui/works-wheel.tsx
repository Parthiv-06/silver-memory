"use client";

import * as React from "react";

export interface WorksWheelItem {
  title: string;
  image: string;
  href?: string;
}

export interface WorksWheelProps
  extends Omit<React.ComponentPropsWithoutRef<"section">, "children"> {
  items: WorksWheelItem[];
  label?: string;
  action?: string;
}

const CARD_H = 0.38;
const CARD_MAX_W = 0.34;
const CARD_RATIO = 1.45;

const STEP = 40;
const DRUM = 2.22;
const LENS = 2.7;
const RING_R = 1.14;
const BOW = 1.82;

const TITLE = 0.124;
const INDEX = 0.04;

const CULL = 1.6;

const WHEEL_UNITS = 900;
const DRAG_UNITS = 420;
const SETTLE = 140;
const EASE = 0.12;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

type Stage = {
  w: number;
  h: number;
};

const rad = (deg: number) => (deg * Math.PI) / 180;

const bowAt = (drumDeg: number, bow: number) =>
  -bow * (1 - Math.cos(rad(drumDeg)));

function place(
  ringDeg: number,
  drumDeg: number,
  ringR: number,
  drumR: number,
  bow: number,
  m: number,
) {
  return (
    `translateX(${m * bowAt(drumDeg, bow)}px)` +
    ` rotateZ(${(1 - m) * ringDeg}deg)` +
    ` translateY(${-(1 - m) * ringR}px)` +
    ` rotateX(${m * drumDeg}deg)` +
    ` translateZ(${m * drumR}px)`
  );
}

export function WorksWheel({
  items,
  label = "Works '26",
  action = "View",
  className,
  ...props
}: WorksWheelProps) {
  const stageRef = React.useRef<HTMLDivElement>(null);
  const wheelRef = React.useRef<HTMLDivElement>(null);

  const cardRefs = React.useRef<(HTMLElement | null)[]>([]);

  const labelRef = React.useRef<HTMLDivElement>(null);
  const titleRef = React.useRef<HTMLDivElement>(null);

  const turn = React.useRef(0);
  const target = React.useRef(0);

  const [active, setActive] = React.useState(0);

  const [stage, setStage] = React.useState<Stage>({
    w: 0,
    h: 0,
  });

  const [reduced, setReduced] = React.useState(false);

  const count = items.length;
  const last = Math.max(count - 1, 0);

  React.useEffect(() => {
    const query = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );

    const read = () => {
      setReduced(query.matches);
    };

    read();

    query.addEventListener("change", read);

    return () => {
      query.removeEventListener("change", read);
    };
  }, []);

  React.useEffect(() => {
    const el = stageRef.current;

    if (!el) return;

    const read = () => {
      setStage({
        w: el.clientWidth,
        h: el.clientHeight,
      });
    };

    read();

    const ro = new ResizeObserver(read);

    ro.observe(el);

    return () => {
      ro.disconnect();
    };
  }, []);

  const metrics = React.useMemo(() => {
    const { w, h } = stage;

    const cardW = Math.min(
      h * CARD_H * CARD_RATIO,
      w * CARD_MAX_W,
    );

    const cardH = cardW / CARD_RATIO;

    const drumR = cardH * DRUM;

    const ringR = cardH * RING_R;

    const ringScale = count
      ? clamp(
          (((2 * Math.PI * ringR) / count) * 0.82) /
            (cardW || 1),
          0.16,
          1,
        )
      : 1;

    return {
      cardW,
      cardH,
      ringR,
      ringScale,
      drumR,
      bow: cardH * BOW,
      depth: cardH * LENS,
      title: cardH * TITLE,
      index: cardH * INDEX,
    };
  }, [stage, count]);

  React.useEffect(() => {
    if (!stage.h || !count) return;

    let frame = 0;

    const { ringR, ringScale, drumR, bow } = metrics;

    const draw = () => {
      frame = requestAnimationFrame(draw);

      const gap = target.current - turn.current;

      if (Math.abs(gap) < 0.0005) {
        turn.current = target.current;
      } else {
        turn.current += gap * (reduced ? 1 : EASE);
      }

      const t = turn.current;

      const m = clamp(t, 0, 1);

      const pos = Math.max(0, t - 1);

      if (wheelRef.current) {
        wheelRef.current.style.transform =
          `translateZ(${-m * drumR}px)`;
      }

      for (let i = 0; i < count; i++) {
        const d = i - pos;

        const drumDeg = d * STEP;

        const card = cardRefs.current[i];

        if (card) {
          card.style.transform = place(
            d * (360 / count),
            drumDeg,
            ringR,
            drumR,
            bow,
            m,
          );

          card.style.opacity =
            m > 0.5 && Math.abs(d) > CULL
              ? "0"
              : "1";

          card.style.zIndex = String(
            Math.round(100 - Math.abs(d) * 2),
          );
        }

        const face =
          card?.firstElementChild as HTMLElement | null;

        if (face) {
          face.style.transform =
            `scale(${lerp(ringScale, 1, m)})`;
        }
      }

      if (labelRef.current) {
        labelRef.current.style.opacity = String(1 - m);
      }

      if (titleRef.current) {
        titleRef.current.style.opacity = String(m);
      }

      const near = clamp(
        Math.round(pos),
        0,
        last,
      );

      setActive((prev) =>
        prev === near ? prev : near,
      );
    };

    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [
    metrics,
    stage.h,
    count,
    last,
    reduced,
  ]);

  const to = React.useCallback(
    (next: number) => {
      target.current = clamp(
        next,
        0,
        last + 1,
      );
    },
    [last],
  );

  const settling = React.useRef<number | undefined>(
    undefined,
  );

  React.useEffect(() => {
    const el = stageRef.current;

    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      const next =
        target.current +
        event.deltaY / WHEEL_UNITS;

      if (
        next > 0 &&
        next < last + 1
      ) {
        event.preventDefault();
      }

      to(next);

      window.clearTimeout(
        settling.current,
      );

      settling.current = window.setTimeout(
        () => {
          to(Math.round(target.current));
        },
        SETTLE,
      );
    };

    el.addEventListener(
      "wheel",
      onWheel,
      {
        passive: false,
      },
    );

    return () => {
      el.removeEventListener(
        "wheel",
        onWheel,
      );

      window.clearTimeout(
        settling.current,
      );
    };
  }, [to, last]);

  const drag = React.useRef<number | null>(
    null,
  );

  return (
    <section
      aria-label={label}
      className={`bg-background text-foreground relative h-full min-h-[24rem] w-full overflow-hidden select-none ${className ?? ""}`}
      {...props}
    >
      <div
        ref={stageRef}
        tabIndex={0}
        role="listbox"
        aria-label={label}
        aria-activedescendant={
          `works-wheel-${active}`
        }
        className="
          focus-visible:outline-foreground
          absolute inset-0
          cursor-grab
          touch-pan-x
          outline-none
          focus-visible:outline-2
          focus-visible:-outline-offset-4
          active:cursor-grabbing
        "
        style={{
          perspective: `${metrics.depth}px`,
        }}
        onPointerDown={(event) => {
          drag.current =
            event.clientY;

          event.currentTarget.setPointerCapture(
            event.pointerId,
          );
        }}
        onPointerMove={(event) => {
          if (
            drag.current === null
          ) {
            return;
          }

          to(
            target.current +
              (drag.current -
                event.clientY) /
                DRAG_UNITS,
          );

          drag.current =
            event.clientY;
        }}
        onPointerUp={() => {
          drag.current = null;

          if (target.current > 1) {
            to(
              Math.round(
                target.current,
              ),
            );
          }
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          if (
            event.key === "ArrowDown"
          ) {
            to(
              Math.round(
                target.current,
              ) + 1,
            );
          } else if (
            event.key === "ArrowUp"
          ) {
            to(
              Math.round(
                target.current,
              ) - 1,
            );
          } else {
            return;
          }

          event.preventDefault();
        }}
      >
        <div
          ref={wheelRef}
          className="
            absolute
            top-1/2
            left-1/2
            [transform-style:preserve-3d]
          "
        >
          {items.map((item, i) => {
            const Tag = (
              item.href
                ? "a"
                : "div"
            ) as "a";

            return (
              <React.Fragment
                key={`${item.title}-${i}`}
              >
                <Tag
                  id={`works-wheel-${i}`}
                  role="option"
                  aria-selected={
                    i === active
                  }
                  href={item.href}
                  ref={(
                    node: HTMLElement | null,
                  ) => {
                    cardRefs.current[i] =
                      node;
                  }}
                  className="
                    group
                    absolute
                    [backface-visibility:hidden]
                  "
                  style={{
                    width:
                      metrics.cardW,
                    height:
                      metrics.cardH,
                    marginLeft:
                      -metrics.cardW / 2,
                    marginTop:
                      -metrics.cardH / 2,
                  }}
                >
                  <span
                    className="
                      bg-muted
                      relative
                      block
                      size-full
                      overflow-hidden
                      rounded-lg
                      shadow-[0_18px_40px_-18px_var(--tw-shadow-color)]
                    "
                  >
                    <img
                      src={item.image}
                      alt={item.title}
                      draggable={false}
                      className="
                        size-full
                        object-cover
                      "
                    />

                    {action &&
                    item.href ? (
                      <span
                        className="
                          bg-background/80
                          text-foreground
                          pointer-events-none
                          absolute
                          right-3
                          bottom-3
                          flex
                          translate-y-1
                          items-center
                          gap-1
                          rounded-full
                          px-2.5
                          py-1
                          text-[0.7rem]
                          opacity-0
                          backdrop-blur-sm
                          transition
                          group-hover:translate-y-0
                          group-hover:opacity-100
                        "
                      >
                        <svg
                          viewBox="0 0 12 12"
                          className="size-2.5"
                          aria-hidden="true"
                        >
                          <path
                            d="M3 9 9 3M4 3h5v5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>

                        {action}
                      </span>
                    ) : null}
                  </span>
                </Tag>
              </React.Fragment>
            );
          })}
        </div>
      </div>

      <div
        ref={labelRef}
        className="
          pointer-events-none
          absolute
          inset-0
          grid
          place-items-center
          tracking-tight
        "
        style={{
          fontSize: metrics.title,
        }}
      >
        {label}
      </div>

      <div
        ref={titleRef}
        className="
          pointer-events-none
          absolute
          top-1/2
          left-[8%]
          -translate-y-1/2
          tracking-tight
          opacity-0
        "
        style={{
          fontSize: metrics.title,
        }}
      >
        {items[active]?.title}
      </div>

      <ol
        className="
          text-muted-foreground
          absolute
          top-[7.5%]
          right-[2.5%]
          text-right
          leading-[1.75]
        "
        style={{
          fontSize: metrics.index,
        }}
      >
        {items.map((item, i) => (
          <li key={`${item.title}-${i}`}>
            <button
              type="button"
              onClick={() => to(i + 1)}
              className={`
  focus-visible:outline-foreground
  cursor-pointer
  transition-colors
  outline-none
  focus-visible:outline-1
  ${i === active ? "text-foreground font-medium" : ""}
`}
            >
              {item.title}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default WorksWheel;