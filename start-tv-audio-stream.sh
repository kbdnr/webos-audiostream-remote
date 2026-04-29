#!/bin/sh
# Start TV audio streaming server
# Streams audio from ALSA capture device over TCP and HTTP

SCRIPT=/home/root/tv-audio-stream/tv-stream.js
LOGFILE=/tmp/tv-audio-stream.log
PIDFILE=/tmp/tv-audio-stream.pid

# Kill existing instance
if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null
    rm -f "$PIDFILE"
fi

# Wait for audio subsystem to be ready
sleep 5

nohup node "$SCRIPT" > "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"
