#!/bin/sh
# Read-only report on the Audio Stream Remote service, for when the app says
# "Service not responding". Run as root over SSH, or from the app's
# "Run diagnostics" button (which runs it through Homebrew Channel).
# Nothing here changes the system except a 5 second test run of the service
# and 1 second test recordings from each capture device.

ID=io.github.kbdnr.audiostream.service
DIR=/media/developer/apps/usr/palm/services/$ID

section() { echo; echo "== $1"; }

# Run a command for at most $1 seconds (busybox may not have timeout)
run_for() {
    secs=$1; shift
    "$@" &
    pid=$!
    ( sleep "$secs"; kill "$pid" 2>/dev/null ) &
    watcher=$!
    wait "$pid" 2>/dev/null
    status=$?
    kill "$watcher" 2>/dev/null
    return $status
}

section "system"
uname -a
id
echo "node: $(command -v node) $(node -v 2>&1)"
[ -f /var/run/nyx/os_info.json ] && grep -E '"webos_(release|build_id)"' /var/run/nyx/os_info.json

section "service files"
ls -la "$DIR" 2>&1

section "luna-service2 registration"
found=$(grep -rl "$ID" /var/luna-service2-dev /var/luna-service2 /usr/share/luna-service2 2>/dev/null)
if [ -z "$found" ]; then
    echo "No luna-service2 files mention $ID (the service was never registered)"
else
    for f in $found; do
        echo "-- $f"
        cat "$f"
        echo
    done
fi

section "running processes"
ps -ef 2>/dev/null | grep -E "audiostream|tv-stream" | grep -v grep || ps | grep -E "audiostream|tv-stream" | grep -v grep

section "syntax check"
# node --check doesn't exist on webOS 4's Node 0.12; compiling with vm works everywhere
for f in service.js tv-stream.js; do
    node -e "var f=process.argv[1]; new (require('vm').Script)(require('fs').readFileSync(f, 'utf8'), f)" "$DIR/$f" 2>&1 && echo "$f ok"
done

section "luna-send status (5s)"
run_for 5 luna-send -n 1 -f "luna://$ID/status" '{}' 2>&1 || echo "(no reply / exit $?)"

section "test run of service.js (5s, crashes print here)"
( cd "$DIR" && run_for 5 node service.js ) 2>&1
echo "(exit $?; 143 means it was still running after 5s, i.e. it didn't crash)"

section "audio devices"
cat /proc/asound/cards 2>&1
echo "-- capture PCMs (/proc/asound/pcm)"
grep capture /proc/asound/pcm 2>&1
echo "-- /dev/snd"
ls /dev/snd 2>&1
echo "-- arecord -L"
arecord -L 2>&1 | head -40
echo "-- PulseAudio"
for t in parec pacat pactl; do echo "$t: $(command -v $t || echo missing)"; done
command -v pactl >/dev/null && { pactl list short sources 2>&1; pactl list short sinks 2>&1; }

# Records 1s from each capture device and prints how much came back and how loud it was.
# Play something on the TV while this runs: the device with a non-zero peak is the one to use.
peak() {
    node -e "var b=require('fs').readFileSync(process.argv[1]),p=0;for(var i=0;i+1<b.length;i+=2){var v=Math.abs(b.readInt16LE(i));if(v>p)p=v;}console.log(b.length+' bytes, peak '+p+'/32767')" "$1" 2>&1
}
section "1 second test recordings (play audio on the TV now)"
grep capture /proc/asound/pcm 2>/dev/null | sed -n 's/^\([0-9]*\)-\([0-9]*\):.*/\1 \2/p' | while read card dev; do
    d="hw:$(expr "$card" + 0),$(expr "$dev" + 0)"
    rm -f /tmp/as-test.raw
    run_for 4 arecord -D "$d" -f S16_LE -r 48000 -c 2 -d 1 -t raw /tmp/as-test.raw 2>/tmp/as-test.err
    if [ -s /tmp/as-test.raw ]; then echo "$d: $(peak /tmp/as-test.raw)"; else echo "$d: failed: $(tail -1 /tmp/as-test.err)"; fi
done
if command -v parec >/dev/null && command -v pactl >/dev/null; then
    pactl list short sources 2>/dev/null | cut -f2 | while read src; do
        rm -f /tmp/as-test.raw
        run_for 1 sh -c "exec parec --raw --format=s16le --rate=48000 --channels=2 -d '$src' > /tmp/as-test.raw" 2>/tmp/as-test.err
        if [ -s /tmp/as-test.raw ]; then echo "pulse:$src: $(peak /tmp/as-test.raw)"; else echo "pulse:$src: failed: $(tail -1 /tmp/as-test.err)"; fi
    done
fi
if [ -x "$DIR/dile-capture" ] && [ -f /usr/lib/libdile_audio_pcm.so.1 ]; then
    rm -f /tmp/as-test.raw
    run_for 4 "$DIR/dile-capture" -i 0 -t 1 > /tmp/as-test.raw 2>/tmp/as-test.err
    if [ -s /tmp/as-test.raw ]; then echo "dile:0: $(peak /tmp/as-test.raw)"; else echo "dile:0: failed: $(tail -1 /tmp/as-test.err)"; fi
fi
rm -f /tmp/as-test.raw /tmp/as-test.err

section "system log"
grep -iE "audiostream|run-js-service" /var/log/messages 2>/dev/null | tail -25

section "server log"
if [ -f /tmp/audiostream-remote.log ]; then
    tail -20 /tmp/audiostream-remote.log
else
    echo "No server log yet (the streaming server has never been started on this boot)"
fi
