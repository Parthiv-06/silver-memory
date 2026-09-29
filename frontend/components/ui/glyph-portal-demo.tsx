"use client";

import { useEffect, useState, type FormEvent } from "react";
import GlyphPortal from "@/components/ui/glyph-portal";

const settings = { word: "SUBLIME", scrollLength: 2.4, interactive: true, annotations: false };
const family = '"Glyph Portal Jakarta", Arial, sans-serif';
let fontLoad: Promise<void> | undefined;

export default function Demo(props: Partial<typeof settings>) {
  const s = { ...settings, ...props };
  const [face, setFace] = useState<string | null>(null);
  useEffect(() => {
    let settled = false;
    const finish = (value: string) => { if (!settled) { settled = true; setFace(value); } };
    // The demo uses the résumé's face. The component itself never fetches a font.
    fontLoad ??= new FontFace("Glyph Portal Jakarta", 'url("https://cdn.21st.dev/assets/mirror/15/153fc85b70298beeb1d61a5f723331649e7f23bb77302a66e61cb3e2fbdb5e79.woff2")', { weight: "400 700" })
      .load().then((font) => { document.fonts.add(font); });
    const timeout = window.setTimeout(() => finish("Arial, sans-serif"), 1600);
    void fontLoad.then(() => finish(family), () => finish("Arial, sans-serif"));
    return () => { settled = true; clearTimeout(timeout); };
  }, []);
  return (
    <div data-demo-scroll data-slipstream-demo tabIndex={0} role="region" aria-label="Sublime. Scroll to step inside."
      style={{ width: "100%", height: "100svh", overflowY: "auto", background: "#fff", containerType: "inline-size", fontFamily: face ?? "Arial, sans-serif" }}>
      <style>{`
        [data-slipstream-demo] [data-gp-caption]{inset:calc(var(--gp-word-bottom,50%) + 82px) 24px auto;justify-content:center;}
        [data-slipstream-demo] [data-gp-hint]{display:none;}
        [data-slipstream-demo] [data-gp-enter]{min-height:46px;padding:0 20px;gap:28px;background:#142b22;border:1px solid #10261d;border-radius:10px;color:#fff;font-size:13px;font-weight:500;box-shadow:0 1px 2px #10261d1a;transition:background .18s,box-shadow .18s;}
        [data-slipstream-demo] [data-gp-enter]:hover{background:#204434;box-shadow:0 3px 8px #10261d18;}
        [data-slipstream-demo] [data-gp-enter]:focus-visible{outline:2px solid #176247;outline-offset:4px;}
        [data-slipstream-demo] [data-gp-touch-picker]{top:auto;bottom:18px;left:50%;}
        [data-slipstream-demo] [data-gp-select]{border-color:transparent;border-radius:8px;font-size:12px;color:#626964;}
        [data-sublime-header]{position:absolute;inset:clamp(24px,4.5cqw,48px) clamp(24px,5cqw,64px) auto;display:flex;align-items:center;justify-content:space-between;gap:20px;}
        [data-sublime-logo]{font-size:19px;font-weight:600;letter-spacing:-.065em;color:#18251e;}
        [data-sublime-category]{font-size:12px;line-height:1.5;color:#71766f;}
        [data-sublime-eyebrow]{position:absolute;inset:auto 24px calc(100% - var(--gp-word-top,35%) + 32px);margin:0;text-align:center;font-size:13px;font-weight:400;line-height:1.5;letter-spacing:.005em;color:#71766f;}
        [data-sublime-support]{position:absolute;inset:calc(var(--gp-word-bottom,50%) + 32px) 24px auto;margin:0;text-align:center;font-size:16px;font-weight:400;line-height:1.5;color:#646a63;}
        [data-sublime-scroll]{position:absolute;inset:auto 24px 7%;text-align:center;color:#7c817b;font-size:11px;letter-spacing:.01em;}
        @media(any-pointer:coarse){[data-sublime-scroll]{bottom:13%;}}
        @container(max-width:450px){[data-sublime-category]{max-width:12ch;text-align:right;}[data-sublime-eyebrow]{font-size:12px;}[data-sublime-support]{font-size:14px;}[data-slipstream-demo] [data-gp-caption]{top:calc(var(--gp-word-bottom,50%) + 76px);}}
        @container(max-height:479px){[data-sublime-header]{top:18px;}[data-sublime-support]{top:calc(var(--gp-word-bottom,50%) + 16px);}[data-slipstream-demo] [data-gp-caption]{top:calc(var(--gp-word-bottom,50%) + 60px);}[data-sublime-scroll]{display:none;}}
        [data-slipstream-demo] [data-gp-content]{padding:5.5rem clamp(1.25rem,5cqw,5rem) 6.5rem;font-family:inherit;color:#14573f;background:#fff!important;place-items:center;}
        [data-slipstream-demo] section,[data-slipstream-demo] [data-gp-caption]{font-family:inherit;}
        [data-code-form]{display:flex;width:min(100%,360px);flex-direction:column;gap:10px;}
        [data-code-form] label{font-size:14px;font-weight:600;color:#14573f;}
        [data-code-field]{position:relative;display:flex;align-items:center;}
        [data-code-field] input{box-sizing:border-box;width:100%;height:48px;padding:0 52px 0 16px;border:1.5px solid #14573f;border-radius:10px;background:#fff;color:#0b3b2a;font-family:inherit;font-size:15px;font-weight:500;}
        [data-code-field] input::placeholder{color:#5f7a6d;}
        [data-code-field] input:focus{outline:none;box-shadow:0 0 0 3px rgba(20,87,63,.18);}
        [data-code-eye]{position:absolute;right:2px;display:flex;width:44px;height:44px;align-items:center;justify-content:center;border:0;border-radius:8px;padding:0;background:transparent;color:#14573f;cursor:pointer;}
        [data-code-eye]:focus-visible{outline:2px solid #14573f;outline-offset:2px;}
        [data-code-verify]{margin-top:14px;height:48px;border:1px solid #10261d;border-radius:10px;background:#14573f;color:#fff;font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;transition:background .18s;}
        [data-code-verify]:hover{background:#0b3b2a;}
        [data-code-verify]:focus-visible{outline:2px solid #14573f;outline-offset:3px;}
      `}</style>
      {face ? <GlyphPortal word={s.word} fontFamily={face} fontWeight={700} style={{ fontFamily: face }} scrollLength={s.scrollLength} interactive={s.interactive} annotations={s.annotations} enterLabel="Step inside" front={<>
          <div data-sublime-header><span data-sublime-logo>sublime.</span><span data-sublime-category>Design & digital experiences</span></div>
          <p data-sublime-eyebrow>A different perspective starts here.</p>
          <p data-sublime-support>Follow your curiosity.</p>
          <span data-sublime-scroll>Scroll for a closer look ↓</span>
        </>}>
        <CodeWordForm />
      </GlyphPortal> : <div role="status" style={{ height: "100%", display: "grid", placeItems: "center", color: "#555", fontSize: 12 }}>Loading type…</div>}
    </div>
  );
}

function CodeWordForm() {
  const [shown, setShown] = useState(false);
  // Verification is not wired up yet; keep the page from reloading on submit.
  const submit = (event: FormEvent<HTMLFormElement>) => event.preventDefault();
  return (
    <form data-code-form onSubmit={submit}>
      <label htmlFor="code-word">Code word</label>
      <div data-code-field>
        <input id="code-word" name="code-word" type={shown ? "text" : "password"} placeholder="Enter code word boss" autoComplete="current-password" />
        <button type="button" data-code-eye onClick={() => setShown(!shown)} aria-label={shown ? "Hide code word" : "Show code word"} aria-pressed={shown}>
          {shown ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
          )}
        </button>
      </div>
      <button type="submit" data-code-verify>Verify</button>
    </form>
  );
}
