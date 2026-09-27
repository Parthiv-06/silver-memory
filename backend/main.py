import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlmodel import Session, select

from auth import create_access_token, decode_access_token, verify_passkey
from database import create_db_and_tables, get_session
from models import PasskeyRecord


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
    description="Backend for the silver-memory portfolio — passkey auth",
    version="1.0.0",
    lifespan=lifespan,
)

# Comma-separated list of allowed origins, e.g.:
#   CORS_ORIGINS=http://localhost:3000,https://parthiv.dev
# Defaults to local Next.js dev only — set this in Railway once the
# frontend has a real domain, otherwise the deployed API will reject it.
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
