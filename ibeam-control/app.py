"""
IBeam control service — a minimal, narrowly-scoped Docker control surface.

Why this exists: the backend needs to start/stop the IBeam container (so it only runs while
someone is using the app, cutting the number of unattended overnight re-auth attempts that can
trip IBeam's own lockout-prevention shutdown). Docker only exposes that ability through the
Docker socket, and mounting the raw socket into the backend would let it control *every*
container on the host. This service is the alternative: it is the ONLY thing with the socket
mounted, it is reachable only on Coolify's private network, and its code (not just its config)
hard-codes the single container it will ever touch — resolved by Coolify's own
`coolify.resourceName` label (IBEAM_RESOURCE_NAME), not by literal container name. There is no
generic "act on any container" endpoint, unlike a generic docker-socket-proxy.

Coolify names containers after a per-deployment hash (e.g. `l14lzwf7...-124656303723`) that
changes every time the `portfolio-ibeam` resource is recreated/redeployed — looking the
container up by that literal name meant this service silently 404'd after every redeploy until
someone noticed and updated an env var by hand. The `coolify.resourceName` label, by contrast,
is set by Coolify to the human-readable resource name and stays constant across redeploys, so
resolving the container by label lookup instead of exact name means IBEAM_RESOURCE_NAME is set
once (to "portfolio-ibeam") and never needs touching again.

Endpoints (all require header X-Control-Token matching CONTROL_TOKEN):
    GET  /status   -> {"status": "running"|"exited"|"not_found"|..., "started_at": "..."}
    POST /start    -> start the container if it isn't running (no-op if already running)
    POST /restart  -> force a full stop+start, even if Docker thinks it's already running
                       (recovers the "running but the internal process died" zombie state)
    POST /stop     -> stop the container
"""
from __future__ import annotations

import os

import docker
from fastapi import FastAPI, Header, HTTPException

RESOURCE_NAME = os.environ.get("IBEAM_RESOURCE_NAME") or os.environ["IBEAM_CONTAINER_NAME"]
CONTROL_TOKEN = os.environ["CONTROL_TOKEN"]

app = FastAPI(title="ibeam-control", docs_url=None, redoc_url=None)
client = docker.from_env()


def _check_token(x_control_token: str | None) -> None:
    if not x_control_token or x_control_token != CONTROL_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Control-Token")


def _get_container():
    containers = client.containers.list(
        all=True, filters={"label": f"coolify.resourceName={RESOURCE_NAME}"},
    )
    if not containers:
        raise HTTPException(
            status_code=404,
            detail=f"No container found with label coolify.resourceName={RESOURCE_NAME}",
        )
    # Coolify's rolling update briefly runs old+new together; if that ever leaves more than
    # one match, the newest one is the live container.
    containers.sort(key=lambda c: c.attrs["Created"], reverse=True)
    return containers[0]


@app.get("/status")
def status(x_control_token: str | None = Header(None)):
    _check_token(x_control_token)
    c = _get_container()
    c.reload()
    return {
        "name": c.name,
        "status": c.status,   # running | exited | paused | restarting | ...
        "started_at": c.attrs.get("State", {}).get("StartedAt"),
    }


@app.post("/start")
def start(x_control_token: str | None = Header(None)):
    _check_token(x_control_token)
    c = _get_container()
    c.reload()
    if c.status != "running":
        c.start()
    return {"action": "start", "was_running": c.status == "running"}


@app.post("/restart")
def restart(x_control_token: str | None = Header(None)):
    """Force a real stop+start — needed when Docker considers the container 'running' but
    IBeam's internal auth process has died silently and stopped retrying (a real incident:
    docker start was a no-op in that state; only a full restart relaunches the entrypoint)."""
    _check_token(x_control_token)
    c = _get_container()
    c.restart(timeout=15)
    return {"action": "restart"}


@app.post("/stop")
def stop(x_control_token: str | None = Header(None)):
    _check_token(x_control_token)
    c = _get_container()
    c.reload()
    if c.status == "running":
        c.stop(timeout=15)
    return {"action": "stop", "was_running": c.status == "running"}
