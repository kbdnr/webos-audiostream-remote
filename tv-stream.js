var http = require('http');
var fs = require('fs');
var spawn = require('child_process').spawn;

var PORT = 7070;
var SAMPLE_RATE = 48000;
var CHANNELS = 2;
var DEVICE = 'hw:0,13';
var INPUT_DEV = '/dev/input/event13';

// --- Key injection via evdev ---
var inputFd = null;
try { inputFd = fs.openSync(INPUT_DEV, fs.constants.O_WRONLY); } catch(e) {
  console.error('Cannot open ' + INPUT_DEV + ': ' + e.message);
}

function makeEvent(sec, usec, type, code, value) {
  // This kernel uses 16-byte input_event: u32 sec, u32 usec, u16 type, u16 code, s32 value
  var buf = Buffer.alloc(16, 0);
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
var clients = new Set();
var capture = null;

function startCapture() {
  if (capture) return;
  console.log('Starting capture from ' + DEVICE);
  capture = spawn('arecord', ['-D', DEVICE, '-f', 'S16_LE', '-r', String(SAMPLE_RATE), '-c', String(CHANNELS), '-t', 'raw', '-']);
  capture.stdout.on('data', function(chunk) {
    for (var c of clients) { try { c.write(chunk); } catch(e) {} }
  });
  capture.stderr.on('data', function(d) {
    var m = d.toString().trim(); if (m) console.log('arecord: ' + m);
  });
  capture.on('close', function(code) { console.log('arecord exited: ' + code); capture = null; });
}

function stopCapture() {
  if (!capture) return;
  console.log('Stopping capture');
  capture.kill(); capture = null;
}

// --- HTML ---
var HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TV Remote</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;justify-content:center;min-height:100vh;padding:1rem}
.wrap{width:320px;max-width:100%}
h1{font-size:1.2rem;text-align:center;margin-bottom:.8rem;color:#e94560}

/* Audio section */
.audio{background:#1a1a2e;border-radius:10px;padding:1rem;margin-bottom:1rem}
.audio-row{display:flex;align-items:center;gap:.8rem}
.audio-btn{background:#e94560;color:#fff;border:none;padding:.5rem 1.2rem;font-size:.85rem;border-radius:6px;cursor:pointer;white-space:nowrap}
.audio-btn:hover{background:#c73650}
.audio-btn.on{background:#4ecca3}
.audio-btn.on:hover{background:#3ba88a}
.as{font-size:.75rem;color:#666;flex:1}
.as.ok{color:#4ecca3}.as.err{color:#e94560}
.m{height:4px;background:#222;border-radius:2px;margin-top:.6rem}
.mf{height:100%;width:0%;background:linear-gradient(90deg,#4ecca3,#e94560);transition:width 30ms}
.ai{font-size:.65rem;color:#444;margin-top:.4rem;text-align:right}

/* Remote */
.remote{background:#1a1a2e;border-radius:10px;padding:1rem}
.row{display:flex;justify-content:center;gap:6px;margin-bottom:6px}
.btn{background:#2a2a3e;color:#ddd;border:1px solid #333;border-radius:6px;padding:10px 0;font-size:.75rem;cursor:pointer;
  display:flex;align-items:center;justify-content:center;flex:1;min-height:42px;user-select:none;-webkit-user-select:none}
.btn:active{background:#444;transform:scale(.95)}
.btn.accent{background:#e94560;color:#fff;border-color:#e94560}
.btn.accent:active{background:#c73650}
.btn.power{background:#c0392b;color:#fff;border-color:#c0392b}
.btn.power:active{background:#922b21}
.btn.ok{background:#4ecca3;color:#111;border-color:#4ecca3;border-radius:50%;min-width:60px;min-height:60px;flex:0}
.btn.ok:active{background:#3ba88a}
.btn.nav{min-width:50px}
.btn.red{color:#e74c3c}.btn.green{color:#2ecc71}.btn.yellow{color:#f1c40f}.btn.blue{color:#3498db}
.spacer{flex:1}
</style></head>
<body><div class="wrap">
<h1>TV Remote</h1>

<div class="audio">
  <div class="audio-row">
    <button class="audio-btn" id="ab" onclick="toggleAudio()">Audio</button>
    <span class="as" id="as">Tap to stream audio</span>
  </div>
  <div class="m"><div class="mf" id="m"></div></div>
  <div class="ai" id="ai"></div>
</div>

<div class="remote">
  <div class="row">
    <div class="btn power" onclick="k('power')">POWER</div>
    <div class="spacer"></div>
    <div class="btn" onclick="k('info')">INFO</div>
    <div class="btn" onclick="k('menu')">SETTINGS</div>
  </div>

  <div class="row" style="margin-top:10px">
    <div class="btn" onclick="k('1')">1</div><div class="btn" onclick="k('2')">2</div><div class="btn" onclick="k('3')">3</div>
  </div>
  <div class="row">
    <div class="btn" onclick="k('4')">4</div><div class="btn" onclick="k('5')">5</div><div class="btn" onclick="k('6')">6</div>
  </div>
  <div class="row">
    <div class="btn" onclick="k('7')">7</div><div class="btn" onclick="k('8')">8</div><div class="btn" onclick="k('9')">9</div>
  </div>
  <div class="row">
    <div class="btn" onclick="k('subtitle')">SUBT</div><div class="btn" onclick="k('0')">0</div><div class="btn" onclick="k('exit')">EXIT</div>
  </div>

  <div class="row" style="margin-top:10px">
    <div class="btn" onclick="k('vol_up')">VOL +</div>
    <div class="spacer"></div>
    <div class="btn" onclick="k('ch_up')">CH +</div>
  </div>
  <div class="row">
    <div class="btn" onclick="k('vol_down')">VOL -</div>
    <div class="btn" onclick="k('mute')">MUTE</div>
    <div class="btn" onclick="k('ch_down')">CH -</div>
  </div>

  <div class="row" style="margin-top:10px">
    <div class="spacer"></div><div class="btn nav" onclick="k('up')">&#9650;</div><div class="spacer"></div>
  </div>
  <div class="row">
    <div class="btn nav" onclick="k('left')">&#9664;</div>
    <div class="btn ok" onclick="k('ok')">OK</div>
    <div class="btn nav" onclick="k('right')">&#9654;</div>
  </div>
  <div class="row">
    <div class="spacer"></div><div class="btn nav" onclick="k('down')">&#9660;</div><div class="spacer"></div>
  </div>

  <div class="row" style="margin-top:10px">
    <div class="btn accent" onclick="k('home')">HOME</div>
    <div class="btn" onclick="k('back')">BACK</div>
  </div>

  <div class="row" style="margin-top:10px">
    <div class="btn" onclick="k('rw')">&#9194;</div>
    <div class="btn" onclick="k('play')">&#9654;</div>
    <div class="btn" onclick="k('pause')">&#9208;</div>
    <div class="btn" onclick="k('stop')">&#9209;</div>
    <div class="btn" onclick="k('ff')">&#9193;</div>
  </div>

  <div class="row" style="margin-top:6px">
    <div class="btn red" onclick="k('red')">RED</div>
    <div class="btn green" onclick="k('green')">GREEN</div>
    <div class="btn yellow" onclick="k('yellow')">YELLOW</div>
    <div class="btn blue" onclick="k('blue')">BLUE</div>
  </div>
</div>
</div>

<script>
function k(key){fetch('/key/'+key,{method:'POST'});}

var SR=${SAMPLE_RATE},CH=${CHANNELS};
var ctx,playing=false,reader=null,nextT=0,ac=null;
var as=document.getElementById('as'),ab=document.getElementById('ab'),m=document.getElementById('m'),ai=document.getElementById('ai');

function toggleAudio(){playing?stopAudio():startAudio();}

async function startAudio(){
  ctx=new AudioContext({sampleRate:SR});nextT=0;ac=new AbortController();
  as.textContent='Connecting...';as.className='as';ab.disabled=true;
  try{
    var res=await fetch('/audio',{signal:ac.signal});
    if(!res.ok||!res.body){as.textContent='Failed';as.className='as err';ab.disabled=false;return;}
    playing=true;as.textContent='Streaming';as.className='as ok';ab.textContent='Stop';ab.className='audio-btn on';ab.disabled=false;
    reader=res.body.getReader();pump();
  }catch(e){if(e.name!=='AbortError'){as.textContent='Error';as.className='as err';}ab.disabled=false;}
}

async function pump(){
  try{while(playing){var r=await reader.read();if(r.done)break;playChunk(r.value.buffer);}}catch(e){}
  if(playing)stopAudio();
}

function playChunk(ab){
  var raw=new Int16Array(ab),samples=Math.floor(raw.length/CH);
  if(!samples)return;
  var buf=ctx.createBuffer(CH,samples,SR);
  for(var c=0;c<CH;c++){var d=buf.getChannelData(c);for(var i=0;i<samples;i++)d[i]=raw[i*CH+c]/32768;}
  var now=ctx.currentTime;if(nextT<now)nextT=now+0.02;
  var src=ctx.createBufferSource();src.buffer=buf;src.connect(ctx.destination);src.start(nextT);nextT+=buf.duration;
  var pk=0,c0=buf.getChannelData(0);for(var i=0;i<c0.length;i+=16){var v=Math.abs(c0[i]);if(v>pk)pk=v;}
  m.style.width=(pk*100)+'%';ai.textContent='Buf: '+(((nextT-now)*1000)|0)+'ms';
}

function stopAudio(){
  playing=false;if(ac){ac.abort();ac=null;}if(reader){try{reader.cancel();}catch(e){}reader=null;}
  if(ctx){ctx.close();ctx=null;}ab.textContent='Audio';ab.className='audio-btn';ab.disabled=false;
  m.style.width='0%';ai.textContent='';if(as.className!=='as err'){as.textContent='Tap to stream audio';as.className='as';}
}
</script>
</body></html>`;

// --- HTTP server ---
var server = http.createServer(function(req, res) {
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

  // Audio stream
  if (req.url === '/audio') {
    console.log('Audio client connected');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Content-Type-Options': 'nosniff'
    });
    clients.add(res);
    if (clients.size === 1) startCapture();
    req.on('close', function() {
      clients.delete(res);
      console.log('Audio client disconnected (' + clients.size + ' left)');
      if (clients.size === 0) stopCapture();
    });
    return;
  }

  // Web UI
  res.writeHead(200, {'Content-Type': 'text/html'});
  res.end(HTML);
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('TV Remote + Audio: http://0.0.0.0:' + PORT);
});
