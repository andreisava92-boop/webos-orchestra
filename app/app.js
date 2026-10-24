// Orchestra TV app: talks only to the local daemon API on 127.0.0.1:8099.
// No TV credentials, no Luna calls: the root daemon owns the privileged bits.

(function () {
  var API = 'http://127.0.0.1:8099';
  var LABELS = {
    tv_speaker: 'TV only',
    external_arc: 'Soundbar only',
    tv_speaker_optical_arc: 'TV + soundbar'
  };

  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var minus = document.getElementById('minus');
  var plus = document.getElementById('plus');
  var avvalue = document.getElementById('avvalue');
  var statusEl = document.getElementById('status');
  var banner = document.getElementById('banner');

  var state = { soundOutput: null, desiredOutput: null, avSyncSpeaker: null };
  var zone = 'cards';
  var cardIndex = 2;
  var avIndex = 1;
  var busy = false;
  var offline = false;
  var initialized = false;
  var pollTimer = null;

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  function showBanner(text) {
    if (!text) {
      banner.hidden = true;
      banner.textContent = '';
      return;
    }
    banner.hidden = false;
    banner.textContent = text;
  }

  function labelOf(value) {
    return LABELS[value] || String(value || 'unknown');
  }

  function isKnown(value) {
    return Object.prototype.hasOwnProperty.call(LABELS, value);
  }

  function render() {
    cards.forEach(function (card, index) {
      var value = card.getAttribute('data-value');
      card.classList.toggle('active', value === state.soundOutput);
      card.classList.toggle('focused', zone === 'cards' && index === cardIndex);
      card.disabled = busy;
    });

    avvalue.textContent = state.avSyncSpeaker === null ? '—' : String(state.avSyncSpeaker);
    minus.classList.toggle('focused', zone === 'av' && avIndex === 0);
    plus.classList.toggle('focused', zone === 'av' && avIndex === 1);
    minus.disabled = busy;
    plus.disabled = busy;

    if (busy) {
      setStatus('Applying…', 'pending');
    } else if (offline) {
      setStatus('Service unavailable', 'err');
    } else {
      setStatus('Playing through: ' + labelOf(state.soundOutput), 'ok');
    }
  }

  function request(path, options) {
    return fetch(API + path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.ok === false) {
          throw new Error(data.error || ('HTTP ' + res.status));
        }
        return data;
      });
    });
  }

  function loadState() {
    if (busy) return Promise.resolve();
    return request('/state').then(function (data) {
      offline = false;
      showBanner('');
      state.soundOutput = data.soundOutput;
      state.desiredOutput = data.desiredOutput;
      state.avSyncSpeaker = typeof data.avSyncSpeaker === 'number' ? data.avSyncSpeaker : null;
      if (!initialized) {
        initialized = true;
        cards.forEach(function (card, index) {
          if (card.getAttribute('data-value') === state.soundOutput) cardIndex = index;
        });
      }
      render();
    }).catch(function (err) {
      offline = true;
      showBanner('The local Orchestra service is not responding (' + err.message +
        '). Check the TV daemon: /tmp/orchestra-tv.log.');
      render();
    });
  }

  function applyOutput(value) {
    if (busy || !isKnown(value)) return;
    busy = true;
    render();
    request('/output', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: value })
    }).then(function (data) {
      state.soundOutput = data.soundOutput;
      state.desiredOutput = data.desiredOutput;
      if (typeof data.avSyncSpeaker === 'number') state.avSyncSpeaker = data.avSyncSpeaker;
      offline = false;
      showBanner('');
    }).catch(function (err) {
      showBanner('Could not apply: ' + err.message);
    }).then(function () {
      busy = false;
      render();
    });
  }

  function applyAvSync(delta) {
    if (busy) return;
    var current = state.avSyncSpeaker;
    if (current === null) {
      showBanner('The TV did not report the AV Sync value.');
      return;
    }
    var next = Math.max(0, Math.min(60, current + delta));
    if (next === current) return;
    busy = true;
    render();
    request('/avsync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: next })
    }).then(function (data) {
      state.avSyncSpeaker = data.avSyncSpeaker;
      offline = false;
      showBanner('');
    }).catch(function (err) {
      showBanner('Could not set the delay: ' + err.message);
    }).then(function () {
      busy = false;
      render();
    });
  }

  function moveCard(step) {
    cardIndex = (cardIndex + step + cards.length) % cards.length;
    render();
  }

  function activateCard() {
    var card = cards[cardIndex];
    if (card) applyOutput(card.getAttribute('data-value'));
  }

  function onKey(event) {
    var key = event.key;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault();
      if (zone === 'cards') moveCard(key === 'ArrowLeft' ? -1 : 1);
      else { avIndex = avIndex === 0 ? 1 : 0; render(); }
      return;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      event.preventDefault();
      zone = zone === 'cards' ? 'av' : 'cards';
      render();
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (zone === 'cards') activateCard();
      else applyAvSync(avIndex === 0 ? -5 : 5);
      return;
    }
  }

  cards.forEach(function (card, index) {
    card.addEventListener('click', function () {
      zone = 'cards';
      cardIndex = index;
      applyOutput(card.getAttribute('data-value'));
    });
    card.addEventListener('mouseenter', function () {
      zone = 'cards';
      cardIndex = index;
      render();
    });
  });

  minus.addEventListener('click', function () { zone = 'av'; avIndex = 0; applyAvSync(-5); });
  plus.addEventListener('click', function () { zone = 'av'; avIndex = 1; applyAvSync(5); });
  minus.addEventListener('mouseenter', function () { zone = 'av'; avIndex = 0; render(); });
  plus.addEventListener('mouseenter', function () { zone = 'av'; avIndex = 1; render(); });

  document.addEventListener('keydown', onKey);

  // Keep the screen in sync with changes made from the phone/laptop UI, but
  // stop polling while the app is not visible.
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (document.visibilityState === 'visible') loadState();
    }, 10000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { loadState(); startPolling(); }
    else stopPolling();
  });

  render();
  loadState();
  startPolling();
})();
