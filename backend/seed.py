"""
seed.py — Run ONCE to insert the bcrypt hash of the master passkey into the DB.

The plaintext passkey is never hardcoded here — it's read from the
MASTER_PASSKEY environment variable so it never ends up in source control.

Usage (local):
    cd backend
    MASTER_PASSKEY="your-passkey-here" python seed.py
    # or put MASTER_PASSKEY=... in backend/.env and just run: python seed.py

Usage (Railway, after the service is deployed):
    railway run python seed.py
    # (reads MASTER_PASSKEY from the Railway environment variables you set
    # in the dashboard — see DEPLOYMENT.md)
"""

import os
import sys

from dotenv import load_dotenv

load_dotenv()

from database import create_db_and_tables, engine
from models import PasskeyRecord
from auth import hash_passkey
from sqlmodel import Session, select


def seed():
    passkey = os.getenv("MASTER_PASSKEY")
    if not passkey:
        print(
            "[seed] ERROR: MASTER_PASSKEY is not set.\n"
            "        Set it in backend/.env (local) or as a Railway "
            "environment variable, then re-run this script."
        )
        sys.exit(1)

    # Ensure tables exist
    create_db_and_tables()

    with Session(engine) as session:
        existing = session.exec(select(PasskeyRecord)).first()
        if existing:
            print(f"[seed] Passkey record already exists (label='{existing.label}'). Skipping.")
            print("[seed] To rotate the passkey, delete the existing row first (or the DB file locally).")
            return

        hashed = hash_passkey(passkey)
        record = PasskeyRecord(label="master", hash=hashed)
        session.add(record)
        session.commit()
        session.refresh(record)
        print(f"[seed] Passkey seeded successfully (id={record.id}, label='{record.label}')")


if __name__ == "__main__":
    seed()
