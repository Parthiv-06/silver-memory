from datetime import datetime, timedelta
from typing import Optional

import bcrypt
from dotenv import load_dotenv
from jose import JWTError, jwt
import os

load_dotenv()

JWT_SECRET = os.getenv("JWT_SECRET")
if not JWT_SECRET:
    # Fail loudly instead of silently signing tokens with a guessable default —
    # this matters once the service is actually deployed and reachable.
    raise RuntimeError(
        "JWT_SECRET is not set. Set it in backend/.env locally, or as a "
        "Railway environment variable in production. Generate one with: "
        "python -c \"import secrets; print(secrets.token_hex(32))\""
    )

JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_EXPIRE_HOURS = int(os.getenv("JWT_EXPIRE_HOURS", "24"))


# ---------------------------------------------------------------------------
# bcrypt helpers
# ---------------------------------------------------------------------------

def hash_passkey(passkey: str) -> str:
    """Return a bcrypt hash of the given passkey (for seeding the DB)."""
    salt = bcrypt.gensalt(rounds=12)
    return bcrypt.hashpw(passkey.encode(), salt).decode()


def verify_passkey(passkey: str, hashed: str) -> bool:
    """Return True if the plaintext passkey matches the stored bcrypt hash."""
    try:
        return bcrypt.checkpw(passkey.encode(), hashed.encode())
    except Exception:
        return False


# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------

def create_access_token(subject: str = "parthiv") -> str:
    """Create a signed JWT that expires in JWT_EXPIRE_HOURS hours."""
    expire = datetime.utcnow() + timedelta(hours=JWT_EXPIRE_HOURS)
    payload = {
        "sub": subject,
        "iat": datetime.utcnow(),
        "exp": expire,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> Optional[dict]:
    """
    Decode and validate a JWT.
    Returns the payload dict on success, or None if invalid/expired.
    """
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except JWTError:
        return None
