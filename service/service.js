// Luna service for the Audio Stream Remote app.
//
// The streaming server itself (tv-stream.js) runs as a separate detached
// process so it outlives this service, which webOS stops when idle. This
// service starts/stops it, manages the boot script, and reports status.
// It needs root (via Homebrew Channel's elevate-service) to open the ALSA
// capture device and the evdev input device.

// Runs on the TV's own Node, which is 0.12 on webOS 4: keep this ES5 and avoid
// newer APIs (Object.assign, fs.mkdirSync's recursive option, ...).

var Service = require('webos-service');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var spawn = require('child_process').spawn;
var pkg = require('./package.json');
var daemon = require('./tv-stream.js');

var service = new Service(pkg.name);

var DAEMON = path.join(__dirname, 'tv-stream.js');
var AUTOSTART_SRC = path.join(__dirname, 'autostart.sh');
var AUTOSTART_DST = '/var/lib/webosbrew/init.d/audiostream-remote';
var LEGACY_AUTOSTART = '/var/lib/webosbrew/init.d/start-tv-audio-stream';
var LOGFILE = '/tmp/audiostream-remote.log';

// fs.mkdirSync's recursive option isn't available on older webOS Node builds
function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  fs.mkdirSync(dir);
}

function isRoot() {
  return process.getuid && process.getuid() === 0;
}

function runningPid() {
  try {
    var pid = parseInt(fs.readFileSync(daemon.PIDFILE, 'utf8'), 10);
    var cmdline = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
    if (cmdline.indexOf('tv-stream.js') !== -1) return pid;
  } catch (e) {}
  return null;
}

function fetchDaemonStatus(port, cb) {
  var req = http.get({ host: '127.0.0.1', port: port, path: '/status' }, function (res) {
    var body = '';
    res.on('data', function (d) { body += d; });
    res.on('end', function () {
      try { cb(JSON.parse(body)); } catch (e) { cb(null); }
    });
  });
  req.setTimeout(1000, function () { req.abort(); });
  req.on('error', function () { cb(null); });
}

function waitFor(check, timeoutMs, cb) {
  var deadline = Date.now() + timeoutMs;
  (function poll() {
    check(function (ok) {
      if (ok || Date.now() > deadline) return cb(ok);
      setTimeout(poll, 250);
    });
  })();
}

function addresses(port) {
  var urls = [];
  var ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(function (name) {
    ifaces[name].forEach(function (a) {
      if (a.family === 'IPv4' && !a.internal) urls.push('http://' + a.address + ':' + port);
    });
  });
  return urls;
}

function tailLog(lines) {
  try {
    var text = fs.readFileSync(LOGFILE, 'utf8').replace(/\s+$/, '');
    return text ? text.split('\n').slice(-lines) : [];
  } catch (e) {
    return [];
  }
}

function startDaemon(cb) {
  if (runningPid()) return cb(null);
  var config = daemon.loadConfig();
  // /tmp is RAM-backed; don't let the log grow forever across restarts
  try { if (fs.statSync(LOGFILE).size > 256 * 1024) fs.truncateSync(LOGFILE, 0); } catch (e) {}
  var out = fs.openSync(LOGFILE, 'a');
  var child = spawn(process.execPath, [DAEMON], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.closeSync(out);
  waitFor(function (done) {
    fetchDaemonStatus(config.port, function (s) { done(!!s); });
  }, 5000, function (ok) {
    cb(ok ? null : 'Server did not start, check the log');
  });
}

function stopDaemon(cb) {
  var pid = runningPid();
  if (!pid) return cb(null);
  try { process.kill(pid, 'SIGTERM'); } catch (e) {}
  waitFor(function (done) { done(!runningPid()); }, 3000, function (stopped) {
    if (stopped) return cb(null);
    try { process.kill(pid, 'SIGKILL'); } catch (e) {}
    setTimeout(function () { cb(runningPid() ? 'Could not stop server' : null); }, 300);
  });
}

function respondResult(message) {
  return function (err) {
    if (err) message.respond({ returnValue: false, errorText: err });
    else message.respond({ returnValue: true });
  };
}

function requireRoot(message) {
  if (isRoot()) return true;
  message.respond({ returnValue: false, errorCode: 'NOT_ROOT', errorText: 'Service is not running as root' });
  return false;
}

service.register('status', function (message) {
  var config = daemon.loadConfig();
  var pid = runningPid();
  var result = {
    returnValue: true,
    version: pkg.version,
    elevated: isRoot(),
    running: !!pid,
    pid: pid,
    autostart: fs.existsSync(AUTOSTART_DST),
    legacyAutostart: fs.existsSync(LEGACY_AUTOSTART),
    config: config,
    defaults: daemon.DEFAULTS,
    urls: addresses(config.port)
  };
  if (!pid) return message.respond(result);
  fetchDaemonStatus(config.port, function (s) {
    result.server = s;
    // Still running code from before the app was updated (older servers don't report a version)
    result.outdated = !!s && s.version !== pkg.version;
    message.respond(result);
  });
});

service.register('start', function (message) {
  if (!requireRoot(message)) return;
  startDaemon(respondResult(message));
});

service.register('stop', function (message) {
  if (!requireRoot(message)) return;
  stopDaemon(respondResult(message));
});

service.register('restart', function (message) {
  if (!requireRoot(message)) return;
  stopDaemon(function (err) {
    if (err) return respondResult(message)(err);
    startDaemon(respondResult(message));
  });
});

service.register('setAutostart', function (message) {
  if (!requireRoot(message)) return;
  try {
    if (message.payload.enabled) {
      mkdirp(path.dirname(AUTOSTART_DST));
      fs.writeFileSync(AUTOSTART_DST, fs.readFileSync(AUTOSTART_SRC));
      fs.chmodSync(AUTOSTART_DST, 493); // 0755
      // The old manual-install script would start a second copy on boot
      if (fs.existsSync(LEGACY_AUTOSTART)) fs.unlinkSync(LEGACY_AUTOSTART);
    } else if (fs.existsSync(AUTOSTART_DST)) {
      fs.unlinkSync(AUTOSTART_DST);
    }
    message.respond({ returnValue: true });
  } catch (e) {
    message.respond({ returnValue: false, errorText: e.message });
  }
});

service.register('setConfig', function (message) {
  if (!requireRoot(message)) return;
  var p = message.payload;
  var config = daemon.loadConfig();
  if (p.port !== undefined) {
    var port = parseInt(p.port, 10);
    if (!(port >= 1 && port <= 65535)) {
      return message.respond({ returnValue: false, errorText: 'Port must be 1-65535' });
    }
    config.port = port;
  }
  if (typeof p.audioDevice === 'string' && p.audioDevice) config.audioDevice = p.audioDevice;
  if (typeof p.inputDevice === 'string' && p.inputDevice) config.inputDevice = p.inputDevice;
  try {
    daemon.saveConfig(config);
    message.respond({ returnValue: true, config: config });
  } catch (e) {
    message.respond({ returnValue: false, errorText: e.message });
  }
});

// Lists capture and input devices for the settings screen.
service.register('devices', function (message) {
  daemon.listDevices(function (d) {
    message.respond({ returnValue: true, audio: d.audio, input: d.input });
  });
});

service.register('log', function (message) {
  message.respond({ returnValue: true, lines: tailLog(message.payload.lines || 40) });
});

// Called by the app right after elevate-service so the next request
// relaunches this service with root privileges.
service.register('terminate', function (message) {
  message.respond({ returnValue: true });
  setTimeout(function () { process.exit(0); }, 200);
});
