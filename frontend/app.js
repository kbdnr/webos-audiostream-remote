// Audio Stream Remote - TV app.
// Talks to io.github.kbdnr.audiostream.service over luna. Written as ES5 so
// it runs on the older Chromium builds in webOS 3/4 as well as newer TVs.

var SERVICE_ID = 'io.github.kbdnr.audiostream.service';
var SERVICE = 'luna://' + SERVICE_ID + '/';
var HBCHANNEL_EXEC = 'luna://org.webosbrew.hbchannel.service/exec';
var ELEVATE_CMD = '/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service ' + SERVICE_ID;
var DIAGNOSE_CMD = 'sh /media/developer/apps/usr/palm/services/' + SERVICE_ID + '/diagnose.sh 2>&1 | tee /tmp/audiostream-diagnostics.txt';
var POLL_MS = 3000;
var CALL_TIMEOUT_MS = 10000;

var $ = function (id) { return document.getElementById(id); };

// --- Luna calls ---

var pendingBridges = []; // keep references so bridges aren't garbage collected mid-call

// If a service fails to launch (e.g. it crashes on startup), the hub never
// answers, so give up after CALL_TIMEOUT_MS instead of waiting forever.
function luna(uri, params, timeoutMs) {
  if (!window.PalmServiceBridge) return mockLuna(uri, params || {});
  return new Promise(function (resolve, reject) {
    var bridge = new PalmServiceBridge();
    pendingBridges.push(bridge);
    var done = false;
    var finish = function () {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      pendingBridges.splice(pendingBridges.indexOf(bridge), 1);
      return true;
    };
    var timer = setTimeout(function () {
      if (finish()) reject({ returnValue: false, errorCode: 'TIMEOUT', errorText: 'No response from ' + uri });
    }, timeoutMs || CALL_TIMEOUT_MS);
    bridge.onservicecallback = function (msg) {
      if (!finish()) return;
      var res;
      try { res = JSON.parse(msg); } catch (e) { res = { returnValue: false, errorText: String(msg) }; }
      if (res.returnValue === false) reject(res); else resolve(res);
    };
    bridge.call(uri, JSON.stringify(params || {}));
  });
}

function call(method, params) {
  return luna(SERVICE + method, params);
}

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// --- State ---

var svc = null; // service status (not `status`, which is window.status in browsers)
var devices = null;
var settings = null; // pending edits on the settings card
var busy = false;
var polling = false;
var unreachable = false; // last status call failed
var showingDiagnostics = false; // log card holds diagnostics output instead of the server log
var autoRestarted = false; // restarted an outdated server once this session

function setMessage(text, isError) {
  $('message').textContent = text || '';
  $('message').className = 'message' + (isError ? ' err' : '');
}

function errText(e) {
  return (e && (e.errorText || e.message)) || 'Unknown error';
}

