(function registerAuditaScreenReaderModule(root) {
  'use strict';

  var namespaceKey = Symbol.for('audita.accessible-preview.runtime.v1');
  var descriptor = Object.getOwnPropertyDescriptor(root, namespaceKey);
  var namespace = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  if (!namespace || namespace.brand !== 'audita-accessible-preview' || namespace.version !== 1 ||
    typeof namespace.registerScreenReaderFactory !== 'function') {
    throw new Error('Runtime de prévia acessível ausente ou incompatível.');
  }

  namespace.registerScreenReaderFactory(function createScreenReaderModule(environment) {
    if (!environment || typeof environment !== 'object' ||
      typeof environment.collectCandidates !== 'function' ||
      typeof environment.render !== 'function' || typeof environment.publish !== 'function') {
      throw new TypeError('Ambiente do módulo Leitura simulada inválido.');
    }

    var queue = [];
    var index = -1;
    var playback = 'idle';
    var caption = '';
    var speechAvailability = environment.speechSynthesis ? 'available' : 'unavailable';
    var voiceId = '';
    var rate = 1;
    var originalFocus = null;
    var ownUtterance = null;
    var speechGeneration = 0;
    var unsubscribeFocus = null;
    var unsubscribeVoices = null;
    var suppressFocusElement = null;
    var sessionActive = false;
    var lifecycleGeneration = 0;

    function boundedCaption(value) {
      return typeof value === 'string'
        ? Array.from(value.replace(/\s+/gu, ' ').trim()).slice(0, 2048).join('')
        : '';
    }

    function boundedVoiceId(value) {
      if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return '';
      return Array.from(value.trim()).slice(0, 200).join('');
    }

    function boundedRate(value) {
      var numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric)) return 1;
      return Math.max(0.5, Math.min(2, numeric));
    }

    function safeCandidates(value) {
      if (!Array.isArray(value)) return [];
      var seen = new Set();
      var result = [];
      for (var position = 0; position < value.length && result.length < 2000; position += 1) {
        var candidate = value[position];
        if (!candidate || typeof candidate !== 'object' || !candidate.element || seen.has(candidate.element)) continue;
        var text = boundedCaption(candidate.caption);
        if (!text) continue;
        seen.add(candidate.element);
        result.push({ element: candidate.element, caption: text });
      }
      return result;
    }

    function state() {
      return {
        playback: playback,
        index: index,
        total: queue.length,
        caption: caption,
        canPrevious: playback !== 'idle' && index > 0,
        canNext: playback !== 'idle' && index >= 0 && index < queue.length - 1,
        speechAvailability: speechAvailability,
        voiceId: voiceId,
        rate: rate
      };
    }

    function publish(current) {
      var snapshot = state();
      try { environment.render(current || null, snapshot); } catch (_error) { /* visual fallback is optional */ }
      try { environment.publish(snapshot); } catch (_error) { /* worker channel can be absent */ }
      return snapshot;
    }

    function voices() {
      var synthesis = environment.speechSynthesis;
      if (!synthesis || typeof synthesis.getVoices !== 'function') return [];
      try {
        var listed = synthesis.getVoices();
        return Array.isArray(listed) ? listed.slice(0, 128) : [];
      } catch (_error) {
        speechAvailability = 'error';
        return [];
      }
    }

    function selectedVoice() {
      if (!voiceId) return null;
      return voices().find(function matchesVoice(voice) {
        return voice && typeof voice.voiceURI === 'string' && voice.voiceURI === voiceId;
      }) || null;
    }

    function invalidateOwnedSpeech(cancelOwned) {
      var synthesis = environment.speechSynthesis;
      var owned = ownUtterance;
      speechGeneration += 1;
      ownUtterance = null;
      if (!cancelOwned || !owned || !synthesis || typeof synthesis.cancel !== 'function') return;
      try { synthesis.cancel(); } catch (_error) { speechAvailability = 'error'; }
    }

    function speakCurrent() {
      var current = queue[index];
      if (!current || playback !== 'playing') return state();
      var synthesis = environment.speechSynthesis;
      var Utterance = environment.Utterance;
      if (!synthesis || typeof synthesis.speak !== 'function' || typeof Utterance !== 'function') {
        speechAvailability = 'unavailable';
        return publish(current);
      }
      if (!ownUtterance && (synthesis.speaking === true || synthesis.pending === true || synthesis.paused === true)) {
        speechAvailability = 'busy';
        return publish(current);
      }
      if (ownUtterance) invalidateOwnedSpeech(true);
      var generation = ++speechGeneration;
      var utterance;
      try {
        utterance = new Utterance(caption);
        utterance.lang = 'pt-BR';
        utterance.rate = rate;
        var voice = selectedVoice();
        if (voice) utterance.voice = voice;
        utterance.onend = function onSpeechEnd() {
          if (generation !== speechGeneration || ownUtterance !== utterance) return;
          ownUtterance = null;
          speechAvailability = 'available';
          publish(queue[index]);
        };
        utterance.onerror = function onSpeechError() {
          if (generation !== speechGeneration || ownUtterance !== utterance) return;
          ownUtterance = null;
          speechAvailability = 'error';
          publish(queue[index]);
        };
        ownUtterance = utterance;
        speechAvailability = 'available';
        synthesis.speak(utterance);
      } catch (_error) {
        if (generation === speechGeneration) ownUtterance = null;
        speechAvailability = 'error';
        return publish(current);
      }
      return state();
    }

    function show(position, options) {
      if (playback === 'idle' || !queue.length) return state();
      var bounded = Math.max(0, Math.min(queue.length - 1, position));
      index = bounded;
      var current = queue[index];
      caption = current.caption;
      publish(current); // Caption is always updated before speech.
      if (options && options.focus === true && typeof environment.focus === 'function') {
        suppressFocusElement = current.element;
        try { environment.focus(current.element, { preventScroll: true }); } catch (_error) { suppressFocusElement = null; }
      }
      if (playback === 'playing' && (!options || options.speak !== false)) speakCurrent();
      return state();
    }

    function handleFocus(element) {
      if (!sessionActive || playback === 'idle' || !element) return;
      if (suppressFocusElement === element) {
        suppressFocusElement = null;
        return;
      }
      var position = queue.findIndex(function findCandidate(candidate) { return candidate.element === element; });
      if (position < 0) return;
      show(position, { focus: false, speak: playback === 'playing' });
    }

    function handleVoicesChanged() {
      if (!sessionActive) return state();
      var listed = voices();
      if (voiceId && listed.length && !listed.some(function matchesVoice(voice) { return voice?.voiceURI === voiceId; })) {
        voiceId = '';
      }
      if (environment.speechSynthesis && speechAvailability === 'unavailable') speechAvailability = 'available';
      publish(queue[index]);
    }

    function subscribe() {
      var generation = lifecycleGeneration;
      if (!unsubscribeFocus && typeof environment.onFocus === 'function') {
        unsubscribeFocus = environment.onFocus(function onSessionFocus(element) {
          if (!sessionActive || generation !== lifecycleGeneration) return;
          handleFocus(element);
        });
      }
      if (!unsubscribeVoices && typeof environment.onVoicesChanged === 'function') {
        unsubscribeVoices = environment.onVoicesChanged(function onSessionVoicesChanged() {
          if (!sessionActive || generation !== lifecycleGeneration) return;
          handleVoicesChanged();
        });
      }
    }

    function unsubscribe() {
      try { unsubscribeFocus?.(); } catch (_error) { /* cleanup remains best effort */ }
      try { unsubscribeVoices?.(); } catch (_error) { /* cleanup remains best effort */ }
      unsubscribeFocus = null;
      unsubscribeVoices = null;
    }

    function start(preferences) {
      if (sessionActive && playback !== 'idle') return state();
      if (sessionActive) clearSession(false);
      if (preferences && typeof preferences === 'object') {
        voiceId = boundedVoiceId(preferences.voiceId);
        rate = boundedRate(preferences.rate);
      }
      originalFocus = typeof environment.activeElement === 'function' ? environment.activeElement() : null;
      sessionActive = true;
      lifecycleGeneration += 1;
      try { queue = safeCandidates(environment.collectCandidates()); }
      catch (_error) { queue = []; }
      playback = queue.length ? 'playing' : 'idle';
      index = queue.length ? 0 : -1;
      caption = queue.length ? queue[0].caption : '';
      speechAvailability = environment.speechSynthesis ? 'available' : 'unavailable';
      subscribe();
      var snapshot = publish(queue[index]);
      if (playback === 'playing') {
        speakCurrent();
        snapshot = state();
      }
      return snapshot;
    }

    function pause() {
      if (playback !== 'playing') return state();
      playback = 'paused';
      var synthesis = environment.speechSynthesis;
      if (ownUtterance && synthesis && typeof synthesis.pause === 'function') {
        try { synthesis.pause(); } catch (_error) { speechAvailability = 'error'; }
      }
      return publish(queue[index]);
    }

    function resume() {
      if (playback !== 'paused') return state();
      playback = 'playing';
      var synthesis = environment.speechSynthesis;
      if (ownUtterance && synthesis && synthesis.paused === true && typeof synthesis.resume === 'function') {
        try { synthesis.resume(); } catch (_error) { speechAvailability = 'error'; }
        return publish(queue[index]);
      }
      publish(queue[index]);
      return speakCurrent();
    }

    function stop() {
      if (!sessionActive && !unsubscribeFocus && !unsubscribeVoices && !ownUtterance) return state();
      return clearSession(true);
    }

    function clearSession(restoreOriginalFocus) {
      sessionActive = false;
      lifecycleGeneration += 1;
      invalidateOwnedSpeech(true);
      unsubscribe();
      var focusToRestore = originalFocus;
      queue = [];
      index = -1;
      playback = 'idle';
      caption = '';
      suppressFocusElement = null;
      originalFocus = null;
      var snapshot = publish(null);
      if (restoreOriginalFocus && focusToRestore && typeof environment.isSafeElement === 'function' &&
        environment.isSafeElement(focusToRestore) && typeof environment.restoreFocus === 'function') {
        try { environment.restoreFocus(focusToRestore, { preventScroll: true }); } catch (_error) { /* page focus can disappear */ }
      }
      return snapshot;
    }

    function repeat() {
      if (playback === 'idle' || index < 0) return state();
      publish(queue[index]);
      return playback === 'playing' ? speakCurrent() : state();
    }

    function setPreferences(preferences) {
      voiceId = boundedVoiceId(preferences?.voiceId);
      rate = boundedRate(preferences?.rate);
      var listed = voices();
      if (voiceId && listed.length && !listed.some(function matchesVoice(voice) { return voice?.voiceURI === voiceId; })) voiceId = '';
      return publish(queue[index]);
    }

    return Object.freeze({
      start: start,
      pause: pause,
      resume: resume,
      stop: stop,
      repeat: repeat,
      previous: function previous() { return show(index - 1, { focus: true }); },
      next: function next() { return show(index + 1, { focus: true }); },
      setPreferences: setPreferences,
      handleVoicesChanged: handleVoicesChanged,
      getState: state
    });
  });
})(globalThis);
