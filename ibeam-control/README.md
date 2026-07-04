# ibeam-control

A minimal, narrowly-scoped service that lets the backend start/stop/restart the IBeam
container without giving it access to the Docker socket directly. See `app.py` for the
full rationale — in short: this is the *only* thing with the Docker socket mounted, it
only runs on Coolify's private network, and its code hard-codes the single container name
it will ever touch. There's no generic "manage any container" endpoint.

## Deploying on Coolify

This isn't wired into Coolify automatically (each service is its own Coolify resource, not
driven by a compose file in this repo) — you'll need to create it once by hand:

1. **Coolify → your project → + New Resource → Application → Dockerfile** (or "Docker
   Compose" if you'd rather point it at this folder — either works).
2. Point the build at this `ibeam-control/` directory (repo: this one, base directory
   `ibeam-control`, Dockerfile detected automatically).
3. **Network**: same private network as the backend and the existing `portfolio-ibeam`
   service. Do **not** expose a public port/domain — private-network only, same as IBeam
   itself.
4. **Volumes**: mount the Docker socket **read-write** (start/stop needs write access):
   `/var/run/docker.sock:/var/run/docker.sock`
5. **Environment variables**:
   - `IBEAM_RESOURCE_NAME` — the **Coolify resource name** of the IBeam service, i.e.
     `portfolio-ibeam` (not a literal Docker container name). The service resolves the actual
     container at request time via Docker's `coolify.resourceName` label instead of a fixed
     name, because Coolify renames the underlying container to a new per-deployment hash (e.g.
     `l14lzwf7...-184356830589`) every time `portfolio-ibeam` is recreated/redeployed — the
     label is the one thing that stays constant across redeploys. Set this once; it never needs
     touching again, even after future IBeam redeploys. (The old `IBEAM_CONTAINER_NAME` var —
     which held the literal, redeploy-fragile container name — still works as a fallback, but
     prefer `IBEAM_RESOURCE_NAME` going forward.)
   - `CONTROL_TOKEN` — generate a random secret (e.g. `openssl rand -hex 32`); this is the
     shared secret the backend uses to authenticate to this service. Keep it out of git.
6. Deploy. It listens on port 8375 internally.
7. On the **backend** service, set:
   - `IBEAM_CONTROL_URL` — the private URL of this service, e.g.
     `http://ibeam-control-xxxx:8375` (use the internal Coolify hostname, same pattern as
     `IBEAM_BASE_URL`).
   - `IBEAM_CONTROL_TOKEN` — the same value as `CONTROL_TOKEN` above.

If `IBEAM_CONTROL_URL` / `IBEAM_CONTROL_TOKEN` are left unset on the backend, all of this
is simply inert — the backend falls back to today's behaviour (IBeam runs continuously,
no start/stop control). Nothing breaks if you don't deploy this.

## Why not a generic docker-socket-proxy?

Tools like `tecnativa/docker-socket-proxy` filter by Docker API *resource type and verb*
(e.g. "allow POST on /containers/*"), not by *which* container — so `CONTAINERS=1,POST=1`
would let a caller start, stop, or delete *any* container on the host, not just IBeam.
This service is deliberately narrower: the container name is baked into the code, and the
only actions exposed are start/restart/stop/status on that one name.
