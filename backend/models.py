from datetime import datetime, timezone
from typing import Optional
from sqlmodel import Column, DateTime, Field, SQLModel, Text


class PasskeyRecord(SQLModel, table=True):
    """Single-row table that stores the bcrypt hash of the master passkey."""

    __tablename__ = "passkey_records"

    id: Optional[int] = Field(default=None, primary_key=True)
    label: str = Field(default="master", description="Human-readable label for this passkey slot")
    hash: str = Field(description="bcrypt hash of the passkey")
    created_at: datetime = Field(default_factory=datetime.utcnow)


def utcnow() -> datetime:
    """Timezone-aware 'now' in UTC."""
    return datetime.now(timezone.utc)


class GraphSnapshot(SQLModel, table=True):
    """
    The saved knowledge graph. Single-user app, so there is only ever one row
    (id 1): PUT /graph upserts it, DELETE /graph removes it.
    """

    __tablename__ = "graph_snapshots"

    id: Optional[int] = Field(default=None, primary_key=True)
    source: str = Field(default="", max_length=200, description="e.g. 'Obsidian vault: My Vault'")
    # Full GraphData JSON. TEXT (not VARCHAR) so Postgres puts no cap on multi-MB graphs.
    data: str = Field(sa_column=Column(Text, nullable=False))
    node_count: int = Field(default=0)
    link_count: int = Field(default=0)
    # timestamptz on Postgres; SQLite drops the offset, so naive values read back mean UTC.
    updated_at: datetime = Field(
        default_factory=utcnow,
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
