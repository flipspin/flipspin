# Running the server on another machine

The server is meant to live on a machine that stays on — a small Linux box, a
VM, or a container — with the desktop app (and any other client) connecting to
it over the local network. The desktop app calls it your **nest**
("nest"); in this guide, and everywhere in code, it is the server.

## In one line (Linux)

On Debian, Ubuntu, Proxmox LXC (with `nesting=1`) or 64-bit Raspberry Pi OS,
with an amd64 or arm64 CPU:

```sh
curl -fsSL https://raw.githubusercontent.com/flipspin/flipspin/main/deploy/install.sh | sh
```

The installer asks for sudo if needed. If Docker is missing, it explains what
it will install and requires an explicit **yes** before running the official
`get.docker.com` installer. An existing Docker installation is left alone;
if its Compose plugin is missing, install the plugin yourself and rerun.

Choose your music folder (`~/Music` if present, otherwise `/srv/krobi/music`)
and data folder (`/srv/krobi/data`). Missing folders are created. The container
runs as the music folder's numeric owner; a root-owned folder uses the invoking
sudo user's identity, or `1000:1000`. Existing music is never chowned. For a
shared folder owned by root, set `PUID`/`PGID` in `/opt/krobi/.env` to its writer's
identity. The image keeps `$HOME=/data`, credentials under `/data/Krobi/credentials`
and exactly one worker. The host data folder therefore contains `Krobi/setup-token`.

When ready, the installer prints a **setup link** for an unclaimed nest:
`krobi://<lan-ip>:8000/setup#<code>` (using your configured host port).
Copy and paste the setup link into the Flipspin app's **Setup link** field to
create the first account. The address and code appear separately underneath
for typing by hand. Run `flipspin setup-link` to print them again while unclaimed;
after the claim it prints “This nest is already set up.” and exits successfully.
Keep the link and code private until the claim. Neither command records them
in `install.log`; the server's setup announcement stays out of `krobi.log` and
API responses. The server port exposes the API; clients are
the desktop app and [OpenSubsonic apps](features/opensubsonic.md), which work
for mobile today. Native Flipspin iOS and Android apps are coming soon, not
released with v0.1.0.

For unattended installation, `--yes` explicitly approves installing Docker
and accepts folder defaults; override paths and the host port like this:

```sh
curl -fsSL https://raw.githubusercontent.com/flipspin/flipspin/main/deploy/install.sh | \
  sh -s -- --yes --music /mnt/library/music --data /srv/krobi/data --port 8000
```

Use absolute, separate folders dedicated to music and data. Paths with spaces,
`$` or `#` work; single quotes, backslashes and line breaks are rejected.
Reruns retain the saved folders, port, image and numeric user. They do not
migrate existing data: edit `/opt/krobi/.env` deliberately for a migration.

Files live in `/opt/krobi/compose.yml`, `/opt/krobi/.env` and
`/opt/krobi/install.log` (root-only log and environment). Management:

```sh
flipspin status
flipspin update       # pull, restart if needed, report old → new API version
flipspin setup-link   # print the setup link while the nest is unclaimed
flipspin logs         # follow container logs
flipspin stop
flipspin start
flipspin uninstall    # confirms; keeps music, data and the install log
# flipspin uninstall --purge  # a second confirmation deletes Flipspin's data
```

`update` reports **ya al día** if the running image is unchanged. If a pull fails
but the image exists locally, it explicitly says it is using that image.
A readiness timeout (120 seconds) points to `flipspin logs` and Compose logs.
Purge always keeps existing music libraries. The installer records whether it
created the music folder in `KROBI_MUSIC_CREATED`; reruns preserve that record.
Purge removes that folder only if Flipspin created it and it is completely empty;
any content (including audio in any format) is kept. Installations without the
record also keep their music. Both confirmations describe the deletion.
Purge refuses system directories, symlinks and paths containing another mount;
remove those manually. Docker itself is never uninstalled.

For a fork or local build, image repository and tag are separate:

```sh
docker build -f backend/Dockerfile -t krobi-local:latest .
KROBI_IMAGE=krobi-local KROBI_TAG=latest sh deploy/install.sh --yes
```

The pipe form also downloads `deploy/krobi` from the same repository's `main`
branch; a checkout uses the sibling helper. These raw GitHub URLs become usable
once the scripts land on `main`. Publishing the server image is a separate step.
The real install/claim/update/uninstall regression is `scripts/verify-install.py`;
its header describes the disposable Linux container and shared mounts it needs.

