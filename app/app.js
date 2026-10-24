// Orchestra TV app: talks only to the local daemon API on 127.0.0.1:8099.
// No TV credentials, no Luna calls: the root daemon owns the privileged bits.

(function () {
  var API = 'http://127.0.0.1:8099';
  var LABELS = {
    tv_speaker: 'TV only',
    external_arc: 'Soundbar only',
    tv_speaker_optical_arc: 'TV + soundbar'
  };
  var DIGITAL_LABELS = {
    auto: 'Auto',
    pcm: 'PCM',
    passThrough: 'Pass Through'
  };
  var DIGITAL_VALUES = ['auto', 'pcm', 'passThrough'];
  var DUAL_WARNING = 'Dual output is PCM: pass-through does not reach the soundbar. ' +
    'Choose Soundbar only for Dolby/DTS.';

  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var digitalButtons = Array.prototype.slice.call(document.querySelectorAll('.seg-option'));
  var minus = document.getElementById('minus');
  var plus = document.getElementById('plus');
  var avvalue = document.getElementById('avvalue');
  var statusEl = document.getElementById('status');
  var banner = document.getElementById('banner');

  var state = {
    soundOutput: null,
    desiredOutput: null,
    avSyncSpeaker: null,
    soundOutputDigital: null
  };
  var ROWS = ['cards', 'digital', 'av'];
  var row = 0;
  var cardIndex = 2;
  var digitalIndex = 0;
  var avIndex = 1;
  var busy = false;
  var offline = false;
  var initialized = false;
  var bannerKind = '';
  var pollTimer = null;

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  function showBanner(text, kind) {
    if (!text) {
      banner.hidden = true;
      banner.textContent = '';
      banner.className = 'banner';
      bannerKind = '';
      return;
    }
    bannerKind = kind || 'error';
    banner.hidden = false;
    banner.textContent = text;
    banner.className = 'banner' + (kind ? ' ' + kind : '');
  }

  function labelOf(value) {
    return LABELS[value] || String(value || 'unknown');
  }

  function isKnown(value) {
    return Object.prototype.hasOwnProperty.call(LABELS, value);
  }

  function digitalIndexFor(value) {
    var index = DIGITAL_VALUES.indexOf(value);
    return index === -1 ? 0 : index;
  }

  function render() {
    cards.forEach(function (card, index) {
      var value = card.getAttribute('data-value');
      card.classList.toggle('active', value === state.soundOutput);
      card.classList.toggle('focused', row === 0 && index === cardIndex);
      card.disabled = busy;
    });

    digitalButtons.forEach(function (button, index) {
      var value = button.getAttribute('data-value');
      button.classList.toggle('active', value === state.soundOutputDigital);
      button.classList.toggle('focused', row === 1 && index === digitalIndex);
      button.disabled = busy;
    });

    avvalue.textContent = state.avSyncSpeaker === null ? '—' : String(state.avSyncSpeaker);
    minus.classList.toggle('focused', row === 2 && avIndex === 0);
    plus.classList.toggle('focused', row === 2 && avIndex === 1);
    minus.disabled = busy;
    plus.disabled = busy;

    if (busy) {
      setStatus('Applying…', 'pending');
    } else if (offline) {
      setStatus('Service unavailable', 'err');
    } else {
      var suffix = state.soundOutput === 'tv_speaker_optical_arc' ? ' · PCM' : '';
      setStatus('Playing through: ' + labelOf(state.soundOutput) + suffix, 'ok');
    }

    var needInfo = !offline && !busy &&
      state.soundOutput === 'tv_speaker_optical_arc' &&
      state.soundOutputDigital === 'passThrough';
    if (needInfo && bannerKind !== 'error') {
      showBanner(DUAL_WARNING, 'info');
    } else if (!needInfo && bannerKind === 'info' && banner.textContent === DUAL_WARNING) {
      showBanner('');
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

  function applyState(data) {
    state.soundOutput = data.soundOutput;
    state.desiredOutput = data.desiredOutput;
    state.avSyncSpeaker = typeof data.avSyncSpeaker === 'number' ? data.avSyncSpeaker : null;
    state.soundOutputDigital = data.soundOutputDigital || null;
  }

  function loadState() {
    if (busy) return Promise.resolve();
    return request('/state').then(function (data) {
      offline = false;
      showBanner('');
      applyState(data);
      if (!initialized) {
        initialized = true;
        cards.forEach(function (card, index) {
          if (card.getAttribute('data-value') === state.soundOutput) cardIndex = index;
        });
        digitalIndex = digitalIndexFor(state.soundOutputDigital);
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
      if (data.soundOutputDigital) state.soundOutputDigital = data.soundOutputDigital;
      if (data.digitalChanged) {
        digitalIndex = digitalIndexFor(state.soundOutputDigital);
        if (state.soundOutputDigital === 'auto') {
          showBanner('Dual output uses PCM, so Digital audio was switched to Auto. ' +
            'Choose Soundbar only for Dolby/DTS.', 'info');
        } else if (state.soundOutputDigital === 'passThrough') {
          showBanner('Digital audio switched to Pass Through, so the soundbar gets Dolby/DTS.', 'info');
        }
      } else {
        showBanner('');
      }
      offline = false;
    }).catch(function (err) {
      showBanner('Could not apply: ' + err.message);
    }).then(function () {
      busy = false;
      render();
    });
  }

  function applyDigital(value) {
    if (busy || DIGITAL_VALUES.indexOf(value) === -1) return;
    if (value === state.soundOutputDigital) return;
    busy = true;
    render();
    request('/digital', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: value })
    }).then(function (data) {
      state.soundOutputDigital = data.soundOutputDigital;
      offline = false;
      if (data.warning) showBanner(data.warning, 'info');
      else showBanner('');
    }).catch(function (err) {
      showBanner('Could not set digital audio: ' + err.message);
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

  function moveDigital(step) {
    digitalIndex = (digitalIndex + step + digitalButtons.length) % digitalButtons.length;
    render();
  }

  function activateCard() {
    var card = cards[cardIndex];
    if (card) applyOutput(card.getAttribute('data-value'));
  }

  function activateDigital() {
    var button = digitalButtons[digitalIndex];
    if (button) applyDigital(button.getAttribute('data-value'));
  }

  function onKey(event) {
    var key = event.key;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault();
      var step = key === 'ArrowLeft' ? -1 : 1;
      if (row === 0) moveCard(step);
      else if (row === 1) moveDigital(step);
      else { avIndex = avIndex === 0 ? 1 : 0; render(); }
      return;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      event.preventDefault();
      var next = row + (key === 'ArrowUp' ? -1 : 1);
      if (next < 0) next = ROWS.length - 1;
      if (next >= ROWS.length) next = 0;
      row = next;
      render();
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (row === 0) activateCard();
      else if (row === 1) activateDigital();
      else applyAvSync(avIndex === 0 ? -5 : 5);
      return;
    }
  }

  cards.forEach(function (card, index) {
    card.addEventListener('click', function () {
      row = 0;
      cardIndex = index;
      applyOutput(card.getAttribute('data-value'));
    });
    card.addEventListener('mouseenter', function () {
      row = 0;
      cardIndex = index;
      render();
    });
  });

  digitalButtons.forEach(function (button, index) {
    button.addEventListener('click', function () {
      row = 1;
      digitalIndex = index;
      applyDigital(button.getAttribute('data-value'));
    });
    button.addEventListener('mouseenter', function () {
      row = 1;
      digitalIndex = index;
      render();
    });
  });

  minus.addEventListener('click', function () { row = 2; avIndex = 0; applyAvSync(-5); });
  plus.addEventListener('click', function () { row = 2; avIndex = 1; applyAvSync(5); });
  minus.addEventListener('mouseenter', function () { row = 2; avIndex = 0; render(); });
  plus.addEventListener('mouseenter', function () { row = 2; avIndex = 1; render(); });

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
