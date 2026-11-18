# Installing the desktop app

Flipspin's desktop app runs on **macOS**, **Windows** and **Linux**. It can either use a
nest (a Flipspin server) on another machine, or be the nest itself and run its own
copy of the server. The server and ffmpeg are bundled in the installer.

Before installing an update, read [Upgrading and backups](upgrading.md).

One exception: Flipspin ships no audio sources, so acquiring tracks needs a
source plugin on the nest. Install one with **Install** in **Settings → Sources →
Audio**, or add one in **Settings → Plugins** (see
[Source plugins](source-plugins.md)). Playing, browsing and everything else
work without one.

## macOS

1. Download the **Apple Silicon only** `.dmg` from the
   [latest release](https://github.com/flipspin/flipspin/releases/latest).
2. Open it and drag **Flipspin** into **Applications**.
3. Open Flipspin from Applications. The build is unsigned: if macOS blocks it,
   open **System Settings → Privacy & Security → Open Anyway**, then confirm.
   Repeat after an unsigned update if prompted. Right-click → Open no longer
   bypasses this block on current macOS.
4. macOS asks for **Local Network** access the first time the app looks for a
   nest or hosts one. Allow it — without it the app cannot find or reach a nest
   on another computer, and your other devices cannot reach the one on this
   computer. You can change it later in System Settings → Privacy & Security →
   Local Network.

## Windows

1. Download the latest installer (`.exe`) from the
   [latest release](https://github.com/flipspin/flipspin/releases/latest).
2. Run it. For the unsigned build, choose **More info → Run anyway** in
   SmartScreen, then follow the setup wizard. Repeat this on each unsigned update.
   With **Smart App Control** turned on, Windows may refuse an unsigned installer
   outright, with no option to run it. Wait a while and try again, or install on a
   PC where Smart App Control is off or in evaluation mode.
3. Open Flipspin from the Start menu. If Windows Defender Firewall asks whether the
   app may use the network, allow it on private networks.

## Linux

1. Download the x86_64 `.AppImage` or `.deb` from the
   [latest release](https://github.com/flipspin/flipspin/releases/latest).
   Use Ubuntu 22.04 or a newer compatible desktop.
2. On Debian/Ubuntu, run `sudo apt install ./Flipspin_*.deb` to install the package
   and its dependencies, then launch Flipspin from the application menu. Or run
   `chmod +x Flipspin_*.AppImage` followed by `./Flipspin_*.AppImage`.
3. If the AppImage reports a missing `libfuse.so.2` on Ubuntu 22.04, install
   `libfuse2`. Without FUSE, use `APPIMAGE_EXTRACT_AND_RUN=1 ./Flipspin_*.AppImage`.
   Other distributions need compatible glibc and desktop graphics libraries.

For source builds, see [PACKAGING.md](PACKAGING.md#linux-desktop-builds).

Both packages include the backend and FFmpeg; no Python installation is
required to run them. A Linux desktop can host its own nest or connect to
another. Allow TCP 8000 for a local nest and UDP 5353 for LAN discovery in
your firewall when needed; you can always type the nest's address.

The on-device lyrics/stems engine and its worker tray require Apple Silicon
macOS and are unavailable on Linux (`unsupported-platform`). Existing lyrics
and provider lyrics still work; a connected Apple Silicon Mac can process
the nest's generated lyrics/stems jobs. Linux uses the hostname as its device
name and has no Mac sleep hook or macOS Local Network permission prompt.

## A nest on a server (Docker, one line)

To keep the nest on a machine that stays on — a home server, a NAS, a Raspberry
Pi — run the server image there (amd64 or arm64) instead of hosting it on this
computer:

```bash
docker run -d --name krobi --hostname krobi --restart unless-stopped \
  -p 8000:8000 -v krobi-data:/data -v /path/to/music:/music \
  ghcr.io/flipspin/flipspin-server
docker logs krobi 2>&1 | grep "krobi://"
```

The last command prints the setup link from the framed setup block in the log. Copy the
`krobi://<host>:<port>/setup#<code>` line and paste the setup link into the Flipspin
app's **Setup link** field to create the first account. The address and code
also appear separately for typing by hand. The block appears at boot and every
10 minutes until the nest is claimed; the code stays out of file logs and API
responses. With a Docker bridge or a different published port, replace the
link's host and port with the server's LAN address and published host port.

If you used [the Linux installer](deployment.md#in-one-line-linux), run
`flipspin setup-link` to print the link again while the nest is unclaimed. After
setup it prints “This nest is already set up.” Docker-by-hand installs use
the log block above. Or with Docker Compose:

```yaml
services:
  krobi:
    image: ghcr.io/flipspin/flipspin-server:latest
    hostname: krobi
    restart: unless-stopped
    ports: ["8000:8000"]
    environment: { PUID: "1000", PGID: "1000" }   # owner of the music folder
    volumes:
      - krobi-data:/data
      - /path/to/music:/music
volumes:
  krobi-data:
```

Keep it on your home network or behind a VPN into it — never forward port 8000
on your router. Updating, Unraid, Proxmox and the rest:
[deployment.md](deployment.md#option-b-docker).

## First launch

Flipspin keeps your music, playlists and accounts in one place: the **nest** — in
code and in the server docs, the Flipspin server. The first screen asks
**Where's your nest?** ("¿Dónde está tu server?"):

- **On this computer** — this computer becomes the nest. The app starts its
  bundled server and keeps everything in `~/Krobi/` (`%USERPROFILE%\Krobi` on
  Windows). Your other devices can connect to it over your home network.
  For mobile today, use [OpenSubsonic apps](features/opensubsonic.md) with an
  app password from the wizard or **Settings → My devices**; native Flipspin iOS
  and Android apps are coming soon, not released with v0.1.0.
- **On another computer** — a nest already runs somewhere at home. The app lists
  the nests it finds on your network (**Nests on your network**); pick yours. If
  it is not listed, choose **Not listed? Type its address.** and enter it, for
  example `your-server:8000`. Away from home, over a VPN, the list stays empty —
  discovery does not cross a VPN — so type the address. The app checks the nest
  before changing anything and restarts into it.

Then you **create an account** — a username and a password of at least 10
characters. On a new nest the first account becomes its owner; on a nest that
already has accounts you get a sign-in screen instead, and use the account the
owner created for you. Signing in names the device after your computer, so the
owner's device list reads like the machines in the house.

On a nest on this computer, one last screen, **Your music**, asks once where your
music lives: keep `Krobi/Music` or choose another folder inside your home
folder. Put albums there, one folder per album; the library starts empty. You
can change the folder later in **Settings → Library → Music folder**.

To move to another nest later, use **Settings → Status → Change nest**. To run a
nest on a server of its own, see [deployment.md](deployment.md).

The interface follows your system language (Spanish or English); change it in
**Settings → General → Language**.

Acquiring music from the sources you configure is your action: you are
responsible for respecting copyright and each source's terms of service.

## A Mac for the nest (lyrics and stems)

Transcribing lyrics, syncing them to the voice and splitting songs into stems
run on Apple Silicon. A nest on a Mac with Apple Silicon does it by itself. A
nest on Linux, Windows or an Intel Mac needs **one Mac with Apple Silicon on
your network** to do it for the nest:

1. Install the desktop app on that Mac (above).
2. Sign in to your nest from it.
3. Install the engine in **Settings → Features → Engines**; this turns on
   "Process for the nest". It downloads the engine and its models (about 4 GB).

From then on, that Mac works through the nest's lyrics and stems queue
whenever the app is open on it. It does not run as a background service: quit
the app and the work waits until you open it again. While a job runs, the Mac
does not go to sleep. A menu-bar icon shows what it is doing.

Several computers can work for one nest. An admin sees each one's state in
**Settings → Helpers**:
working, idle, asleep, app closed, offline or outdated, with its chip, memory
and macOS version. Songs waiting for a Mac show there with how long the oldest
has waited.

If the switch says **Network permission missing**, allow the app in **System
Settings → Privacy & Security → Local Network**, then reopen it.

## Where things are

| | macOS / Linux | Windows |
|---|---|---|
| Library, playlists, accounts (nest on this computer) | `~/Krobi/` | `%USERPROFILE%\Krobi\` |
| Server logs | `~/Krobi/logs/` | `%USERPROFILE%\Krobi\logs\` |

**Settings → Log** shows the server's log from inside the app. See
[observability.md](observability.md) for what to look for.

## Uninstalling

- **macOS**: quit Flipspin and delete it from Applications.
- **Windows**: Settings → Apps → Flipspin → Uninstall.
- **Linux**: remove the Debian package with `sudo apt remove <package-name>`
  (`dpkg-deb -f ./Flipspin_*.deb Package` prints its name), or delete the AppImage.

Your music and data in `Krobi/` are left alone; delete that folder too if you
want them gone.
