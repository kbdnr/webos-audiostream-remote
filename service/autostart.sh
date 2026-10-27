#!/bin/sh
# Start the TV audio stream + remote server at boot.
# Homebrew Channel runs everything in /var/lib/webosbrew/init.d on startup.
# The Audio Stream Remote app installs/removes this script from its
# "Start on boot" toggle; it can also be copied there by hand.

DAEMON=/media/developer/apps/usr/palm/services/io.github.kbdnr.audiostream.service/tv-stream.js
[ -f "$DAEMON" ] || DAEMON=/home/root/tv-audio-stream/tv-stream.js
[ -f "$DAEMON" ] || exit 0

PIDFILE=/tmp/audiostream-remote.pid
LOGFILE=/tmp/audiostream-remote.log

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    exit 0
fi

# Give the audio subsystem time to come up without blocking other init scripts
( sleep 5; exec nohup node "$DAEMON" >> "$LOGFILE" 2>&1 ) &