function formatUptime(s) {
  var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

// --- Rendering ---

function detail(dl, label, value, cls) {
  var dt = document.createElement('dt');
  var dd = document.createElement('dd');
  dt.textContent = label;
  dd.textContent = value;
  if (cls) dd.className = cls;
  dd.title = value;
  dl.appendChild(dt);
  dl.appendChild(dd);
}

function render() {
  var s = svc;
  var dl = $('details');
  dl.innerHTML = '';

  if (!s) {
    $('dot').className = 'dot err';
    $('stateText').textContent = 'Service not responding';
    // A service that crashes when launched jailed may still work elevated
    $('elevateBox').hidden = false;
    $('elevateBtn').disabled = busy;
    $('diagBtn').hidden = false;
    $('diagBtn').disabled = busy;
    $('actions').hidden = true;
    $('settings').hidden = true;
    $('urlBox').hidden = true;
    return;
  }

  $('version').textContent = 'v' + s.version;
  $('elevateBox').hidden = s.elevated;
  $('elevateBtn').disabled = busy;
  $('diagBtn').hidden = true;
  $('actions').hidden = !s.elevated;
  $('settings').hidden = !s.elevated;

  if (!s.elevated) {
    $('dot').className = 'dot err';
    $('stateText').textContent = 'Root access needed';
    $('urlBox').hidden = true;
    return;
  }

  $('dot').className = 'dot ' + (s.running ? 'ok' : 'off');
  $('stateText').textContent = s.running ? 'Running' : 'Stopped';

  $('urlBox').hidden = !s.running || !s.urls.length;
  $('url').textContent = s.urls[0] || '';
  $('urlAlt').textContent = s.urls.slice(1).join('   ');

  var srv = s.server;
  if (s.running) {
    detail(dl, 'PID', String(s.pid));
    if (srv) {
      if (s.outdated) {
        detail(dl, 'Version', 'Server is ' + (srv.version || 'an older version') + ', app is ' + s.version +
               (srv.clients ? ': press Restart when nobody is listening' : ': restarting…'), 'err');
      }
      detail(dl, 'Uptime', formatUptime(srv.uptime));
      detail(dl, 'Listeners', String(srv.clients));
      detail(dl, 'Capturing', srv.capturing ? 'Yes' : 'No (idle until someone listens)', srv.capturing ? 'ok' : '');
      if (srv.captureError) detail(dl, 'Capture error', srv.captureError, 'err');
      detail(dl, 'Audio device', srv.config.audioDevice);
      detail(dl, 'Input device', srv.config.inputDevice + (srv.inputOk ? '' : ': ' + srv.inputError),
             srv.inputOk ? 'ok' : 'err');
    } else {
      detail(dl, 'Server', 'Not responding on port ' + s.config.port, 'err');
    }
  } else {
    detail(dl, 'Port', String(s.config.port));
    detail(dl, 'Audio device', s.config.audioDevice);
    detail(dl, 'Input device', s.config.inputDevice);
  }
  if (s.legacyAutostart) {
    detail(dl, 'Old boot script', 'start-tv-audio-stream found; enabling Start on boot replaces it', 'err');
  }

  var toggle = $('toggleBtn');
  toggle.textContent = s.running ? 'Stop' : 'Start';
  toggle.className = s.running ? 'running' : 'primary';
  $('restartBtn').disabled = busy || !s.running;
  toggle.disabled = busy;

  var auto = $('autostartBtn');
  auto.className = 'toggle' + (s.autostart ? ' on' : '');
  auto.innerHTML = 'Start on boot: <b>' + (s.autostart ? 'On' : 'Off') + '</b>';
  auto.disabled = busy;

  if (!settings) {
    settings = { port: s.config.port, audioDevice: s.config.audioDevice, inputDevice: s.config.inputDevice };
    $('port').value = settings.port;
    renderChips();
  }
  $('saveBtn').disabled = busy;
  $('resetBtn').disabled = busy;
}

function renderChips() {
  if (!settings) return;
  chips($('audioChips'), devices ? devices.audio : [], 'audioDevice');
  chips($('inputChips'), devices ? devices.input : [], 'inputDevice');
}

function chips(container, list, key) {
  // Keep focus on the same chip when re-rendering
  var focusedId = document.activeElement && document.activeElement.parentNode === container
    ? document.activeElement.getAttribute('data-id') : null;
  container.innerHTML = '';
  var ids = list.map(function (d) { return d.id; });
  if (ids.indexOf(settings[key]) === -1) list = [{ id: settings[key], name: 'current' }].concat(list);
  if (!devices) {
    var note = document.createElement('span');
    note.className = 'empty';
    note.textContent = 'Detecting devices…';
    container.appendChild(note);
  }
  list.forEach(function (d) {
    var b = document.createElement('button');
    b.textContent = d.id.replace('/dev/input/', '') + ' · ' + d.name;
    b.setAttribute('data-id', d.id);
    if (d.id === settings[key]) b.className = 'selected';
    b.onclick = function () { settings[key] = d.id; renderChips(); };
    container.appendChild(b);
    if (d.id === focusedId) b.focus();
  });
}

function ensureFocus() {
  var el = document.activeElement;
  if (el && el !== document.body && el.offsetParent !== null) return;
  var list = focusables();
  if (list.length) list[0].focus();
}

// --- Polling ---

function refresh() {
  if (polling) return Promise.resolve();
  polling = true;
  return call('status').then(function (s) {
    svc = s;
    if (unreachable) setMessage('');
    unreachable = false;
    if (s.elevated && !devices) loadDevices();
    // After an update the old server keeps running (and serving the old web page) until restarted
    if (s.outdated && s.server && !s.server.clients && !autoRestarted && !busy) {
      autoRestarted = true;
      setTimeout(function () {
        run('Restarting the server to load the update', function () { return call('restart'); });
      }, 0);
    }
  }, function (e) {
    svc = null;
    unreachable = true;
    setMessage('Could not reach service: ' + errText(e), true);
  }).then(function () {
    polling = false;
    render();
    ensureFocus();
    if (svc && svc.elevated) return refreshLog();
  });
}

function refreshLog() {
  if (showingDiagnostics) return Promise.resolve();
  return call('log', { lines: 30 }).then(function (r) {
    $('log').textContent = r.lines.length ? r.lines.join('\n') : 'No log yet.';
  }, function () {});
}

function loadDevices() {
  devices = { audio: [], input: [] }; // avoid re-requesting while in flight
  call('devices').then(function (d) {
    devices = d;
    renderChips();
  }, function () {});
}

// --- Actions ---

function run(label, fn) {
  if (busy) return;
  busy = true;
  setMessage(label + '…');
  render();
  fn().then(function () {
    setMessage('');
  }, function (e) {
    setMessage(label + ' failed: ' + errText(e), true);
  }).then(function () {
    busy = false;
    return refresh();
  });
}

$('toggleBtn').onclick = function () {
  var stop = svc && svc.running;
  run(stop ? 'Stopping' : 'Starting', function () { return call(stop ? 'stop' : 'start'); });
};

$('restartBtn').onclick = function () {
  run('Restarting', function () { return call('restart'); });
};

$('autostartBtn').onclick = function () {
  var enable = !(svc && svc.autostart);
  run(enable ? 'Enabling start on boot' : 'Disabling start on boot', function () {
    return call('setAutostart', { enabled: enable });
  });
};

$('elevateBtn').onclick = function () {
  run('Requesting root access', function () {
    return luna('luna://org.webosbrew.hbchannel.service/exec', { command: ELEVATE_CMD })
      // Restart the service so the next call runs it as root
      .then(function () { return call('terminate').catch(function () {}); })
      .then(function () { return wait(1500); });
  });
};

$('diagBtn').onclick = function () {
  run('Running diagnostics (about 15s)', function () {
    var show = function (r) {
      var out = ((r && r.stdoutString) || '') + ((r && r.stderrString) || '');
      showingDiagnostics = true;
      $('logTitle').textContent = 'Diagnostics';
      $('log').className = 'diag';
      $('log').textContent = out || errText(r);
      $('log').scrollTop = 0;
      $('log').tabIndex = 0;
      $('log').focus(); // so up/down scroll the report straight away
    };
    // exec rejects on a non-zero exit, but the report is still in stdoutString
    return luna(HBCHANNEL_EXEC, { command: DIAGNOSE_CMD }, 60000).then(show, function (e) {
      show(e);
      if (!e.stdoutString) throw e;
    });
  });
};

$('saveBtn').onclick = function () {
  settings.port = $('port').value;
  run('Saving settings', function () {
    return call('setConfig', settings).then(function () {
      settings = null; // re-read from the saved config
      if (svc && svc.running) return call('restart');
    });
  });
};

$('resetBtn').onclick = function () {
  if (!svc) return;
  var d = svc.defaults;
  settings = { port: d.port, audioDevice: d.audioDevice, inputDevice: d.inputDevice };
  $('port').value = d.port;
  renderChips();
  setMessage('Defaults loaded. Press "Save & restart" to apply.');
};

// --- Remote control navigation ---

function focusables() {
  return [].filter.call(document.querySelectorAll('button, input, [tabindex="0"]'), function (el) {
    return !el.disabled && el.offsetParent !== null;
  });
}

function moveFocus(dir) {
  var cur = document.activeElement;
  var list = focusables();
  if (list.indexOf(cur) === -1) {
    if (list.length) list[0].focus();
    return;
  }
  var r = cur.getBoundingClientRect();
  var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  var best = null, bestScore = Infinity;
  list.forEach(function (el) {
    if (el === cur) return;
    var b = el.getBoundingClientRect();
    var dist, cross;
    if (dir === 'left') { if (b.right > r.left + 1) return; dist = r.left - b.right; cross = (b.top + b.height / 2) - cy; }
    if (dir === 'right') { if (b.left < r.right - 1) return; dist = b.left - r.right; cross = (b.top + b.height / 2) - cy; }
    if (dir === 'up') { if (b.bottom > r.top + 1) return; dist = r.top - b.bottom; cross = (b.left + b.width / 2) - cx; }
    if (dir === 'down') { if (b.top < r.bottom - 1) return; dist = b.top - r.bottom; cross = (b.left + b.width / 2) - cx; }
    var score = dist + Math.abs(cross) * 2;
    if (score < bestScore) { bestScore = score; best = el; }
  });
  if (best) best.focus();
}

var ARROWS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };

