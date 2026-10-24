// Plain Node test runner for the TV daemon helpers. No test framework, no deps.
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var orchestra = require('../tv/orchestra.js');

var passed = 0;

function test(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error('FAIL ' + name);
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }
  passed++;
}

function bytes(buf) {
  return Array.prototype.slice.call(buf);
}

function readVarint(buf, off) {
  var value = 0;
  var shift = 0;
  var b;
  do {
    if (off >= buf.length) throw new Error('truncated varint');
    b = buf[off];
    off++;
    value += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (b & 0x80);
  return { value: value, offset: off };
}

// Walk a protobuf message and return the field numbers in wire order.
function fieldNumbers(buf) {
  var fields = [];
  var off = 0;
  while (off < buf.length) {
    var tag = readVarint(buf, off);
    off = tag.offset;
    var num = Math.floor(tag.value / 8);
    var wire = tag.value & 7;
    fields.push(num);
    if (wire === 0) {
      off = readVarint(buf, off).offset;
    } else if (wire === 2) {
      var len = readVarint(buf, off);
      off = len.offset + len.value;
    } else {
      throw new Error('unexpected wire type ' + wire);
    }
  }
  return fields;
}

function tmpFile(name, content) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-test-'));
  var file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

// ---------- protobuf ----------

test('varint(0)', function () {
  assert.deepStrictEqual(bytes(orchestra.varint(0)), [0x00]);
});

test('varint(127)', function () {
  assert.deepStrictEqual(bytes(orchestra.varint(127)), [0x7f]);
});

test('varint(128)', function () {
  assert.deepStrictEqual(bytes(orchestra.varint(128)), [0x80, 0x01]);
});

test('varint(300)', function () {
  assert.deepStrictEqual(bytes(orchestra.varint(300)), [0xac, 0x02]);
});

test('fieldVarint(1, 0)', function () {
  assert.deepStrictEqual(bytes(orchestra.fieldVarint(1, 0)), [0x08, 0x00]);
});

test('fieldString(6, "x")', function () {
  var b = orchestra.fieldString(6, 'x');
  assert.strictEqual(b[0], 0x32);
  assert.strictEqual(b[1], 0x01);
  assert.strictEqual(b[2], 0x78);
  assert.strictEqual(b.length, 3);
});

test('castMessage has fields 1..6 in order', function () {
  var msg = orchestra.castMessage('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.receiver',
    JSON.stringify({ type: 'SET_VOLUME', volume: { level: 0.26 }, requestId: 1 }));
  assert.deepStrictEqual(fieldNumbers(msg), [1, 2, 3, 4, 5, 6]);
});

test('castMessage carries a valid UTF-8 payload', function () {
  var payload = JSON.stringify({ type: 'SET_VOLUME', label: '\u0103\u00e2\u021b\u0219' });
  var msg = orchestra.castMessage('sender-0', 'receiver-0', 'ns', payload);
  // The last field is field 6 (length-delimited); read it back.
  var off = 0;
  var last = null;
  while (off < msg.length) {
    var tag = readVarint(msg, off);
    off = tag.offset;
    var num = Math.floor(tag.value / 8);
    var wire = tag.value & 7;
    if (wire === 0) {
      off = readVarint(msg, off).offset;
    } else {
      var len = readVarint(msg, off);
      off = len.offset;
      last = { num: num, start: off, end: off + len.value };
      off += len.value;
    }
  }
  assert.strictEqual(last.num, 6);
  var encoded = msg.slice(last.start, last.end);
  assert.strictEqual(encoded.length, Buffer.byteLength(payload, 'utf8'));
  assert.strictEqual(encoded.toString('utf8'), payload);
});

// ---------- websocket framing ----------

test('encodeFrame is masked and round-trips', function () {
  var frame = orchestra.encodeFrame(1, Buffer.from('hi', 'utf8'));
  assert.strictEqual(frame[0], 0x81);
  assert.strictEqual(frame[1], 0x82);
  assert.strictEqual(frame.length, 2 + 4 + 2);
  var mask = frame.slice(2, 6);
  var payload = frame.slice(6);
  var out = Buffer.alloc(payload.length);
  for (var i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i % 4];
  assert.strictEqual(out.toString('utf8'), 'hi');
});

// ---------- volume mapping ----------

test('computeTarget(10, false, 2.6) === 26', function () {
  assert.strictEqual(orchestra.computeTarget(10, false, 2.6), 26);
});

test('computeTarget(10, true, 2.6) === 0', function () {
  assert.strictEqual(orchestra.computeTarget(10, true, 2.6), 0);
});

test('computeTarget(50, false, 2.6) === 100 (capped)', function () {
  assert.strictEqual(orchestra.computeTarget(50, false, 2.6), 100);
});

test('computeTarget(NaN, false, 2.6) === 0', function () {
  assert.strictEqual(orchestra.computeTarget(NaN, false, 2.6), 0);
});

test('computeTarget uses a fixed cast volume when configured', function () {
  assert.strictEqual(orchestra.computeTarget(18, false, 5.6, 100), 100);
  assert.strictEqual(orchestra.computeTarget(10, false, 5.6, 100), 100);
});

test('fixed cast volume respects mute and TV volume 0', function () {
  assert.strictEqual(orchestra.computeTarget(18, true, 5.6, 100), 0);
  assert.strictEqual(orchestra.computeTarget(0, false, 5.6, 100), 0);
});

test('applyGain(15, 2.6) === 39', function () {
  assert.strictEqual(orchestra.applyGain(15, 2.6), 39);
});

// ---------- config ----------

test('loadConfig returns normalized values', function () {
  var file = tmpFile('config.json', JSON.stringify({
    castHost: ' 192.0.2.60 ',
    castPort: 8009,
    gain: 2.6,
    desiredOutput: 'tv_speaker_optical_arc',
    watchdogSeconds: 15
  }));
  var cfg = orchestra.loadConfig(file);
  assert.strictEqual(cfg.castHost, '192.0.2.60');
  assert.strictEqual(cfg.castPort, 8009);
  assert.strictEqual(cfg.gain, 2.6);
  assert.strictEqual(cfg.fixedCastVolume, null);
  assert.strictEqual(cfg.desiredOutput, 'tv_speaker_optical_arc');
  assert.strictEqual(cfg.watchdogSeconds, 15);
});

test('loadConfig accepts a fixed cast volume', function () {
  var file = tmpFile('config.json', JSON.stringify({
    castHost: '192.0.2.60', castPort: 8009, gain: 2.6,
    fixedCastVolume: 100,
    desiredOutput: 'tv_speaker_optical_arc', watchdogSeconds: 15
  }));
  assert.strictEqual(orchestra.loadConfig(file).fixedCastVolume, 100);
});

test('loadConfig rejects a fixed cast volume above 100', function () {
  var file = tmpFile('config.json', JSON.stringify({
    castHost: '192.0.2.60', castPort: 8009, gain: 2.6,
    fixedCastVolume: 101,
    desiredOutput: 'tv_speaker_optical_arc', watchdogSeconds: 15
  }));
  assert.throws(function () { orchestra.loadConfig(file); }, /fixedCastVolume/);
});

test('loadConfig throws when the file is missing', function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-test-'));
  assert.throws(function () {
    orchestra.loadConfig(path.join(dir, 'missing.json'));
  }, /config file/);
});

