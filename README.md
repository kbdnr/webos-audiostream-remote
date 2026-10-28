# webOS TV Audio Stream + Remote

Record whatever a rooted LG webOS TV is playing, as WAV, from any browser on your network, plus a web remote for the TV. A single dependency-free Node server runs on the TV itself, and it works with any audio output (speakers, Bluetooth, HDMI ARC, optical).

## Requirements

- Rooted LG webOS TV with Homebrew Channel (tested on webOS 7.4.0 and 4.10)
- The service targets the TV's own Node (0.12 on webOS 4), so it's written in ES5

## Install

1. Get `io.github.kbdnr.audiostream_<version>_all.ipk` from Releases, or build it (below).
2. Install it with [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop) or `ares-install -d <device> <ipk>`.
3. Open **Audio Stream Remote** on the TV, press **Grant root access** (once per install/update), then **Start**. Optionally enable **Start on boot**.

The TV app shows the server status, the URL to open, the log, and a **Settings** card for picking the capture and input devices.

## Usage

Open `http://<TV_IP>:7070`:

- **Record** (Space) starts/stops a clip.
- **Arm** buffers the last 60 s; **Save last 10/30/60 s** (keys 1–3) turns it into a clip.
- **Monitor** (M) plays the TV's audio locally.
- Clips are stored in the browser with a waveform and can be renamed or downloaded as WAV.
- The TV remote is at the bottom of the page.

From a script:

```sh
curl -o clip.wav 'http://<TV_IP>:7070/record.wav?seconds=30'   # up to 600 s
```

Audio is 16-bit stereo PCM at 48 kHz. Capture runs only while a client is connected.

## Capture device

The right device varies by TV. Play something, open **Audio source** on the web page, press **Scan all**, then **Use** on a device that shows a level. The choice is saved and applied immediately.

- `hw:X,Y` — ALSA capture (e.g. `hw:0,13` on webOS 7)
- `pulse:<source>` — a PulseAudio source such as a sink's `.monitor`
- `dile:0` — for SoCs with no capture device (e.g. LG O18 / lg115x). Uses LG's DILE PCM upload API through the bundled `dile-capture` helper (`native/dile-capture.c`). Pass-through Dolby output may come through silent.

The remote injects key events via an evdev input device (`/dev/input/event13` by default), also selectable in Settings.

## Files on the TV

| Path | What |
| --- | --- |
| `/media/developer/apps/usr/palm/services/io.github.kbdnr.audiostream.service/` | service, `tv-stream.js`, `dile-capture` |
| `/var/lib/webosbrew/init.d/audiostream-remote` | boot script (when Start on boot is on) |
| `/home/root/.config/audiostream-remote/config.json` | settings |
| `/tmp/audiostream-remote.log`, `.pid` | log and PID |

## Build

```sh
npm install
npm run native     # cross-compile dile-capture (needs podman or docker)
npm run build      # bump patch version, build dist/*.ipk + manifest
npm run package    # build without bumping
npm run watch      # dev rebuild on save
npm run deploy && npm run launch   # TV=<device> to override target
npm run serve      # preview at http://127.0.0.1:8765 with fake service responses
```

`npm run build` fails if non-ES5 code or CSS unsupported by Chromium 53 ends up in the output. For a minor/major release, run `npm version minor` then push the `v*` tag; GitHub Actions builds the IPK and attaches it to the release.

```
frontend/  TV app
service/   luna service, streaming server, web page, boot and diagnostic scripts
native/    dile-capture helper
scripts/   build tooling
```