Other deployment paths:

- **Manual Docker / Compose / Unraid**: [Option B](#option-b-docker).
- **systemd + a Python virtualenv** (without Docker): [Option A](#option-a-systemd).

Placeholders used below: `your-server` is the machine's hostname and
`192.0.2.10` its address. Replace both with your own.

⚠ **Keep it on your LAN, or behind a VPN into it.** The server terminates no TLS
of its own; tokens cross the network in the clear. Do not port-forward it to the
internet. See [SECURITY.md](../SECURITY.md).

---

## Before you start: three rules the app depends on

1. **One worker.** Download progress lives in the server's memory. With
   `--workers 2` or more, the request that starts a download and the one that
   streams its progress land in different processes, and downloads appear stuck
   at 0% while the files arrive. Both deployment files pin `--workers 1`.
2. **Bind `0.0.0.0`, not `127.0.0.1`.** Loopback inside a container or VM is
   reachable from nothing else; the service looks healthy and every other
   machine gets "connection refused".
3. **Keep the data under the service user's `$HOME`.** The server reads
   `$HOME/Krobi/.env` at startup and writes settings saved from the app to
   `<KROBI_CREDENTIALS_DIR>/../.env`; those must be the same file, so
   `KROBI_CREDENTIALS_DIR` is `$HOME/Krobi/credentials`. The API also refuses to
   switch the library to a directory outside `$HOME`. (The Docker image keeps
   `$HOME` at `/data` and the library at `/music`, set at startup — that switch
   is loopback-only and never offered to a container's clients.)

---

## Option A: systemd

The unit assumes this layout:

```
/opt/krobi/backend/            # the repository's backend/ directory
/opt/krobi/venv/               # Python virtualenv
/var/lib/krobi/                # HOME of the `krobi` service user
/var/lib/krobi/Krobi/Music/    # the library (a mount, or plain storage)
/var/lib/krobi/Krobi/…         # playlists, logs, temp, credentials, accounts
/etc/krobi/backend.env         # the EnvironmentFile you edit
```

### 1. User and directories

```bash
useradd --system --home-dir /var/lib/krobi --create-home \
        --shell /usr/sbin/nologin krobi

install -d -o krobi -g krobi -m 0750 \
  /var/lib/krobi/Krobi /var/lib/krobi/Krobi/Music \
  /var/lib/krobi/Krobi/playlists /var/lib/krobi/Krobi/temp \
  /var/lib/krobi/Krobi/logs /var/lib/krobi/Krobi/credentials \
  /var/lib/krobi/.cache/numba
```

If the music lives on a separate disk, mount it at `/var/lib/krobi/Krobi/Music`
and make sure the `krobi` user owns it (`chown -R krobi:krobi`). In an
unprivileged container, a bind-mounted directory keeps its **numeric** owner
from the host, so the host-side owner must be the uid that the container's
`krobi` maps to — otherwise it shows up as `nobody:nogroup` and every write
fails.

### 2. Code and virtualenv

Python 3.12 is recommended (3.13+ may try to compile audio dependencies).

```bash
git clone https://github.com/flipspin/flipspin.git /opt/krobi/src
cp -a /opt/krobi/src/backend /opt/krobi/backend

python3.12 -m venv /opt/krobi/venv
/opt/krobi/venv/bin/pip install --upgrade pip
/opt/krobi/venv/bin/pip install -r /opt/krobi/backend/requirements-runtime.txt
```

Use `requirements-runtime.txt`, not `requirements.txt` — the latter adds the
test and packaging tools. ffmpeg comes with the Python dependencies as a static
binary; install a system ffmpeg and set `KROBI_FFMPEG_PATH` only if you need a
codec it lacks.

Check that the app imports as the service user before involving systemd:

```bash
cd /opt/krobi/backend
runuser -u krobi -- env HOME=/var/lib/krobi /opt/krobi/venv/bin/python -c "import app.main"
```

### 3. Environment file

```bash
install -d -m 0750 -o root -g krobi /etc/krobi
install -m 0640 -o root -g krobi \
  /opt/krobi/src/deploy/krobi-backend.env.example /etc/krobi/backend.env
$EDITOR /etc/krobi/backend.env
```

The template explains every line. systemd parses this file itself: no `export`,
no `$VAR` expansion, and a trailing space becomes part of the value. It is
`0640` because it will hold provider API keys.

Decide how the first account will be claimed (see step 6). If anyone else can
reach the server before you claim it, set `KROBI_REQUIRE_SETUP_TOKEN=true`.

### 4. Install and start the unit

```bash
install -m 0644 /opt/krobi/src/deploy/krobi-backend.service \
  /etc/systemd/system/krobi-backend.service
systemd-analyze verify /etc/systemd/system/krobi-backend.service
systemctl daemon-reload
systemctl enable --now krobi-backend
journalctl -u krobi-backend -f
```

Things in the unit that are deliberate:

- `RequiresMountsFor=` makes systemd wait for the music mount. Without it, a
  missing mount means the server creates an empty `Music` on the root
  filesystem and the next download fills it. Remove the line if the library is
  plain storage.
- `ProtectSystem=strict` makes everything read-only except the
  `ReadWritePaths=`. If downloads fail with `EROFS`, a path is missing there.
- Inside an **unprivileged container**, some sandboxing options can fail with
  `Failed to set up mount namespacing`. Comment out the sandboxing block,
  confirm the unit starts, then re-enable options one at a time.

### 5. Verify from another machine

A listening socket proves nothing; test from the machine you will use:

```bash
curl http://192.0.2.10:8000/api/health    # public: {"status":"ok", ...}
curl http://192.0.2.10:8000/api/status    # public: version, instanceId, name, isInit
curl -i http://192.0.2.10:8000/api/playlists   # no credential: must be 401
```

If the last one answers 200, the server is open to the network — check that
`KROBI_ALLOW_UNAUTHENTICATED_REMOTE` is not set.

### 6. Claim it and connect

On a fresh desktop install, choose **On another computer**. With
`KROBI_REQUIRE_SETUP_TOKEN=true`, copy the `krobi://…` setup link from the framed
setup block in `journalctl -u krobi-backend` and paste the
setup link into the Flipspin app's **Setup link** field. The separate code also
lives in `/var/lib/krobi/Krobi/setup-token`; it is never written to `krobi.log`.
Without required setup tokens, enter `your-server:8000` through the app's
address option. An unclaimed server is not in the list of nests on the network
— see [Finding the server on the LAN](#finding-the-server-on-the-lan).
On an app that already has a nest, use **Settings → Nest → Change nest**.
The app checks the server and asks you to create the first account, which
becomes the owner.

A new server is called "Nest" ("Nest" in English), never after an account or a
machine, because its name is public before sign-in. The owner renames it under
**Settings → Nest** (`PUT /api/server/name`).

For mobile today, use [OpenSubsonic apps](features/opensubsonic.md) with an
app password from the first-run wizard or **Settings → My account**. Native
Flipspin phone apps are coming soon. QR pairing in **Settings → My account**
remains available for sideloaded Flipspin clients.

### Updating

```bash
cd /opt/krobi/src && git pull
rsync -a --delete /opt/krobi/src/backend/ /opt/krobi/backend/
/opt/krobi/venv/bin/pip install -r /opt/krobi/backend/requirements-runtime.txt
systemctl restart krobi-backend
```

A restart briefly disconnects every client.

---

## Option B: Docker

The image is `ghcr.io/flipspin/flipspin-server`, built for `linux/amd64` and
`linux/arm64` (a Raspberry Pi 4/5, an ARM NAS, an Apple Silicon Mac under
Docker). Tags: `latest`, the release (`2.3.0`, `2.3`, `2`) and `sha-<commit>`.
It carries ffmpeg, yt-dlp and everything else the server needs.

Two volumes, nothing else:

| Mount | What lives there |
|---|---|
| `/data` | Flipspin's home: accounts, playlists, logs, the saved `.env`, caches, setup token |
| `/music` | your library (read-write: acquisitions, tag edits and deletes land here) |

### docker run

```bash
docker run -d --name krobi --hostname krobi --restart unless-stopped \
  -p 8000:8000 \
  -e PUID=1000 -e PGID=1000 \
  -v krobi-data:/data \
  -v /path/to/music:/music \
  ghcr.io/flipspin/flipspin-server
```

- **`PUID`/`PGID`** are the numeric owner of the music folder on the host
  (`ls -n /path/to/music`; `1000`/`1000` on most Linux installs, `99`/`100` on
  Unraid). The container starts as root only long enough to take that identity
  and to own `/data`, then runs the server as that user — never as root. It
  never changes ownership of `/music`; if that folder is not writable it says so
  in the log, and playback still works. `--user <uid>:<gid>` works too.
- The port is fixed at `8000` inside the container; map any host port to it.

### docker compose

The root `docker-compose.yml` runs the published image:

```bash
mkdir krobi && cd krobi
curl -fsSLO https://raw.githubusercontent.com/flipspin/flipspin/main/docker-compose.yml
cat > .env <<'EOF'
KROBI_IMAGE=ghcr.io/flipspin/flipspin-server:latest
KROBI_MUSIC_DIR=/path/to/music
PUID=1000
PGID=1000
EOF
docker compose up -d
docker compose logs flipspin | grep "krobi://"
```

or, as a snippet for a stack you already have:

```yaml
services:
  krobi:
    image: ghcr.io/flipspin/flipspin-server:latest
    container_name: krobi
    hostname: krobi
    restart: unless-stopped
    ports: ["8000:8000"]
    environment:
      PUID: "1000"
      PGID: "1000"
    volumes:
      - krobi-data:/data
      - /path/to/music:/music
volumes:
  krobi-data:
```

To build the image from a checkout instead, uncomment the `build:` block in
`docker-compose.yml` and run `docker compose up -d --build`.

Variables from [CONFIGURATION.md](CONFIGURATION.md) reach the server only if
they are passed to the container (`-e`, or the `environment:` list in
`docker-compose.yml` — setting one in `.env` alone does nothing there). The
provider keys, `KROBI_API_TOKEN` and `KROBI_ADVERTISE` are already listed.

### Claim it

A fresh server has no owner, and the image **requires the setup token** to
claim it (`KROBI_REQUIRE_SETUP_TOKEN=true`), so nobody else on the network can
take it first. For Docker-by-hand installs, the container log shows a framed
setup block at startup and at most
once every 10 minutes while unclaimed. No new blocks appear after the claim:

```bash
docker logs krobi 2>&1 | grep -A3 "krobi://"
#   krobi://<lan-ip>:8000/setup#<code>
#   Paste it in Flipspin → Setup link
#   Address: http://<lan-ip>:8000
#   Setup code: <code>
docker exec krobi cat /data/Krobi/setup-token      # same code
```

Copy and paste the setup link into the Flipspin app's **Setup link** field. With
Docker bridge networking, the printed host can be the container's address;
replace it with the server's LAN address and your published host port. The
code remains unchanged. The block is console-only: neither `krobi.log` nor
`/api/status` carries the code. Installer-managed nests can also run
`flipspin setup-link`; manual Docker installs use this log block. Once the server
has an owner the code is no longer needed and its file is removed.

### Updating

```bash
docker pull ghcr.io/flipspin/flipspin-server:latest
docker rm -f krobi        # then the same docker run as before
# or: docker compose pull && docker compose up -d
```

Everything that matters is in `/data` and `/music`; the container itself is
disposable. A restart briefly disconnects every client.

**From the older compose layout** (built locally, music at
`/data/Krobi/Music`): the new `docker-compose.yml` keeps the `krobi-state`
volume name, so accounts and playlists carry over, and reads the old
`KROBI_UID`/`KROBI_GID` as `PUID`/`PGID`. Playlists store absolute paths, so
keep the library where it was: add `KROBI_CONTAINER_MUSIC_DIR=/data/Krobi/Music`
and `KROBI_IMAGE=…` to `.env`, then `docker compose pull && docker compose up -d`
(the service is now called `krobi`, not `backend`).

### Network notes

- **LAN or VPN only.** Publish `8000` to your LAN; never port-forward it on your
  router. To limit it to one interface: `-p <SERVER_IP>:8000:8000`.
- On the default bridge network the container's LAN advertisement (below) does
  not reach your LAN — multicast usually needs host networking
  (`--network host`, then drop `-p`) — so desktops will not list this server
  by name. Connecting by its typed address works the same.

### Proxmox, Unraid, NAS

- **Proxmox:** run it with Docker inside a VM, or inside an LXC with
  `nesting=1` (Docker in LXC works, but a VM isolates better). An LXC
  *without* Docker is Option A. Either way, bind-mount the music into the guest
  and give the container the guest user's `PUID`/`PGID`.
- **Unraid:** `deploy/unraid/krobi-server.xml` is a Docker template. Copy it to
  `/boot/config/plugins/dockerMan/templates-user/` on the flash drive, then
  **Docker → Add Container** and pick *krobi-server*. Defaults:
  `/mnt/user/appdata/krobi` → `/data`, `PUID=99`, `PGID=100`.
- **Synology / TrueNAS / any Docker host:** the compose snippet above, with the
  share's path as the music volume.

---

## Let the nest process when no helper is online

`KROBI_NEST_PROCESSES` defaults to `false`. An owner can change it live in
Settings → Configuración, or pin it in the process environment like the other
server settings. `auto` engine placement still means local on macOS arm64 and
agent everywhere else; installing an engine on Linux does not change placement.

Install the engine first through the owner-only `POST /api/lyrics/engine/install`
(Linux x86_64 is supported). The setting returns `disabledReason: "no-engine"`
and "Falta el motor del server" until a CPU `check` reports installed job
capabilities. No engine is downloaded merely by enabling the setting.

In agent mode the backend registers one synthetic helper in `helpers.json`,
named after the nest, with `nest: true`, Linux/CPU and the installed engine's
CPU job capabilities. It uses the ordinary lyrics/stems leases and shared
ranking, always last, and reserves at most one song across both queues. For
each job's needs, it waits 600 seconds after the last eligible real helper
became unavailable (goodbye/revocation, or the 90-second presence timeout).
Busy eligible real helpers also block it. With no helper history it waits 600
seconds after enabling. A returning real helper lets the nest finish its
current song; the nest then stops claiming. Switching off abandons/requeues
the current lease and kills its child within the next 8-second heartbeat.
Queue wait reasons are unchanged when the switch is off. Claiming transitions
and their reasons are logged at INFO.

### systemd: delegate a subtree to the system service

The shipped service has `ProtectControlGroups=true`. To permit the optional
CPU helper, install the supplied drop-in, then reload and restart the service:

```sh
sudo install -d /etc/systemd/system/krobi-backend.service.d
sudo install -m 644 deploy/krobi-backend-nest-cpu.conf \
  /etc/systemd/system/krobi-backend.service.d/nest-cpu.conf
sudo systemctl daemon-reload
sudo systemctl restart krobi-backend
```

The drop-in sets `Delegate=cpu memory` (controller-specific `Delegate=yes`)
and `ProtectControlGroups=false`. It grants the service user `krobi` control
only of the service's delegated subtree. It does not enable the switch.
No root backend, sudo permission, user manager, login session, or D-Bus call
from the service is needed. In particular, `systemd-run --user` is not assumed
to work for a system unit running as `User=krobi`.

On cgroup v2 the backend moves itself to a `krobi-serving` leaf before
enabling CPU/memory controllers at its delegation root (the kernel forbids
internal processes there). Engine jobs go in the sibling `krobi-nest-engine`:
`cpu.weight=1`, `cpu.idle=1` where the kernel supports idle scheduling
(equivalent to `CPUWeight=idle`), and `memory.max` equal to half the available
RAM, respecting any tighter ancestor/container memory ceiling. On older
kernels the minimum CPU weight supplies low relative priority. These limits
apply to the entire engine subtree, while serving remains in its own leaf.
A small launcher joins the child before executing the engine; a failed join
cannot start model work. Shutdown also kills the child cgroup where
`cgroup.kill` is available, plus the engine process group.

### Docker / LXC: writable cgroup v2 delegation is required

The same child-cgroup mechanism runs inside a container when its current
cgroup is writable by the backend UID and delegates both `cpu` and `memory`.
It supports a cgroup namespace rooted at `/sys/fs/cgroup` as well as a nested
service path. The delegation root must contain only the backend process;
Flipspin refuses to move unrelated processes. An init supervisor must put the
backend in a dedicated delegated subtree before launching it if necessary.

Ordinary Docker/Compose mounts cgroups read-only, and an unprivileged LXC may
also withhold delegation. Those installs return `disabledReason: "no-cgroup"`
and "Este server no puede limitar el proceso"; the internal helper refuses to
register or run. The existing Compose deployment intentionally keeps that
default. An administrator must provision a writable, UID-owned delegated
subtree using the host/container manager before opting in. Do not expose the
whole host hierarchy or make the container privileged just for this feature.
Container-wide `--cpu-shares` alone limits serving and engine together and
does not satisfy child isolation. Neither does `nice` alone.

The probe writes and reads back the limits before any claim. cgroup v1 is
unsupported for this fallback and fails closed. A half-RAM cap may be too
small for a song even when the host meets the queue's 8 GiB requirement; an
OOM is an ordinary failed attempt, subject to the existing three-attempt
limit. CPU speed and memory needs on each nest remain unmeasured. Verify the
delegation and a real song manually on the target host before relying on it.

References: [systemd delegation and CPUWeight](https://www.freedesktop.org/software/systemd/man/254/systemd.resource-control.html),
[ProtectControlGroups](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html),
and the [kernel cgroup v2 rules](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).

## Finding the server on the LAN

Once it has an owner, the server announces itself over mDNS / DNS-SD as
`_krobi._tcp`, with its `instanceId`, `version` and `name` in the TXT record.
That is what fills the desktop's **Nests on your network** list. It is a
convenience: the typed address always works.

- **Never before the claim.** An unclaimed server is an open claim window, so it
  stays silent until the first account exists, then starts advertising without a
  restart. A rename re-announces it under the new name.
- **`KROBI_ADVERTISE=false`** turns it off (`-e KROBI_ADVERTISE=false` under
  Docker; `docker-compose.yml` already passes it through).
- A server started on loopback through its own entry point (`python -m app
  --host 127.0.0.1`, or the packaged binary) does not advertise. Plain `uvicorn`
  cannot tell the server its bind, so it advertises whatever its `--host`.
- **mDNS does not cross a VPN.** Away from home, over WireGuard or similar, type
  the address.
- It needs UDP 5353 multicast between the server and the desktops: a host
  firewall that drops it, or a Docker bridge network (above), means no listing.
- Check it from a Mac with `dns-sd -B _krobi._tcp`, or from Linux with
  `avahi-browse -rt _krobi._tcp`.

---

## Reverse proxies

The simplest correct setup is **no proxy**: clients talk to `:8000` directly
over the LAN or a VPN. If you add one anyway:

- **Disable response buffering** for `/api/download-progress-stream/`
  (Server-Sent Events). A buffering proxy makes every download look frozen until
  it finishes. For nginx: `proxy_buffering off; proxy_cache off;
  proxy_read_timeout 3600s; proxy_http_version 1.1;`.
- **Raise idle timeouts**; a long import streams for many minutes.
- **Do not log query strings.** Media and progress URLs can carry
  `?access_token=`; the server omits it from its own log, but a proxy logs the
  full request line by default.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Service active, other machines get "connection refused" | bound to `127.0.0.1` | `--host 0.0.0.0` |
| Unit crash-loops with `Configuration failed: …` | a data directory is not writable by `krobi` | fix ownership; run the import check in step 2 |
| Music directory shows `nobody:nogroup` | container uid mapping | chown the host directory to the mapped uid |
| Library empty, root filesystem filling up | music disk not mounted | keep `RequiresMountsFor=`; check `findmnt` |
| Downloads stuck at 0% while files appear | more than one worker, or a buffering proxy | `--workers 1`; see reverse proxies |
| Downloads fail with `EROFS` | path missing from `ReadWritePaths=` | add it |
| Settings saved in the app are forgotten on restart | `KROBI_CREDENTIALS_DIR` not under `$HOME/Krobi` | rule 3 above |
| Acquisition fails with "confirm you're not a bot" | the source is blocking the server | update the `yt-dlp` pin; then `KROBI_YTDLP_COOKIES_FILE` |
| Desktop app shows its sign-in screen | device token revoked, or server reset | sign in again from the app |
| Container log: `/music is not writable by …` | `PUID`/`PGID` do not own the music folder | set them to the folder's owner (`ls -n` on the host) |
| Desktop needs a setup link you never saw | the image requires one on a fresh server | `flipspin setup-link` for installer-managed nests; otherwise `docker logs krobi 2>&1 \| grep "krobi://"` |
| Server missing from the desktop's list of nests | not claimed yet, `KROBI_ADVERTISE=false`, a VPN, a firewall dropping UDP 5353, or a Docker bridge network | type its address; see "Finding the server on the LAN" |

```bash
docker logs --tail 200 krobi                    # Docker
journalctl -u krobi-backend -n 200 --no-pager   # systemd
tail -f /var/lib/krobi/Krobi/logs/krobi_errors.log
systemctl show krobi-backend -p Environment     # what systemd actually parsed
```