test('loadConfig rejects gain <= 0', function () {
  var file = tmpFile('config.json', JSON.stringify({
    castHost: '192.0.2.60', castPort: 8009, gain: 0,
    desiredOutput: 'tv_speaker_optical_arc', watchdogSeconds: 15
  }));
  assert.throws(function () { orchestra.loadConfig(file); }, /gain/);
});

test('loadConfig rejects a bad castPort', function () {
  var file = tmpFile('config.json', JSON.stringify({
    castHost: '192.0.2.60', castPort: 70000, gain: 2.6,
    desiredOutput: 'tv_speaker_optical_arc', watchdogSeconds: 15
  }));
  assert.throws(function () { orchestra.loadConfig(file); }, /castPort/);
});

test('loadConfig rejects a short watchdog', function () {
  var file = tmpFile('config.json', JSON.stringify({
    castHost: '192.0.2.60', castPort: 8009, gain: 2.6,
    desiredOutput: 'tv_speaker_optical_arc', watchdogSeconds: 1
  }));
  assert.throws(function () { orchestra.loadConfig(file); }, /watchdogSeconds/);
});

test('loadConfig rejects an empty castHost', function () {
  var file = tmpFile('config.json', JSON.stringify({
    castHost: '', castPort: 8009, gain: 2.6,
    desiredOutput: 'tv_speaker_optical_arc', watchdogSeconds: 15
  }));
  assert.throws(function () { orchestra.loadConfig(file); }, /castHost/);
});