document.addEventListener('keydown', function (e) {
  var log = $('log');
  if (document.activeElement === log && (e.keyCode === 38 || e.keyCode === 40)) {
    // Scroll the diagnostics output; move focus away only at the ends
    var before = log.scrollTop;
    log.scrollTop += e.keyCode === 40 ? 120 : -120;
    if (log.scrollTop !== before) { e.preventDefault(); return; }
  }
  if (ARROWS[e.keyCode]) {
    e.preventDefault();
    moveFocus(ARROWS[e.keyCode]);
  } else if (e.keyCode === 461 || e.keyCode === 27) { // webOS Back
    e.preventDefault();
    if (window.PalmSystem && PalmSystem.platformBack) PalmSystem.platformBack();
    else window.close();
  }
});

// --- Preview mode for designing in a desktop browser ---

var mock = {
  elevated: false, running: false, autostart: false, startedAt: 0,
  config: { port: 7070, audioDevice: 'hw:0,13', inputDevice: '/dev/input/event13' },
  log: []
};

function mockLuna(uri, p) {
  var method = uri.split('/').pop();
  var stamp = function (line) { mock.log.push(line); };
  var res = { returnValue: true };
  if (uri.indexOf('hbchannel') !== -1 && p.command.indexOf('diagnose') !== -1) {
    res = { returnValue: true, stdoutString: '== system\nLinux webos 4.4.84 armv7l\nuid=0(root)\n\n== service files\n(preview)\n' };
  } else if (uri.indexOf('hbchannel') !== -1) mock.elevated = true;
  else if (method === 'status') {
    res = {
      returnValue: true, version: '1.0.0', elevated: mock.elevated, running: mock.running,
      pid: mock.running ? 2481 : null, autostart: mock.autostart, legacyAutostart: false,
      config: mock.config, defaults: { port: 7070, audioDevice: 'hw:0,13', inputDevice: '/dev/input/event13' },
      urls: ['http://192.168.1.42:' + mock.config.port]
    };
    if (mock.running) {
      res.server = { uptime: Math.floor((Date.now() - mock.startedAt) / 1000), clients: 1, capturing: true,
                     config: mock.config, inputOk: true };
    }
  } else if (method === 'start' || method === 'restart') {
    mock.running = true; mock.startedAt = Date.now();
    stamp('TV Remote + Audio: http://0.0.0.0:' + mock.config.port);
  } else if (method === 'stop') {
    mock.running = false;
  } else if (method === 'setAutostart') {
    mock.autostart = p.enabled;
  } else if (method === 'setConfig') {
    mock.config = { port: +p.port, audioDevice: p.audioDevice, inputDevice: p.inputDevice };
  } else if (method === 'devices') {
    res = { returnValue: true,
      audio: [{ id: 'hw:0,0', name: 'MARS PCM' }, { id: 'hw:0,13', name: 'MARS CAPTURE_TEST' }],
      input: [{ id: '/dev/input/event0', name: 'LGE RCU' }, { id: '/dev/input/event13', name: 'LGE Network Input' }] };
  } else if (method === 'log') {
    res = { returnValue: true, lines: mock.log.slice(-30) };
  }
  return wait(150).then(function () { return res; });
}

// --- Start ---

// Show script errors on screen; there's no console on the TV
window.onerror = function (msg, src, line) {
  setMessage('App error: ' + msg + (line ? ' (line ' + line + ')' : ''), true);
};

$('preview').hidden = !!window.PalmServiceBridge;
refresh();
setInterval(function () { if (!busy) refresh(); }, POLL_MS);
