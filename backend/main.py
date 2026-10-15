import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException, Response, status
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlmodel import Session, delete, select

from auth import create_access_token, decode_access_token, verify_passkey
from database import create_db_and_tables, get_session
from graph import (
    GraphResponse,
    GraphSummary,
    GraphUpload,
    parse_graph_upload,
    read_limited_body,
    upload_openapi,
)
from models import GraphSnapshot, PasskeyRecord, utcnow


# ---------------------------------------------------------------------------
# Lifespan: create tables on startup
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db_and_tables()
    yield


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Silver Memory API",
    description="Backend for the silver-memory portfolio — passkey auth and knowledge-graph storage",
    version="1.0.0",
    lifespan=lifespan,
)

# Comma-separated list of allowed origins, e.g.:
#   CORS_ORIGINS=http://localhost:3000,https://parthiv.dev
# Defaults to local Next.js dev only — set this in Railway once the
# frontend has a real domain, otherwise the deployed API will reject it.
# allow_methods="*" covers the PUT/DELETE /graph preflights.
_default_origins = "http://localhost:3000,http://127.0.0.1:3000"
CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", _default_origins).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

bearer_scheme = HTTPBearer(auto_error=False)


# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class VerifyRequest(BaseModel):
    passkey: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


# ---------------------------------------------------------------------------
# Auth dependency
# ---------------------------------------------------------------------------

def require_auth(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> dict:
    """FastAPI dependency — raises 401 if token is missing or invalid."""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = decode_access_token(credentials.credentials)
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return payload


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health", tags=["System"])
def health():
    """Public health-check endpoint. Railway pings this to confirm the deploy is alive."""
    return {"status": "ok", "service": "silver-memory-backend"}


@app.post("/auth/verify", response_model=TokenResponse, tags=["Auth"])
def verify(body: VerifyRequest, session: Session = Depends(get_session)):
    """
    Verify the master passkey against the bcrypt hash stored in the DB.
    Returns a signed JWT on success.
    """
    record = session.exec(select(PasskeyRecord).where(PasskeyRecord.label == "master")).first()

    if record is None:
        # DB not seeded yet
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Passkey not configured. Run seed.py first.",
        )

    if not verify_passkey(body.passkey, record.hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid passkey",
        )

    token = create_access_token()
    return TokenResponse(access_token=token)


@app.get("/auth/me", tags=["Auth"])
def me(payload: dict = Depends(require_auth)):
    """Protected route — validates the JWT and returns the token subject."""
    return {"valid": True, "sub": payload.get("sub"), "exp": payload.get("exp")}


# ---------------------------------------------------------------------------
# Knowledge graph (single stored graph; see graph.py for schemas and limits)
# ---------------------------------------------------------------------------

# The one graph row. A fixed key turns PUT into a single atomic upsert, so
# concurrent PUTs (or a PUT racing a DELETE) can't leave zero or two rows.
GRAPH_ROW_ID = 1


def _iso_utc(moment: datetime) -> str:
    """ISO-8601 with a Z suffix. SQLite returns naive datetimes; those are UTC."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@app.get(
    "/graph",
    tags=["Graph"],
    dependencies=[Depends(require_auth)],
    response_model=None,
    responses={
        200: {"model": GraphResponse, "description": "The stored graph"},
        404: {"description": "No graph saved yet"},
    },
)
def get_graph(session: Session = Depends(get_session)) -> Response:
    """Return the saved knowledge graph plus where it came from and when."""
    snapshot = session.get(GraphSnapshot, GRAPH_ROW_ID)
    if snapshot is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No graph saved yet")

    summary = GraphSummary(
        source=snapshot.source,
        updated_at=_iso_utc(snapshot.updated_at),
        nodes=snapshot.node_count,
        links=snapshot.link_count,
    )
    # `data` was validated and serialised on the way in, so splice it into the
    # response as-is rather than re-parsing megabytes of JSON on every read.
    body = '{"graph":' + snapshot.data + "," + summary.model_dump_json()[1:]
    return Response(content=body, media_type="application/json", headers={"Cache-Control": "no-store"})


@app.put(
    "/graph",
    tags=["Graph"],
    dependencies=[Depends(require_auth)],
    response_model=GraphSummary,
    responses={
        413: {"description": "Body larger than 15 MB"},
        422: {"description": "Invalid graph; each detail[].msg names the exact field"},
    },
    openapi_extra=upload_openapi(),
)
async def put_graph(
    raw: bytes = Depends(read_limited_body),
    session: Session = Depends(get_session),
) -> GraphSummary:
    """
    Replace the saved knowledge graph. Auth is checked before the body is read;
    the body is capped at 15 MB, then decoded and validated (see graph.py).
    """
    # JSON decoding, validation and the DB write are CPU/IO-bound — keep them
    # off the event loop.
    upload = await run_in_threadpool(parse_graph_upload, raw)
    return await run_in_threadpool(_save_graph, session, upload)


def _save_graph(session: Session, upload: GraphUpload) -> GraphSummary:
    """Replace the graph: INSERT .. ON CONFLICT (id) DO UPDATE on the fixed row."""
    values = {
        "source": upload.source,
        "data": upload.graph.to_json(),
        "node_count": len(upload.graph.nodes),
        "link_count": len(upload.graph.links),
        "updated_at": utcnow(),
    }
    # Never loads the old row, so the previous multi-MB `data` isn't read back.
    insert = pg_insert if session.get_bind().dialect.name == "postgresql" else sqlite_insert
    stmt = insert(GraphSnapshot).values(id=GRAPH_ROW_ID, **values)
    session.exec(stmt.on_conflict_do_update(index_elements=[GraphSnapshot.id], set_=values))
    # Defensive: no other row should exist, but never let a stray one shadow this graph.
    session.exec(delete(GraphSnapshot).where(GraphSnapshot.id != GRAPH_ROW_ID))
    session.commit()

    return GraphSummary(
        source=values["source"],
        updated_at=_iso_utc(values["updated_at"]),
        nodes=values["node_count"],
        links=values["link_count"],
    )


@app.delete(
    "/graph",
    status_code=status.HTTP_204_NO_CONTENT,
    tags=["Graph"],
    dependencies=[Depends(require_auth)],
)
def delete_graph(session: Session = Depends(get_session)) -> Response:
    """Forget the saved knowledge graph. Idempotent: 204 even if nothing was saved."""
    session.exec(delete(GraphSnapshot))
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
