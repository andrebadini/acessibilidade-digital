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
    var speechAvailability = 'unavailable';
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
    var nativeVoicePrototype = trustedNativeVoicePrototype();
    var nativeSynthesisPrototype = trustedNativeSynthesisPrototype();

    function trustedNativeVoicePrototype() {
      try {
        var constructorDescriptor = Object.getOwnPropertyDescriptor(root, 'SpeechSynthesisVoice');
        var Constructor = constructorDescriptor && Object.hasOwn(constructorDescriptor, 'value')
          ? constructorDescriptor.value
          : null;
        if (typeof Constructor !== 'function') return null;
        var prototypeDescriptor = Object.getOwnPropertyDescriptor(Constructor, 'prototype');
        return prototypeDescriptor && Object.hasOwn(prototypeDescriptor, 'value')
          ? prototypeDescriptor.value
          : null;
      } catch (_error) { return null; }
    }

    function trustedNativeSynthesisPrototype() {
      try {
        var constructorDescriptor = Object.getOwnPropertyDescriptor(root, 'SpeechSynthesis');
        var Constructor = constructorDescriptor && Object.hasOwn(constructorDescriptor, 'value')
          ? constructorDescriptor.value
          : null;
        if (typeof Constructor !== 'function') return null;
        var prototypeDescriptor = Object.getOwnPropertyDescriptor(Constructor, 'prototype');
        return prototypeDescriptor && Object.hasOwn(prototypeDescriptor, 'value')
          ? prototypeDescriptor.value
          : null;
      } catch (_error) { return null; }
    }

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

    function dataMethod(value, key) {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
      try {
        var current = value;
        for (var depth = 0; current && depth < 4; depth += 1) {
          var descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (descriptor) {
            return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
              ? descriptor.value
              : null;
          }
          current = Object.getPrototypeOf(current);
        }
      } catch (_error) { return null; }
      return null;
    }

    function synthesisBoolean(synthesis, key) {
      try {
        var own = Object.getOwnPropertyDescriptor(synthesis, key);
        if (own) {
          return Object.hasOwn(own, 'value') && typeof own.value === 'boolean'
            ? { ok: true, value: own.value }
            : { ok: false, value: false };
        }
        if (!nativeSynthesisPrototype || Object.getPrototypeOf(synthesis) !== nativeSynthesisPrototype) {
          return { ok: false, value: false };
        }
        var descriptor = Object.getOwnPropertyDescriptor(nativeSynthesisPrototype, key);
        if (!descriptor || typeof descriptor.get !== 'function' || descriptor.set !== undefined) {
          return { ok: false, value: false };
        }
        var value = descriptor.get.call(synthesis);
        return typeof value === 'boolean' ? { ok: true, value: value } : { ok: false, value: false };
      } catch (_error) { return { ok: false, value: false }; }
    }

    function synthesisBusy(synthesis) {
      var speaking = synthesisBoolean(synthesis, 'speaking');
      var pending = synthesisBoolean(synthesis, 'pending');
      var paused = synthesisBoolean(synthesis, 'paused');
      if (!speaking.ok || !pending.ok || !paused.ok) return null;
      return speaking.value || pending.value || paused.value;
    }

    function denseVoiceEntries(value) {
      try {
        if (!Array.isArray(value)) return null;
        var descriptors = Object.getOwnPropertyDescriptors(value);
        var lengthDescriptor = descriptors.length;
        if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
          !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
          lengthDescriptor.value > 128 || Reflect.ownKeys(descriptors).length !== lengthDescriptor.value + 1) return null;
        var entries = new Array(lengthDescriptor.value);
        for (var position = 0; position < lengthDescriptor.value; position += 1) {
          var descriptor = descriptors[String(position)];
          if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
          entries[position] = descriptor.value;
        }
        return entries;
      } catch (_error) { return null; }
    }

    function ownVoiceValue(descriptors, key) {
      var descriptor = descriptors[key];
      if (!descriptor) return { present: false, value: undefined };
      if (!Object.hasOwn(descriptor, 'value')) return null;
      return { present: true, value: descriptor.value };
    }

    function nativeVoiceValue(voice, key) {
      if (!nativeVoicePrototype) return null;
      try {
        if (Object.getPrototypeOf(voice) !== nativeVoicePrototype) return null;
        var descriptor = Object.getOwnPropertyDescriptor(nativeVoicePrototype, key);
        if (!descriptor || typeof descriptor.get !== 'function' || descriptor.set !== undefined) return null;
        return { present: true, value: descriptor.get.call(voice) };
      } catch (_error) { return null; }
    }

    function projectVoice(voice) {
      if (!voice || typeof voice !== 'object') return null;
      var descriptors;
      try {
        descriptors = Object.getOwnPropertyDescriptors(voice);
      } catch (_error) { return null; }
      var ownLocal = ownVoiceValue(descriptors, 'localService');
      if (!ownLocal) return null;
      var read;
      if (ownLocal.present) read = function readOwn(key) { return ownVoiceValue(descriptors, key); };
      else {
        try {
          if (!nativeVoicePrototype || Object.getPrototypeOf(voice) !== nativeVoicePrototype) return { local: false };
        } catch (_error) { return null; }
        read = function readNative(key) { return nativeVoiceValue(voice, key); };
      }
      var local = read('localService');
      if (!local) return null;
      if (!local.present || local.value !== true) return { local: false };
      var uri = read('voiceURI');
      if (!uri || !uri.present) return null;
      var canonicalId = boundedVoiceId(uri.value);
      if (!canonicalId || canonicalId !== uri.value) return null;
      for (var optionalKey of ['name', 'lang']) {
        var optional = read(optionalKey);
        if (!optional || (optional.present && typeof optional.value !== 'string')) return null;
      }
      return { local: true, voiceId: canonicalId, voice: voice };
    }

    function localVoiceInventory() {
      var synthesis = environment.speechSynthesis;
      if (!synthesis) return { status: 'unavailable', voices: [] };
      var getVoices = dataMethod(synthesis, 'getVoices');
      if (!getVoices) return { status: 'error', voices: [] };
      try {
        var entries = denseVoiceEntries(getVoices.call(synthesis));
        if (!entries) return { status: 'error', voices: [] };
        var projected = [];
        var ids = new Set();
        for (var entry of entries) {
          var voice = projectVoice(entry);
          if (!voice) return { status: 'error', voices: [] };
          if (!voice.local) continue;
          if (ids.has(voice.voiceId)) return { status: 'error', voices: [] };
          ids.add(voice.voiceId);
          projected.push(voice);
        }
        return { status: 'available', voices: projected };
      } catch (_error) {
        return { status: 'error', voices: [] };
      }
    }

    function selectedVoice() {
      var inventory = localVoiceInventory();
      if (!voiceId) {
        speechAvailability = inventory.status === 'error' ? 'error' : 'unavailable';
        return null;
      }
      var selected = inventory.voices.find(function matchesVoice(voice) { return voice.voiceId === voiceId; }) || null;
      if (!selected) {
        voiceId = '';
        speechAvailability = inventory.status === 'error' ? 'error' : 'unavailable';
        return null;
      }
      speechAvailability = 'available';
      return selected.voice;
    }

    function invalidateOwnedSpeech(cancelOwned) {
      var synthesis = environment.speechSynthesis;
      var owned = ownUtterance;
      speechGeneration += 1;
      ownUtterance = null;
      if (!cancelOwned || !owned || !synthesis) return;
      var cancel = dataMethod(synthesis, 'cancel');
      if (!cancel) { speechAvailability = 'error'; return; }
      try { cancel.call(synthesis); } catch (_error) { speechAvailability = 'error'; }
    }

    function speakCurrent() {
      var current = queue[index];
      if (!current || playback !== 'playing') return state();
      var synthesis = environment.speechSynthesis;
      var Utterance = environment.Utterance;
      if (!synthesis || typeof Utterance !== 'function') {
        speechAvailability = 'unavailable';
        return publish(current);
      }
      var voice = selectedVoice();
      if (!voice) {
        if (ownUtterance) invalidateOwnedSpeech(true);
        return publish(current);
      }
      var speak = dataMethod(synthesis, 'speak');
      if (!speak) {
        speechAvailability = 'error';
        return publish(current);
      }
      if (!ownUtterance) {
        var busy = synthesisBusy(synthesis);
        if (busy === null) {
          speechAvailability = 'error';
          return publish(current);
        }
        if (busy) {
          speechAvailability = 'busy';
          return publish(current);
        }
      }
      if (ownUtterance) invalidateOwnedSpeech(true);
      var generation = ++speechGeneration;
      var utterance;
      try {
        utterance = new Utterance(caption);
        utterance.lang = 'pt-BR';
        utterance.rate = rate;
        voice = selectedVoice();
        if (!voice) return publish(current);
        utterance.voice = voice;
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
        speak.call(synthesis, utterance);
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
      var selected = selectedVoice();
      if (!selected && ownUtterance) invalidateOwnedSpeech(true);
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
      speechAvailability = 'unavailable';
      subscribe();
      selectedVoice();
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
      var pauseSpeech = dataMethod(synthesis, 'pause');
      if (ownUtterance && synthesis && pauseSpeech) {
        try { pauseSpeech.call(synthesis); } catch (_error) { speechAvailability = 'error'; }
      }
      return publish(queue[index]);
    }

    function resume() {
      if (playback !== 'paused') return state();
      playback = 'playing';
      var synthesis = environment.speechSynthesis;
      var paused = synthesis ? synthesisBoolean(synthesis, 'paused') : null;
      var resumeSpeech = dataMethod(synthesis, 'resume');
      if (ownUtterance && synthesis && paused?.ok && paused.value && resumeSpeech) {
        try { resumeSpeech.call(synthesis); } catch (_error) { speechAvailability = 'error'; }
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
      selectedVoice();
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
