const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const TOKEN_KEY = "sm_token";

function readToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function writeToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable: the session just won't persist */ }
}

async function detail(res: Response) {
  const body = await res.json().catch(() => null);
  return typeof body?.detail === "string" ? body.detail : `HTTP ${res.status}`;
}

/** Checks the code word against the backend's /auth/verify and stores the returned JWT. */
export async function verifyCodeWord(passkey: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passkey }),
  });
  if (!res.ok) throw new Error(await detail(res));
  const { access_token } = (await res.json()) as { access_token: string };
  writeToken(access_token);
}

/** True when a stored JWT is still accepted by /auth/me. Clears it otherwise. */
export async function hasValidSession(): Promise<boolean> {
  const token = readToken();
  if (!token) return false;
  try {
    const res = await fetch(`${BASE_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) return true;
    if (res.status === 401) writeToken(null);
  } catch { /* backend unreachable: keep the token, ask for the code word again */ }
  return false;
}
