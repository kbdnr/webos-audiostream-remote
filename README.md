# webOS TV Audio Stream + Remote

Stream audio output from a rooted LG webOS TV to any browser on your network, and control the TV with a web-based remote. Runs a single Node.js server directly on the TV with zero dependencies.

Works regardless of the TV's audio output setting -- speakers, Bluetooth, HDMI ARC, optical, etc.

## Requirements

- Rooted LG webOS TV (tested on webOS 7.4.0)
- SSH access to the TV (default password: `alpine`)

## How it works

**Audio:** The TV's Realtek SoC exposes ALSA capture devices that tap the internal audio bus. `hw:0,13` (MARS CAPTURE_TEST) provides a copy of all audio being played, before it's routed to any output. The server spawns `arecord` to capture from this device and streams raw S16LE/48000Hz/stereo PCM over HTTP. The browser decodes and plays it using the Web Audio API.

**Remote:** Key events are injected via `/dev/input/event13` (LGE Network Input), the same evdev device the TV uses for its own network-based input. Supports power, navigation, volume, channels, media controls, number pad, and colour buttons.

## Install

Copy the files to the TV:

```sh
ssh root@<TV_IP> "mkdir -p /home/root/tv-audio-stream /var/lib/webosbrew/init.d"
scp tv-stream.js root@<TV_IP>:/home/root/tv-audio-stream/tv-stream.js
scp start-tv-audio-stream.sh root@<TV_IP>:/var/lib/webosbrew/init.d/start-tv-audio-stream
ssh root@<TV_IP> "chmod +x /var/lib/webosbrew/init.d/start-tv-audio-stream"
```

The startup script in `/var/lib/webosbrew/init.d/` runs automatically on boot if you have Homebrew Channel installed.

To start manually:

```sh
ssh root@<TV_IP> "node /home/root/tv-audio-stream/tv-stream.js &"
```

## Usage

Open `http://<TV_IP>:7070` in a browser.

## Notes

- The ALSA capture device (`hw:0,13`) is shared -- it doesn't interfere with Bluetooth audio or any other output.
- Audio capture only starts when a client connects and stops when all clients disconnect.
- The server supports multiple simultaneous clients.
- The `hw:0,13` device index and `/dev/input/event13` may differ on other TV models. Run `arecord -l` and check `/dev/input/by-id/` over SSH to find the right devices.
