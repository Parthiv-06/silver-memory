# Deploying the silver-memory backend to Railway

This is a complete, step-by-step guide to getting `backend/` running on
[Railway](https://railway.app), from an empty Railway account to a live,
tested HTTPS API. It assumes no prior Railway experience.

Read it in order the first time — later sections (scaling, troubleshooting)
are reference material you can jump to afterwards.

---

## 0. Before you start: understand the repo layout

Your git repo (`silver-memory`) has **two projects side by side**:

```
silver-memory/
├── backend/        ← what this guide deploys
└── works-wheel/     ← the Next.js frontend (deployed separately, e.g. Vercel)
```

This matters because Railway, by default, builds from the **repo root**. Since
`backend/` is a subdirectory, not the whole repo, you'll need to tell Railway
"only look inside `backend/`" — covered explicitly in Step 4. If you skip that
step, the build will fail because Railway won't find `requirements.txt` at
the root.

Also understand what this service *is*: a single small API with one table
(one row, really) that checks a passkey and issues a JWT. It does **not**
need a beefy plan — Railway's free/hobby tier is enough.

---

## 1. Prerequisites

- A GitHub account, with this repo pushed to GitHub (Railway deploys from git).
  If you haven't pushed yet:
  ```bash
  cd /Users/parthivreddy/core/silver-memory
  git add backend/
  git commit -m "Add backend: passkey auth API"
  git push origin main
  ```
  **Before you run `git add`**, double check `backend/.env` does not exist
  or is not staged (`git status` should not list it — it's gitignored, but
  worth a glance). Never commit real secrets.
- A [Railway](https://railway.app) account — sign up with GitHub (simplest,
  since it also grants repo access in the same step).
- (Optional, for the CLI-based workflow in Step 4b and for running `seed.py`
  in production in Step 6) Node.js installed locally, so you can install the
  Railway CLI:
  ```bash
  npm install -g @railway/cli
  railway login
  ```

---

## 2. What you're deploying, in plain terms

| Piece | What it is | Where it's configured |
|---|---|---|
| The API | FastAPI app served by `uvicorn` | `main.py`, started via `Procfile` |
| The database | SQLite file by default, or Postgres if you attach Railway's Postgres plugin | `database.py`, via `DATABASE_URL` |
| The passkey | One bcrypt hash, inserted by `seed.py` | You provide it via `MASTER_PASSKEY` env var, once |
| The JWT signing key | A random secret used to sign/verify tokens | You provide it via `JWT_SECRET` env var |
| Allowed frontend origins | Which domains may call this API from a browser | `CORS_ORIGINS` env var |

**Important — read this before you pick a database.** Railway's filesystem
for a deployed service is **ephemeral**: every time you redeploy (including
just pushing a new commit), the container is rebuilt from scratch and any
file written to disk — including a SQLite `.db` file — is wiped. That means
if you leave `DATABASE_URL` unset (SQLite default), **you will need to
re-run `seed.py` after every redeploy**, and any local file-based state is
lost on each deploy. For a one-row passkey table this is mildly annoying but
survivable. If you'd rather not think about it again, attach Railway's
Postgres plugin (Step 5) — it's free on the trial/hobby tier and persists
independently of your app's deploys.

---

## 3. Generate your real secrets now

Do this before touching the Railway dashboard, so you have them ready to paste in.

```bash
# JWT signing secret — long, random, never reused elsewhere
python3 -c "import secrets; print(secrets.token_hex(32))"
```

Copy that output somewhere safe (a password manager, not a text file you'll
forget about). Also decide on your real `MASTER_PASSKEY` — the actual
passphrase your portfolio's gate will ask visitors for. Don't reuse
`test-passkey-123` or anything you used while developing locally.

---

## 4. Create the Railway project and service

### Option A — via the dashboard (recommended for a first deploy)

1. Go to [railway.app/new](https://railway.app/new).
2. Choose **"Deploy from GitHub repo"**.
3. Authorize Railway to access your GitHub account if prompted, then select
   the `silver-memory` repository.
4. Railway creates a **project** with one **service** pointing at the repo
   root. You need to redirect that service to the `backend/` subfolder:
   - Open the new service → **Settings** tab.
   - Find **"Root Directory"** (under the "Source" section) and set it to:
     ```
     backend
     ```
   - Save. Railway will use this path as the working directory for every
     build and deploy from now on — `requirements.txt`, `Procfile`, etc. are
     all resolved relative to `backend/`.
5. Still in **Settings**, scroll to **"Build"** — Railway auto-detects Python
   via Nixpacks (it finds `requirements.txt` and `.python-version`) and will
   use the `Procfile`'s `web:` line as the start command. You shouldn't need
   to touch anything here, but if the build ever misdetects the language,
   you can pin things explicitly:
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`

### Option B — via the CLI (if you prefer terminal-driven deploys)

```bash
cd /Users/parthivreddy/core/silver-memory/backend
railway login          # opens a browser to authenticate
railway init            # creates a new Railway project, prompts for a name
railway up              # deploys the CURRENT DIRECTORY (backend/) as-is
```

Because you run `railway init`/`railway up` from inside `backend/`, there's
no "Root Directory" step to worry about — the CLI already scopes everything
to that folder. You can still open the project in the dashboard afterwards
to manage environment variables (next step) via a GUI if you prefer.

---

## 5. Set environment variables

In the dashboard: open your service → **Variables** tab → **"New Variable"**
(or **"Raw Editor"** to paste several at once). Add:

| Variable | Value | Notes |
|---|---|---|
| `JWT_SECRET` | the hex string from Step 3 | **Required.** App refuses to start without it. |
| `JWT_ALGORITHM` | `HS256` | Optional, this is the default. |
| `JWT_EXPIRE_HOURS` | `24` | Optional, tune to taste. |
| `CORS_ORIGINS` | `https://your-frontend-domain.com` | Comma-separate multiple origins, no trailing slash. Add `http://localhost:3000` too if you want to keep testing against prod from local dev. |
| `MASTER_PASSKEY` | your real passphrase | Only read by `seed.py`, not by the running app — see Step 6. You can remove this variable after seeding if you'd rather not leave it sitting in the dashboard. |

If you're using the CLI instead of the dashboard:

```bash
railway variables --set "JWT_SECRET=<paste-your-hex-secret>" \
                   --set "CORS_ORIGINS=https://your-frontend-domain.com" \
                   --set "MASTER_PASSKEY=<your-real-passkey>"
```

**Do you need `DATABASE_URL`?** Only if you're using Postgres (recommended
— see below). If you skip it, the app defaults to a local SQLite file, with
the ephemeral-storage caveat from Step 2.

### Optional but recommended: attach Postgres

1. In the Railway project (not inside the backend service — at the project
   level), click **"+ New"** → **"Database"** → **"Add PostgreSQL"**.
2. Railway provisions a Postgres instance and automatically creates a
   `DATABASE_URL` variable — but it sets it on the **Postgres service**, not
   your backend service, by default. Reference it from your backend
   service's variables instead of retyping it:
   - Open your **backend** service → **Variables** → **"New Variable"** →
     click the **"Add Reference"** option (or type `${{Postgres.DATABASE_URL}}`
     as the value, using whatever name Railway gave the Postgres service —
     check its service name in the sidebar, it defaults to `Postgres`).
3. Redeploy the backend service (Railway usually does this automatically
   when variables change). `database.py` already normalizes
   `postgres://` → `postgresql://` and adds the `psycopg2-binary` driver, so
   no code changes are needed.

---

## 6. Deploy, then seed the passkey

1. Trigger the first deploy: if you connected via GitHub (Option A), it
   should already be building — check the **Deployments** tab for build
   logs. If you used the CLI (Option B), it deployed when you ran
   `railway up`.
2. Watch the build logs until you see the deploy marked **"Success"** and
   the service shows as **Active**. Common first-deploy issues are covered
   in Troubleshooting below.
3. Get the public URL: **Settings** → **Networking** → **"Generate Domain"**
   (Railway gives you a free `*.up.railway.app` subdomain; you can add a
   custom domain here too, later, once you own one). Copy that URL.
4. Confirm it's alive:
   ```bash
   curl https://<your-service>.up.railway.app/health
   # → {"status":"ok","service":"silver-memory-backend"}
   ```
5. **Seed the passkey.** The database has no passkey row yet — `/auth/verify`
   will return a 503 until you run `seed.py` once against the deployed
   environment:
   ```bash
   cd /Users/parthivreddy/core/silver-memory/backend
   railway link              # if not already linked to this project
   railway run python seed.py
   ```
   This runs `seed.py` locally but with Railway's **production environment
   variables** injected (`MASTER_PASSKEY`, `DATABASE_URL`, etc.), so it
   writes to the actual deployed database, not your local one. You should see:
   ```
   [seed] Passkey seeded successfully (id=1, label='master')
   ```
6. Confirm the real flow works end to end:
   ```bash
   curl -X POST https://<your-service>.up.railway.app/auth/verify \
     -H "Content-Type: application/json" \
     -d '{"passkey":"<your-real-MASTER_PASSKEY>"}'
   # → {"access_token":"...","token_type":"bearer"}
   ```

If you went the SQLite route (no Postgres), remember: **every future
redeploy wipes this row**, so `railway run python seed.py` becomes a step
you repeat after each deploy. With Postgres attached, you do this exactly
once, ever (re-running it later is a safe no-op as long as the row exists).

---

## 7. Point the frontend at the deployed backend

In `works-wheel/`, whatever code calls this API needs its base URL to point
at Railway instead of `localhost:8000`. Set this as an environment variable
in whatever platform hosts the frontend (e.g. Vercel → Project Settings →
Environment Variables):

```
NEXT_PUBLIC_API_URL=https://<your-service>.up.railway.app
```

Then go back to Step 5 and make sure `CORS_ORIGINS` on the **backend**
includes the frontend's real production domain (not just `localhost`) —
otherwise the browser will block the request with a CORS error even though
`curl` works fine (curl doesn't enforce CORS; browsers do).

---

## 8. Ongoing workflow

- **Redeploying:** if connected via GitHub, every `git push` to the branch
  Railway is watching triggers a new build automatically. Via CLI, run
  `railway up` again from `backend/`.
- **Logs:** dashboard → your service → **Deployments** → click a deployment
  → **View Logs**. Or via CLI: `railway logs`.
- **Rotating the passkey:** delete the existing row (easiest via a Postgres
  client, or by connecting with `railway connect postgres` if you attached
  Postgres), then `railway run python seed.py` again with a new
  `MASTER_PASSKEY` value set.
- **Rotating `JWT_SECRET`:** changing it immediately invalidates every JWT
  issued under the old secret (anyone with a token gets logged out) — that's
  expected, not a bug.

---

## 9. Troubleshooting

**Build fails, can't find `requirements.txt`**
→ You skipped setting **Root Directory** to `backend` in Step 4. Check
Settings → Source.

**Build succeeds but app crashes on start, logs show `RuntimeError: JWT_SECRET is not set`**
→ You haven't added the `JWT_SECRET` variable yet, or added it to the wrong
service (e.g. the Postgres service instead of the backend service). Check
Step 5.

**`/auth/verify` returns `503 Passkey not configured`**
→ You haven't run `railway run python seed.py` yet (or, on SQLite, it ran
before a redeploy wiped the row). Re-run Step 6.5.

**`/auth/verify` always returns `401 Invalid passkey` even with the right passkey**
→ Almost always a `MASTER_PASSKEY` mismatch between what you seeded and what
you're sending, or stray whitespace/quotes in the Railway variable value.
Double check the **Variables** tab value has no accidental leading/trailing
spaces.

**Frontend gets a CORS error in the browser console, but `curl` works fine**
→ `CORS_ORIGINS` on the backend doesn't include the frontend's actual origin
(scheme + domain, no path). Add it and redeploy. Remember `curl` never
triggers CORS — only real browsers enforce it — so it passing doesn't rule
this out.

**Passkey row keeps disappearing after every deploy**
→ You're on the SQLite default and forgot the ephemeral-storage caveat from
Step 2. Attach Postgres (Step 5) or accept re-seeding after each deploy.

**Postgres connection errors mentioning `postgres://` scheme**
→ Shouldn't happen — `database.py` rewrites `postgres://` to `postgresql://`
automatically — but if you see this, confirm you didn't hardcode
`DATABASE_URL` somewhere else that bypasses `database.py`.

---

## 10. Security checklist before you consider this "done"

- [ ] `backend/.env` is not committed to git (`git status` shows it as
      untracked/ignored, `git log -p -- backend/.env` shows nothing).
- [ ] `JWT_SECRET` in production is a freshly generated random value, not
      something reused from local dev or copy-pasted from this guide's example.
- [ ] `MASTER_PASSKEY` in production is a real passphrase you haven't used
      anywhere else, not `test-passkey-123` or anything from local testing.
- [ ] `CORS_ORIGINS` in production lists only real, intended origins — not
      left as a wildcard, not still just `localhost`.
- [ ] You've decided deliberately between SQLite (simpler, resets each
      deploy) and Postgres (persists, one extra setup step) rather than
      defaulting into whichever by accident.
