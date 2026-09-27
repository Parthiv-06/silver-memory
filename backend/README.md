# silver-memory backend

Minimal FastAPI service with one job: check a passkey, hand back a JWT.

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/health` | GET | none | Liveness check |
| `/auth/verify` | POST | none | `{ "passkey": "..." }` → `{ "access_token": "...", "token_type": "bearer" }` |
| `/auth/me` | GET | Bearer JWT | Returns the decoded token payload if valid |

## Local development

```bash
cd backend
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# then edit .env:
#   - JWT_SECRET: generate with `python -c "import secrets; print(secrets.token_hex(32))"`
#   - MASTER_PASSKEY: the plaintext passkey you want to gate access with

python seed.py                    # inserts the bcrypt hash of MASTER_PASSKEY into the DB
uvicorn main:app --reload --port 8000
```

Then check it's alive:

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"passkey":"whatever-you-set-in-MASTER_PASSKEY"}'
```

## Files

- `main.py` — FastAPI app, CORS, routes.
- `auth.py` — bcrypt hashing/verification, JWT create/decode. Refuses to start if `JWT_SECRET` isn't set.
- `models.py` — the single `PasskeyRecord` SQLModel table.
- `database.py` — SQLAlchemy engine/session. SQLite by default; understands a Postgres `DATABASE_URL` if you attach one.
- `seed.py` — one-time script that hashes `MASTER_PASSKEY` and inserts it as the "master" record. Safe to re-run (it no-ops if a record already exists).
- `.env.example` — copy to `.env` for local dev. Never commit the real `.env`.

## Deploying

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full, step-by-step Railway deployment guide.
