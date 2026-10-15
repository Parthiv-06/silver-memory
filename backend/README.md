# silver-memory backend

Minimal FastAPI service: check a passkey, hand back a JWT, and store the
knowledge graph the `/graph` page shows.

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/health` | GET | none | Liveness check |
| `/auth/verify` | POST | none | `{ "passkey": "..." }` → `{ "access_token": "...", "token_type": "bearer" }` |
| `/auth/me` | GET | Bearer JWT | Returns the decoded token payload if valid |
| `/graph` | GET | Bearer JWT | `{ "graph", "source", "updated_at", "nodes", "links" }`, or 404 `No graph saved yet` |
| `/graph` | PUT | Bearer JWT | `{ "graph": GraphData, "source": "..." }` → `{ "source", "updated_at", "nodes", "links" }` (replaces the stored graph) |
| `/graph` | DELETE | Bearer JWT | Forget the stored graph → 204 |

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

## Knowledge graph

One graph is stored (single-user app); `PUT /graph` replaces it. `GraphData`
is the frontend's type from `frontend/lib/graph/types.ts`:

```json
{
  "nodes":  [{ "id": "moc", "label": "System Design MOC", "group": "hub", "tags": ["index"], "unresolved": false, "meta": {} }],
  "links":  [{ "source": "moc", "target": "caching", "weight": 1 }],
  "groups": { "hub": { "label": "Hubs", "color": "#a78bfa" } }
}
```

Only `id`/`label` (nodes) and `source`/`target` (links) are required. Every
link end must be a node id — send unresolved targets as nodes with
`"unresolved": true`. Unknown keys are dropped; everything else comes back
from `GET /graph` as equivalent JSON (numbers may be reformatted, e.g. `1` →
`1.0`, and for a key sent twice the last value is kept).

After the token check (401), limits apply in this order (see `graph.py`):

- **413** — body over 15 MB, refused from `Content-Length` before reading, and
  again while streaming (so chunked uploads can't skip it).
- **422** — not JSON, or breaks a rule: ≤ 50,000 nodes, ≤ 250,000 links,
  `id`/`label` ≤ 512 chars (`id` non-empty), `group` ≤ 120, ≤ 32 tags of ≤ 120,
  `meta` ≤ 4 KB as JSON, unique node ids, links that resolve, `source` ≤ 200
  (no NUL characters), ≤ 10,000 `groups` entries. The body is FastAPI's usual
  `{"detail": [{"type", "loc", "msg"}]}` with a `msg` that names the field, e.g.
  `nodes[12].label is longer than 512 characters`. Validation stops at the
  first bad node and the first bad link (so a broken 15 MB upload can't make
  the server build millions of errors), and at most 20 problems are listed.

```bash
TOKEN=$(curl -s -X POST http://localhost:8000/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"passkey":"whatever-you-set-in-MASTER_PASSKEY"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

curl -X PUT http://localhost:8000/graph \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"source":"Obsidian vault: My Vault","graph":{"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B","unresolved":true}],"links":[{"source":"a","target":"b"}]}}'
# → {"source":"Obsidian vault: My Vault","updated_at":"2026-10-15T09:30:00.000Z","nodes":2,"links":1}

curl http://localhost:8000/graph -H "Authorization: Bearer $TOKEN"
curl -X DELETE http://localhost:8000/graph -H "Authorization: Bearer $TOKEN"   # → 204
```

Locally, a 50,000-node / 250,000-link graph (~12 MB) saves in about a second
and loads in under 0.1 s: it is stored as validated JSON text and served back
without re-parsing.

## Files

- `main.py` — FastAPI app, CORS, routes.
- `auth.py` — bcrypt hashing/verification, JWT create/decode. Refuses to start if `JWT_SECRET` isn't set.
- `graph.py` — `/graph` request/response schemas, limits, the 15 MB body guard and 422 messages.
- `models.py` — SQLModel tables: `PasskeyRecord`, and `GraphSnapshot` (one row holding the graph JSON as `TEXT`). Tables are created on startup.
- `database.py` — SQLAlchemy engine/session. SQLite by default; understands a Postgres `DATABASE_URL` if you attach one.
- `seed.py` — one-time script that hashes `MASTER_PASSKEY` and inserts it as the "master" record. Safe to re-run (it no-ops if a record already exists).
- `.env.example` — copy to `.env` for local dev. Never commit the real `.env`.

## Deploying

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full, step-by-step Railway deployment guide.
