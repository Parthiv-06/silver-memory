"use client";

import { useEffect, useState } from "react";
import api, { isAuthenticated, setToken } from "@/lib/api";

const DARK_GREEN = "#263F35";
const MUTED = "#747B76";

interface PasskeyBoxProps {
  /** Called once the passkey is verified successfully */
  onAuthenticated: () => void;
}

/**
 * A single, minimal passkey input. Wrong or empty input goes nowhere —
 * there is nothing beyond this box until the backend confirms the passkey.
 */
export default function PasskeyBox({ onAuthenticated }: PasskeyBoxProps) {
  const [passkey, setPasskey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already have a valid-looking token from a previous visit — skip re-entry.
  useEffect(() => {
    if (isAuthenticated()) onAuthenticated();
  }, [onAuthenticated]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!passkey.trim() || loading) return;

    setLoading(true);
    setError(null);

    try {
      const data = await api.post<{ access_token: string }>("/auth/verify", {
        passkey,
      });
      setToken(data.access_token);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        width: "100%",
        maxWidth: "360px",
        borderRadius: "14px",
        border: `1px solid rgba(31,91,67,0.14)`,
        background: "#FFFFFF",
        padding: "clamp(24px, 4vw, 32px)",
      }}
    >
      <p
        style={{
          margin: "0 0 16px",
          color: MUTED,
          fontSize: "13px",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        Enter passkey
      </p>

      <form onSubmit={handleSubmit} noValidate>
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Passkey"
          value={passkey}
          onChange={(e) => {
            setPasskey(e.target.value);
            if (error) setError(null);
          }}
          disabled={loading}
          style={{
            width: "100%",
            padding: "12px 14px",
            borderRadius: "8px",
            border: `1.5px solid ${error ? "#C0392B" : "rgba(31,91,67,0.2)"}`,
            background: "#FAFAF9",
            color: DARK_GREEN,
            fontSize: "15px",
            letterSpacing: "0.04em",
            outline: "none",
            boxSizing: "border-box",
          }}
        />

        {error && (
          <p style={{ margin: "10px 0 0", color: "#C0392B", fontSize: "13px" }}>
            {error === "Invalid passkey" ? "Wrong passkey." : error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading || !passkey.trim()}
          className="inline-flex items-center gap-7 rounded-[10px] px-6 py-3.5 transition-all duration-200"
          style={{
            width: "100%",
            marginTop: "16px",
            justifyContent: "center",
            border: "none",
            background: loading || !passkey.trim() ? "rgba(38,63,53,0.35)" : DARK_GREEN,
            color: "#FFFFFF",
            fontSize: "14px",
            fontWeight: 500,
            cursor: loading || !passkey.trim() ? "not-allowed" : "pointer",
            boxShadow: "0 2px 6px rgba(20,43,34,0.12)",
          }}
        >
          {loading ? "Verifying…" : "Unlock"}
          {!loading && (
            <span aria-hidden="true" style={{ fontSize: "18px", lineHeight: 1 }}>
              ↘
            </span>
          )}
        </button>
      </form>
    </div>
  );
}
