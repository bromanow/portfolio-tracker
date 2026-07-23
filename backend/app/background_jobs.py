"""Simple in-memory background job tracker for long-running price operations."""
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_MAX_JOBS = 50


def _now() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat()


def start_job(name: str) -> str:
    job_id = uuid.uuid4().hex[:8]
    with _lock:
        if len(_jobs) >= _MAX_JOBS:
            finished = [jid for jid, j in _jobs.items() if j["status"] != "running"]
            for jid in finished[: len(finished) // 2]:
                del _jobs[jid]
        _jobs[job_id] = {
            "id": job_id,
            "name": name,
            "status": "running",
            "started_at": _now(),
            "finished_at": None,
            "result": None,
            "error": None,
            "progress": None,
        }
    return job_id


def update_progress(job_id: str, progress: dict) -> None:
    with _lock:
        if job_id in _jobs:
            _jobs[job_id]["progress"] = progress


def finish_job(job_id: str, result: Any) -> None:
    with _lock:
        if job_id in _jobs:
            _jobs[job_id].update(status="done", result=result, finished_at=_now(), progress=None)


def fail_job(job_id: str, error: str) -> None:
    with _lock:
        if job_id in _jobs:
            _jobs[job_id].update(status="error", error=error, finished_at=_now(), progress=None)


def get_job(job_id: str) -> Optional[dict]:
    with _lock:
        return dict(_jobs[job_id]) if job_id in _jobs else None


def list_jobs() -> list[dict]:
    with _lock:
        return sorted(_jobs.values(), key=lambda j: j["started_at"], reverse=True)[:20]


def is_running(name: str) -> bool:
    """Return True if a job with this name is currently running."""
    with _lock:
        return any(j["status"] == "running" and j["name"] == name for j in _jobs.values())