test('loadConfig rejects an empty desiredOutput', function () {
  var file = tmpFile('config.json', JSON.stringify({
    castHost: '192.0.2.60', castPort: 8009, gain: 2.6,
    desiredOutput: '   ', watchdogSeconds: 15
  }));
  assert.throws(function () { orchestra.loadConfig(file); }, /desiredOutput/);
});

test('loadConfig rejects shell characters in desiredOutput', function () {
  var file = tmpFile('config.json', JSON.stringify({
    castHost: '192.0.2.60', castPort: 8009, gain: 2.6,
    desiredOutput: "tv_speaker'; id", watchdogSeconds: 15
  }));
  assert.throws(function () { orchestra.loadConfig(file); }, /desiredOutput/);
});

test('loadConfig rejects invalid JSON', function () {
  var file = tmpFile('config.json', '{not json');
  assert.throws(function () { orchestra.loadConfig(file); }, /JSON/);
});

// ---------- output api ----------

test('validOutput accepts the three supported modes', function () {
  ['tv_speaker', 'external_arc', 'tv_speaker_optical_arc'].forEach(function (v) {
    assert.strictEqual(orchestra.validOutput(v), true);
  });
});

test('validOutput rejects unknown values', function () {
  ['', 'external_optical', 'tv_speaker; id', null, 42].forEach(function (v) {
    assert.strictEqual(orchestra.validOutput(v), false);
  });
});

test('validAvSync accepts 0..60 integers', function () {
  [0, 15, 60, '20'].forEach(function (v) {
    assert.strictEqual(orchestra.validAvSync(v), true);
  });
});

test('validAvSync rejects out-of-range and non-integers', function () {
  [-1, 61, 1.5, 'x', null, '', true].forEach(function (v) {
    assert.strictEqual(orchestra.validAvSync(v), false);
  });
});

test('readAvSync reads settings.avSyncSpeaker', function () {
  assert.strictEqual(orchestra.readAvSync({ settings: { avSyncSpeaker: '15' } }), 15);
  assert.strictEqual(orchestra.readAvSync({ settings: { avSyncSpeaker: 0 } }), 0);
});

test('readAvSync returns null when missing', function () {
  assert.strictEqual(orchestra.readAvSync({}), null);
  assert.strictEqual(orchestra.readAvSync(null), null);
  assert.strictEqual(orchestra.readAvSync({ settings: {} }), null);
});

test('loadConfig defaults apiPort to 8099', function () {
  var file = tmpFile('config.json', JSON.stringify({
    castHost: '192.0.2.60', castPort: 8009, gain: 2.6,
    desiredOutput: 'tv_speaker_optical_arc', watchdogSeconds: 15
  }));
  assert.strictEqual(orchestra.loadConfig(file).apiPort, 8099);
});

test('loadConfig accepts apiPort 0 (disabled)', function () {
  var file = tmpFile('config.json', JSON.stringify({
    castHost: '192.0.2.60', castPort: 8009, gain: 2.6,
    desiredOutput: 'tv_speaker_optical_arc', watchdogSeconds: 15, apiPort: 0
  }));
  assert.strictEqual(orchestra.loadConfig(file).apiPort, 0);
});

test('loadConfig rejects a bad apiPort', function () {
  var file = tmpFile('config.json', JSON.stringify({
    castHost: '192.0.2.60', castPort: 8009, gain: 2.6,
    desiredOutput: 'tv_speaker_optical_arc', watchdogSeconds: 15, apiPort: 70000
  }));
  assert.throws(function () { orchestra.loadConfig(file); }, /apiPort/);
});

console.log('OK ' + passed + ' tests');
