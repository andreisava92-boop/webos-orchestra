// Orchestra TV-side daemon.
//
// Runs on the TV itself (webOS Node 8, no npm dependencies):
//   - speaks SSAP over a WebSocket to 127.0.0.1:3000, using the paired
//     client key and registration payload,
//   - subscribes to ssap://audio/getVolume,
//   - mirrors the TV volume to a Google Cast receiver (the soundbar),
//   - re-applies the dual-output audio mode when the TV falls back to another mode.
//
// Every address and tunable comes from config.json in BASE. Nothing is hardcoded.

var net = require('net');
var tls = require('tls');
var crypto = require('crypto');
var fs = require('fs');
var exec = require('child_process').exec;

var BASE = '/var/lib/webosbrew/orchestra';
var CONFIG_PATH = BASE + '/config.json';
var REGISTRATION_PATH = BASE + '/registration.json';
var CLIENT_KEY_PATH = BASE + '/client.key';
var TV_HOST = '127.0.0.1';
var TV_PORT = 3000;
var REAPPLY_MIN_MS = 30000;
var WS_RETRY_MS = 5000;

var config = null;
var registrationPayload = null;
var dryRun = process.env.ORCHESTRA_DRY_RUN === '1';

var ws = null;
var wsOpen = false;
var wsBuf = Buffer.alloc(0);
var frag = null;
var wsRetry = null;
var lastTarget = null;
var lastReapply = 0;
var castSocket = null;
var castReady = false;
var pendingLevel = null;
var requestId = 1;

function log(message) {
  console.log(new Date().toISOString() + ' ' + message);
}

// ---------- config ----------

// Parse and validate the daemon config. Throws Error with a readable message.
function loadConfig(path) {
  var file = path || CONFIG_PATH;
  var raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error('cannot read config file ' + file + ': ' + e.message);
  }
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('config file ' + file + ' is not valid JSON: ' + e.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config file ' + file + ' must contain a JSON object');
  }
  if (typeof parsed.castHost !== 'string' || parsed.castHost.trim() === '') {
    throw new Error('config.castHost must be a non-empty string');
  }
  var port = parsed.castPort;
  if (typeof port !== 'number' || !isFinite(port) || Math.floor(port) !== port || port < 1 || port > 65535) {
    throw new Error('config.castPort must be an integer between 1 and 65535');
  }
  var gain = parsed.gain;
  if (typeof gain !== 'number' || !isFinite(gain) || gain <= 0) {
    throw new Error('config.gain must be a number greater than 0');
  }
  if (typeof parsed.desiredOutput !== 'string' || parsed.desiredOutput.trim() === '') {
    throw new Error('config.desiredOutput must be a non-empty string');
  }
  var desired = parsed.desiredOutput.trim();
  if (!/^[A-Za-z0-9_]+$/.test(desired)) {
    throw new Error('config.desiredOutput may contain only letters, digits and underscores');
  }
  var watchdog = parsed.watchdogSeconds;
  if (typeof watchdog !== 'number' || !isFinite(watchdog) || watchdog < 5) {
    throw new Error('config.watchdogSeconds must be a number >= 5');
  }
  return {
    castHost: parsed.castHost.trim(),
    castPort: port,
    gain: gain,
    desiredOutput: desired,
    watchdogSeconds: watchdog
  };
}

// ---------- volume mapping ----------

function applyGain(volume, gain) {
  var v = Number(volume);
  var g = Number(gain);
  if (!isFinite(v)) return 0;
  if (!isFinite(g) || g <= 0) g = 1;
  return Math.min(100, Math.round(v * g));
}

function computeTarget(volume, muted, gain) {
  if (muted) return 0;
  return applyGain(volume, gain);
}

// ---------- Google Cast / protobuf ----------

