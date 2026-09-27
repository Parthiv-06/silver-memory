from sqlmodel import Session, SQLModel, create_engine
from dotenv import load_dotenv
import os

load_dotenv()

# Railway's Postgres plugin injects DATABASE_URL as "postgres://..."; SQLAlchemy
# 2.x requires the "postgresql://" scheme, so normalize it if present. Falls
# back to a local SQLite file when no DATABASE_URL is set (local dev).
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./silver_memory.db")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# SQLite needs `check_same_thread=False` for FastAPI's async workers
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args, echo=False)


def create_db_and_tables():
    """Create all tables defined in SQLModel metadata."""
    SQLModel.metadata.create_all(engine)


def get_session():
    """FastAPI dependency that yields a DB session."""
    with Session(engine) as session:
        yield session
