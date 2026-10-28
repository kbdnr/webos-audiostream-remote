// Runs on the TV's own Node, which is 0.12 on webOS 4: keep this ES5 and avoid
// newer APIs (Object.assign, Buffer.alloc, fs.constants, ...).
var http = require('http');
var fs = require('fs');
var path = require('path');
var O_WRONLY = require('constants').O_WRONLY;
var url = require('url');
var spawn = require('child_process').spawn;
var execFile = require('child_process').execFile;

var SAMPLE_RATE = 48000;
var CHANNELS = 2;
var BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * 2;
var MAX_WAV_SECONDS = 600;

// --- Config ---
// Shared with the webOS service (service.js), which edits the config file and
// reads PIDFILE to know whether we're running.
var CONFIG_FILE = process.env.AUDIOSTREAM_CONFIG || '/home/root/.config/audiostream-remote/config.json';
var PIDFILE = '/tmp/audiostream-remote.pid';
var DEFAULTS = { port: 7070, audioDevice: 'hw:0,13', inputDevice: '/dev/input/event13' };

function merge(target, source) {
  Object.keys(source).forEach(function(k) { target[k] = source[k]; });
  return target;
}

function loadConfig() {
  var cfg = merge({}, DEFAULTS);
  try { merge(cfg, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch(e) {}
  return cfg;
}

// fs.mkdirSync's recursive option isn't available on Node 0.12
function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  fs.mkdirSync(dir);
}

function saveConfig(cfg) {
  mkdirp(path.dirname(CONFIG_FILE));
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

var config = null;
var startedAt = Date.now();
// Version on disk when this process started; the app compares it to spot a server left over from before an update
var version = null;
try { version = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch(e) {}

// --- Key injection via evdev ---
var inputFd = null;
var inputError = null;

function openInput() {
  try { inputFd = fs.openSync(config.inputDevice, O_WRONLY); } catch(e) {
    inputError = e.message;
    console.error('Cannot open ' + config.inputDevice + ': ' + e.message);
  }
}

function makeEvent(sec, usec, type, code, value) {
  // This kernel uses 16-byte input_event: u32 sec, u32 usec, u16 type, u16 code, s32 value
  var buf = new Buffer(16);
  buf.fill(0);
  buf.writeUInt32LE(sec & 0xFFFFFFFF, 0);
  buf.writeUInt32LE(usec & 0xFFFFFFFF, 4);
  buf.writeUInt16LE(type, 8);
  buf.writeUInt16LE(code, 10);
  buf.writeInt32LE(value, 12);
  return buf;
}

function sendKey(code) {
  if (!inputFd) return;
  var ms = Date.now();
  var sec = Math.floor(ms / 1000);
  var usec = (ms % 1000) * 1000;
  // EV_KEY press + EV_SYN
  fs.writeSync(inputFd, makeEvent(sec, usec, 1, code, 1));
  fs.writeSync(inputFd, makeEvent(sec, usec, 0, 0, 0));
  // Release after 50ms
  setTimeout(function() {
    var ms2 = Date.now();
    var sec2 = Math.floor(ms2 / 1000);
    var usec2 = (ms2 % 1000) * 1000;
    fs.writeSync(inputFd, makeEvent(sec2, usec2, 1, code, 0));
    fs.writeSync(inputFd, makeEvent(sec2, usec2, 0, 0, 0));
  }, 50);
}

var KEYS = {
  power: 116, home: 172, back: 158, exit: 174,
  up: 103, down: 108, left: 105, right: 106, ok: 352,
  vol_up: 115, vol_down: 114, mute: 113,
  ch_up: 402, ch_down: 403,
  play: 207, pause: 119, stop: 166, rw: 168, ff: 208,
  red: 398, green: 399, yellow: 400, blue: 401,
  info: 358, menu: 139, subtitle: 370,
  '0': 11, '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10
};

// --- Audio capture ---
// Each client is an object with write(chunk); the capture process runs while any are connected.
var clients = new Set();
var capture = null;
var captureError = null;
var lastStderr = '';

// LG's PCM upload API, for TVs whose mix never reaches ALSA or PulseAudio
var DILE_HELPER = path.join(__dirname, 'dile-capture');
var DILE_LIB = '/usr/lib/libdile_audio_pcm.so.1';

// "pulse:<source>" records a PulseAudio source (e.g. a sink's .monitor) with parec;
// "dile:<input>" taps the SoC's mixed output with dile-capture (see native/dile-capture.c);
// anything else is an ALSA device for arecord.
function captureCommand(device) {
  if (device.indexOf('dile:') === 0) {
    return [DILE_HELPER, ['-i', device.slice(5)]];
  }
  if (device.indexOf('pulse:') === 0) {
    return ['parec', ['--raw', '--format=s16le', '--rate=' + SAMPLE_RATE, '--channels=' + CHANNELS,
                      '-d', device.slice(6)]];
  }
  return ['arecord', ['-D', device, '-f', 'S16_LE', '-r', String(SAMPLE_RATE), '-c', String(CHANNELS),
                      '-t', 'raw', '-']];
}

function startCapture() {
  if (capture) return;
  var cmd = captureCommand(config.audioDevice);
  console.log('Starting capture from ' + config.audioDevice);
  lastStderr = '';
  var proc = capture = spawn(cmd[0], cmd[1]);
  proc.stdout.on('data', function(chunk) {
    captureError = null;
    clients.forEach(function(c) { try { c.write(chunk); } catch(e) {} });
  });
  proc.stderr.on('data', function(d) {
    var m = d.toString().trim();
    if (m) { lastStderr = m; console.log(cmd[0] + ': ' + m); }
  });
  proc.on('error', function(e) {
    captureError = cmd[0] + ': ' + e.message;
  });
  proc.on('close', function(code) {
    console.log(cmd[0] + ' exited: ' + code);
    if (capture !== proc) return; // stopped on purpose, maybe already restarted
    capture = null;
    if (code !== 0) {
      captureError = captureError || lastStderr || (cmd[0] + ' exited with code ' + code);
      // Tell listeners now rather than leaving them on a silent stream
      clients.forEach(function(c) { try { c.end(); } catch(e) {} });
      clients.clear();
    }
  });
}

function stopCapture() {
  if (!capture) return;
  console.log('Stopping capture');
  var proc = capture;
  capture = null;
  proc.kill();
}

// Switches the capture device; anyone listening carries on with the new source
function setAudioDevice(device) {
  var saved = loadConfig();
  saved.audioDevice = device;
  saveConfig(saved);
  config.audioDevice = device;
  captureError = null;
  stopCapture();
  if (clients.size) startCapture();
}

// --- Devices ---
// ALSA capture PCMs, PulseAudio sources and evdev input devices, for the settings screens.
function listDevices(cb) {
  var input = [];
  try {
    fs.readFileSync('/proc/bus/input/devices', 'utf8').split(/\n\s*\n/).forEach(function(block) {
      var name = /^N: Name="(.*)"$/m.exec(block);
      var ev = /^H: Handlers=.*\b(event\d+)\b/m.exec(block);
      if (ev) input.push({ id: '/dev/input/' + ev[1], name: name ? name[1] : ev[1] });
    });
  } catch(e) {}

  // ALSA capture PCMs, e.g. "00-13: MARS CAPTURE_TEST : MARS CAPTURE_TEST : capture 1".
  // Read from /proc rather than arecord -l so it works whatever arecord prints.
  var audio = [];
  try {
    fs.readFileSync('/proc/asound/pcm', 'utf8').split('\n').forEach(function(line) {
      var m = /^(\d+)-(\d+): ([^:]*?)\s*:.*\bcapture\b/.exec(line);
      if (m) audio.push({ id: 'hw:' + parseInt(m[1], 10) + ',' + parseInt(m[2], 10), name: m[3] });
    });
  } catch(e) {}

  // Input 0 is the one the TV's Bluetooth audio sender (btaudiosrc) uses
  if (fs.existsSync(DILE_LIB)) audio.push({ id: 'dile:0', name: 'TV output (LG DILE)' });

  // PulseAudio sources; a sink's ".monitor" source carries everything played to it,
  // so the sink's state (RUNNING while something plays) is the hint worth showing.
  pactlRows(['list', 'short', 'sinks'], function(err, sinks) {
    var sinkState = {};
    sinks.forEach(function(c) { sinkState[c[1]] = c[4]; });
    pactlRows(['list', 'short', 'sources'], function(err2, sources) {
      sources.forEach(function(c) {
        var sink = /\.monitor$/.test(c[1]) ? c[1].slice(0, -8) : null;
        audio.push({ id: 'pulse:' + c[1], name: sink ? 'Pulse monitor' : 'Pulse',
                     state: ((sink ? sinkState[sink] : c[4]) || '').toLowerCase() || null });
      });
      cb({ audio: audio, input: input, pulseError: err2 });
    });
  });
}

function pactlRows(args, cb) {
  execFile('pactl', args, { timeout: 3000 }, function(err, stdout, stderr) {
    var rows = (stdout || '').split('\n').map(function(l) { return l.split('\t'); })
      .filter(function(c) { return c[1]; });
    cb(err ? (String(stderr).trim() || err.message) : null, rows);
  });
}

// Records a moment from a device and reports how loud it was, for picking a source.
function probe(device, seconds, cb) {
  var want = Math.floor(seconds * SAMPLE_RATE) * CHANNELS * 2;
  var chunks = [], got = 0, done = false, stderr = '', proc = null, tap = null;
  var timer = setTimeout(function() { finish('No audio data within ' + (seconds + 3) + 's'); }, (seconds + 3) * 1000);

  function onData(chunk) {
    if (done) return;
    chunks.push(chunk);
    got += chunk.length;
    if (got >= want) finish();
  }

  function finish(error) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (tap && clients.has(tap)) {
      clients.delete(tap);
      if (!clients.size) stopCapture();
    }
    if (proc) proc.kill();
    got = Math.min(got, want);
    var buf = Buffer.concat(chunks, got);
    var peak = 0, sumSq = 0, n = Math.floor(buf.length / 2);
    for (var i = 0; i < n; i++) {
      var v = Math.abs(buf.readInt16LE(i * 2));
      if (v > peak) peak = v;
      sumSq += v * v;
    }
    cb({ device: device, seconds: got / BYTES_PER_SECOND, peak: peak / 32768,
         rms: n ? Math.sqrt(sumSq / n) / 32768 : 0, error: got ? null : (error || 'No audio data') });
  }

  // Already capturing this device for listeners: opening it a second time can fail, so listen in
  if (capture && device === config.audioDevice) {
    tap = { write: onData, end: function() { finish(captureError || 'Capture stopped'); } };
    clients.add(tap);
    return;
  }
  var cmd = captureCommand(device);
  proc = spawn(cmd[0], cmd[1]);
  proc.stdout.on('data', onData);
  proc.stderr.on('data', function(d) { stderr += d; });
  proc.on('error', function(e) { finish(cmd[0] + ': ' + e.message); });
  proc.on('close', function(code) { finish(stderr.trim() || (cmd[0] + ' exited with code ' + code)); });
}

function addClient(client, req) {
  clients.add(client);
  // Also retries after a failed capture, e.g. once the device has been fixed in Settings
  if (!capture) startCapture();
  req.on('close', function() { removeClient(client); });
}

function removeClient(client) {
  if (!clients.has(client)) return;
  clients.delete(client);
  console.log('Audio client disconnected (' + clients.size + ' left)');
  if (clients.size === 0) stopCapture();
}

function wavHeader(dataBytes) {
  var h = new Buffer(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(CHANNELS, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(BYTES_PER_SECOND, 28);
  h.writeUInt16LE(CHANNELS * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function timestamp() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + '_' +
         pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

// --- HTML ---
// The web remote page. Kept in its own file because webOS 4's Node (0.12) has no template strings.
var HTML = null;

function loadHtml() {
  HTML = fs.readFileSync(path.join(__dirname, 'remote.html'), 'utf8')
    .replace('__SAMPLE_RATE__', SAMPLE_RATE)
    .replace('__CHANNELS__', CHANNELS);
}

// --- HTTP server ---
function sendJson(res, code, obj) {
  res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(obj));
}

function handleRequest(req, res) {
  // Status for the TV app
  if (req.url === '/status') {
    sendJson(res, 200, {
      pid: process.pid,
      version: version,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      config: config,
      clients: clients.size,
      capturing: !!capture,
      captureError: captureError,
      inputOk: inputFd !== null,
      inputError: inputError
    });
    return;
  }

  // Change the capture device from the web page: {"audioDevice": "..."}
  if (req.method === 'POST' && req.url === '/config') {
    var body = '';
    req.on('data', function(d) { body += d; });
    req.on('end', function() {
      var p = null;
      try { p = JSON.parse(body); } catch(e) {}
      if (!p || typeof p.audioDevice !== 'string' || !p.audioDevice) {
        return sendJson(res, 400, { error: 'audioDevice is required' });
      }
      try { setAudioDevice(p.audioDevice); } catch(e) { return sendJson(res, 500, { error: e.message }); }
      console.log('Audio device set to ' + p.audioDevice + ' from the web page');
      sendJson(res, 200, { config: config });
    });
    return;
  }

  // Key press endpoint
  if (req.method === 'POST' && req.url.indexOf('/key/') === 0) {
    var keyName = req.url.slice(5);
    var code = KEYS[keyName];
    if (code !== undefined) {
      sendKey(code);
      res.writeHead(200, {'Content-Type': 'text/plain'});
      res.end('ok');
    } else {
      res.writeHead(404, {'Content-Type': 'text/plain'});
      res.end('unknown key');
    }
    return;
  }

  var parsed = url.parse(req.url, true);

  if (parsed.pathname === '/devices') {
    listDevices(function(d) {
      sendJson(res, 200, { audio: d.audio, pulseError: d.pulseError, current: config.audioDevice });
    });
    return;
  }

  // Short test recording: /probe?device=hw:0,13&seconds=1.5
  if (parsed.pathname === '/probe') {
    if (!parsed.query.device) return sendJson(res, 400, { error: 'device is required' });
    var probeSeconds = Math.min(Math.max(parseFloat(parsed.query.seconds) || 1.5, 0.5), 5);
    probe(String(parsed.query.device), probeSeconds, function(r) { sendJson(res, 200, r); });
    return;
  }

  // Raw PCM stream (S16LE, SAMPLE_RATE, CHANNELS) for the web page
  if (parsed.pathname === '/audio') {
    console.log('Audio client connected');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Content-Type-Options': 'nosniff'
    });
    addClient(res, req);
    return;
  }

  // Fixed-length WAV for scripts: curl -o clip.wav 'http://<tv>:7070/record.wav?seconds=30'
  if (parsed.pathname === '/record.wav') {
    var seconds = Math.min(parseFloat(parsed.query.seconds) || 10, MAX_WAV_SECONDS);
    var frameBytes = CHANNELS * 2;
    var remaining = Math.floor(seconds * SAMPLE_RATE) * frameBytes;
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': 44 + remaining,
      'Content-Disposition': 'attachment; filename="tv-' + timestamp() + '.wav"',
      'Cache-Control': 'no-store'
    });
    res.write(wavHeader(remaining));
    console.log('Recording ' + seconds + 's WAV');
    var client = {
      write: function(chunk) {
        if (remaining <= 0) return;
        var part = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
        remaining -= part.length;
        res.write(part);
        if (remaining <= 0) { res.end(); removeClient(client); }
      },
      end: function() { res.end(); }
    };
    addClient(client, req);
    return;
  }

  // Web UI
  res.writeHead(200, {'Content-Type': 'text/html'});
  res.end(HTML);
}

function removePidfile() {
  try { if (fs.readFileSync(PIDFILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PIDFILE); } catch(e) {}
}

function main() {
  config = loadConfig();
  loadHtml();
  openInput();

  var server = http.createServer(handleRequest);
  server.on('error', function(e) {
    console.error('Server error: ' + e.message);
    process.exit(1);
  });
  server.listen(config.port, '0.0.0.0', function() {
    fs.writeFileSync(PIDFILE, String(process.pid));
    console.log('TV Sampler: http://0.0.0.0:' + config.port);
  });

  process.on('exit', function() { stopCapture(); removePidfile(); });
  process.on('SIGTERM', function() { process.exit(0); });
  process.on('SIGINT', function() { process.exit(0); });
}

module.exports = { DEFAULTS: DEFAULTS, CONFIG_FILE: CONFIG_FILE, PIDFILE: PIDFILE, loadConfig: loadConfig,
                   saveConfig: saveConfig, listDevices: listDevices };

if (require.main === module) main();
