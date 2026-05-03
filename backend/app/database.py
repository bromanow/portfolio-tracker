import os
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

# Connection string can be overridden via environment variable.
# Locally defaults to the portfolio_tracker database on the local PostgreSQL server.
# On a cloud host, set DATABASE_URL to the managed PostgreSQL connection string.
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://Mini@localhost/portfolio_tracker",
)

engine = create_engine(
    DATABASE_URL,
    pool_size=5,
    max_overflow=10,
    pool_pre_ping=True,   # drops stale connections automatically
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
