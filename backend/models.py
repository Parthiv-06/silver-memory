from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class PasskeyRecord(SQLModel, table=True):
    """Single-row table that stores the bcrypt hash of the master passkey."""

    __tablename__ = "passkey_records"

    id: Optional[int] = Field(default=None, primary_key=True)
    label: str = Field(default="master", description="Human-readable label for this passkey slot")
    hash: str = Field(description="bcrypt hash of the passkey")
    created_at: datetime = Field(default_factory=datetime.utcnow)