function varint(n) {
  var out = [];
  while (n > 127) {
    out.push((n & 127) | 128);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

function fieldVarint(num, val) {
  return Buffer.concat([varint((num << 3) | 0), varint(val)]);
}

function fieldString(num, str) {
  var b = Buffer.from(str, 'utf8');
  return Buffer.concat([varint((num << 3) | 2), varint(b.length), b]);
}

function castMessage(source, dest, ns, payload) {
  return Buffer.concat([
    fieldVarint(1, 0),
    fieldString(2, source),
    fieldString(3, dest),
    fieldString(4, ns),
    fieldVarint(5, 0),
    fieldString(6, payload)
  ]);
}

function frameCast(msg) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(msg.length, 0);
  return Buffer.concat([len, msg]);
}

function sendCast(ns, payload) {
  if (!castSocket || !castReady) return false;
  try {
    castSocket.write(frameCast(castMessage('sender-0', 'receiver-0', ns, JSON.stringify(payload))));
    return true;
  } catch (e) {
    return false;
  }
}

function connectCast() {
  if (dryRun) return;
  if (castSocket) return;
  castSocket = tls.connect({
    host: config.castHost,
    port: config.castPort,
    rejectUnauthorized: false
  }, function () {
    castReady = true;
    log('cast connected');
    sendCast('urn:x-cast:com.google.cast.tp.connection', { type: 'CONNECT', origin: {} });
    if (pendingLevel !== null) setTimeout(function () { applyCast(pendingLevel); }, 100);
  });
  castSocket.on('data', function () {});
  castSocket.on('error', function (e) {
    log('cast error: ' + e.message);
    castReady = false;
    castSocket = null;
  });
  castSocket.on('close', function () {
    castReady = false;
    castSocket = null;
  });
}

function applyCast(level) {
  pendingLevel = level;
  if (dryRun) {
    log('DRY_RUN cast level=' + level);
    return;
  }
  var ok = sendCast('urn:x-cast:com.google.cast.receiver', {
    type: 'SET_VOLUME',
    volume: { level: level },
    requestId: requestId++
  });
  if (!ok) connectCast();
}

// ---------- WebSocket (RFC6455 client) ----------

function wsConnect() {
  var key = crypto.randomBytes(16).toString('base64');
  var req = 'GET / HTTP/1.1\r\n' +
    'Host: ' + TV_HOST + ':' + TV_PORT + '\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Key: ' + key + '\r\n' +
    'Sec-WebSocket-Version: 13\r\n\r\n';
  var sock = net.connect(TV_PORT, TV_HOST, function () { sock.write(req); });
  var handshake = false;
  var buf = Buffer.alloc(0);

  sock.on('data', function (d) {
    if (!handshake) {
      buf = Buffer.concat([buf, d]);
      var idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      var head = buf.slice(0, idx).toString();
      if (head.indexOf(' 101 ') < 0) {
        log('ws handshake failed: ' + head.split('\r\n')[0]);
        sock.destroy();
        return;
      }
      handshake = true;
      ws = sock;
      wsOpen = true;
      wsBuf = Buffer.alloc(0);
      var rest = buf.slice(idx + 4);
      log('ws connected');
      registerSsap();
      if (rest.length) onWsData(rest);
    } else {
      onWsData(d);
    }
  });
  sock.on('error', function (e) {
    log('ws error: ' + e.message);
    wsOpen = false;
    ws = null;
  });
  sock.on('close', function () {
    log('ws closed');
    wsOpen = false;
    ws = null;
    if (!wsRetry) {
      wsRetry = setTimeout(function () { wsRetry = null; wsConnect(); }, WS_RETRY_MS);
    }
  });
}

function encodeFrame(opcode, payload) {
  var len = payload.length;
  var header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode;
  var mask = crypto.randomBytes(4);
  var masked = Buffer.alloc(len);
  for (var i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function wsSend(obj) {
  if (!ws || !wsOpen) return false;
  try {
    ws.write(encodeFrame(1, Buffer.from(JSON.stringify(obj), 'utf8')));
    return true;
  } catch (e) {
    return false;
  }
}

function onWsData(d) {
  wsBuf = Buffer.concat([wsBuf, d]);
  while (true) {
    if (wsBuf.length < 2) return;
    var b0 = wsBuf[0];
    var b1 = wsBuf[1];
    var fin = (b0 & 0x80) !== 0;
    var opcode = b0 & 0x0f;
    var masked = (b1 & 0x80) !== 0;
    var len = b1 & 0x7f;
    var off = 2;
    if (len === 126) {
      if (wsBuf.length < 4) return;
      len = wsBuf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (wsBuf.length < 10) return;
      var hi = wsBuf.readUInt32BE(2);
      var lo = wsBuf.readUInt32BE(6);
      len = hi * 4294967296 + lo;
      off = 10;
    }
    var maskKey = null;
    if (masked) {
      if (wsBuf.length < off + 4) return;
      maskKey = wsBuf.slice(off, off + 4);
      off += 4;
    }
    if (wsBuf.length < off + len) return;
    var payload = wsBuf.slice(off, off + len);
    wsBuf = wsBuf.slice(off + len);
    if (masked) {
      var unmasked = Buffer.alloc(len);
      for (var j = 0; j < len; j++) unmasked[j] = payload[j] ^ maskKey[j % 4];
      payload = unmasked;
    }
    if (opcode === 1) {
      if (fin) handleSsap(payload.toString('utf8'));
      else frag = payload.toString('utf8');
    } else if (opcode === 0) {
      var part = payload.toString('utf8');
      frag = (frag || '') + part;
      if (fin) { handleSsap(frag); frag = null; }
    } else if (opcode === 8) {
      log('ws close frame');
      try { ws.end(); } catch (e) {}
    } else if (opcode === 9) {
      if (ws && wsOpen) ws.write(encodeFrame(10, payload));
    }
  }
}

// ---------- SSAP ----------

function registerSsap() {
  wsSend({ type: 'register', id: 'reg', payload: registrationPayload });
}

function handleSsap(raw) {
  var msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (msg.type === 'registered') {
    log('ssap registered');
    wsSend({ id: 'vol', type: 'subscribe', uri: 'ssap://audio/getVolume' });
    return;
  }
  if (msg.type === 'error') {
    log('ssap error: ' + JSON.stringify(msg));
    return;
  }
  if (msg.payload && msg.payload.volumeStatus) handleVolume(msg.payload.volumeStatus);
}

function handleVolume(vs) {
  var vol = Number(vs.volume);
  var muted = !!vs.muteStatus;
  if (isNaN(vol)) return;
  var target = computeTarget(vol, muted, config.gain);
  if (target === lastTarget) return;
  lastTarget = target;
  log('TV ' + vol + '% -> cast ' + target + '%' + (muted ? ' (muted)' : ''));
  applyCast(target / 100);
}

// ---------- Luna helpers (output watchdog) ----------

// luna-send needs a controlling TTY; without one it exits 0 and writes nothing.
// Run it through `script -qc "..."` with the payload in single quotes so the
// JSON survives both shell layers.
function runLuna(uri, payload, cb) {
  var esc = payload.replace(/"/g, '\\"');
  var cmd = 'script -qc "luna-send -a webosbrew -f -n 1 -w 3000 ' + uri + " '" + esc + "'" + '" /dev/null';
  exec(cmd, { timeout: 5000 }, function (err, stdout) {
    if (err) return cb(err);
    var start = stdout.indexOf('{');
    var end = stdout.lastIndexOf('}');
    if (start < 0 || end < start) return cb(new Error('no json in luna output'));
    try { cb(null, JSON.parse(stdout.slice(start, end + 1))); } catch (e) { cb(e); }
  });
}

function checkOutput() {
  runLuna('luna://com.webos.service.audio/getSoundOutput', '{}', function (err, data) {
    if (err) return log('output check error: ' + err.message);
    var out = data.soundOutput;
    if (out && out !== config.desiredOutput && Date.now() - lastReapply > REAPPLY_MIN_MS) {
      lastReapply = Date.now();
      log('output is ' + out + ' -> re-applying ' + config.desiredOutput);
      runLuna('luna://com.webos.service.audio/setSoundOutput',
        '{"soundOutput":"' + config.desiredOutput + '"}', function (e2, d2) {
          if (e2) log('re-apply failed: ' + e2.message);
          else log('re-applied: ' + JSON.stringify(d2));
        });
    }
  });
}

// ---------- start ----------

function loadSecrets() {
  var registration;
  var clientKey;
  try {
    registration = JSON.parse(fs.readFileSync(REGISTRATION_PATH, 'utf8'));
  } catch (e) {
    throw new Error('cannot load ' + REGISTRATION_PATH + ': ' + e.message);
  }
  try {
    clientKey = fs.readFileSync(CLIENT_KEY_PATH, 'utf8').trim();
  } catch (e) {
    throw new Error('cannot load ' + CLIENT_KEY_PATH + ': ' + e.message);
  }
  if (!clientKey) {
    throw new Error(CLIENT_KEY_PATH + ' is empty');
  }
  registration['client-key'] = clientKey;
  registration.pairingType = 'PROMPT';
  registration.forcePairing = false;
  return registration;
}

function start() {
  var args = process.argv.slice(2);
  try {
    config = loadConfig(CONFIG_PATH);
  } catch (e) {
    console.error('orchestra: ' + e.message);
    process.exit(1);
  }

  if (args.indexOf('--once') !== -1) {
    console.log(JSON.stringify({
      ok: true,
      castHost: config.castHost,
      gain: config.gain,
      desiredOutput: config.desiredOutput
    }));
    process.exit(0);
  }

  try {
    registrationPayload = loadSecrets();
  } catch (e) {
    console.error('orchestra: ' + e.message);
    console.error('orchestra: run install.sh again to pair this TV');
    process.exit(1);
  }

  log('starting: cast=' + config.castHost + ':' + config.castPort +
    ' gain=' + config.gain +
    ' output=' + config.desiredOutput +
    ' watchdog=' + config.watchdogSeconds + 's' +
    (dryRun ? ' (dry run)' : ''));

  connectCast();
  wsConnect();
  setInterval(checkOutput, config.watchdogSeconds * 1000);
}

process.on('uncaughtException', function (e) {
  log('uncaught exception: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});

if (require.main === module) {
  start();
}

module.exports = {
  varint: varint,
  fieldVarint: fieldVarint,
  fieldString: fieldString,
  castMessage: castMessage,
  frameCast: frameCast,
  encodeFrame: encodeFrame,
  loadConfig: loadConfig,
  computeTarget: computeTarget,
  applyGain: applyGain
};
