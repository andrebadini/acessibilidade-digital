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
    var pendingSpeechActions = [];
    var pendingSpeechTerminal = false;
    var pendingSpeechOverflow = false;
    // Overflow discards the queue and schedules one terminal stop after the
    // currently audible Audita utterance. It never touches the shared queue.
    var MAX_PENDING_SPEECH_ACTIONS = 32;
    var speechGeneration = 0;
    var unsubscribeFocus = null;
    var unsubscribeVoices = null;
    var suppressFocusElement = null;
    var sessionActive = false;
    var lifecycleGeneration = 0;
    var nativeVoicePrototype = trustedNativePrototype('SpeechSynthesisVoice');
    var nativeSynthesisPrototype = trustedNativePrototype('SpeechSynthesis');
    var nativeUtterancePrototype = trustedNativePrototype('SpeechSynthesisUtterance');
    var speechSynthesis = ownDataValue(environment, 'speechSynthesis');
    var Utterance = ownDataValue(environment, 'Utterance');
    var onTerminal = ownDataValue(environment, 'onTerminal');
    if (typeof onTerminal !== 'function') onTerminal = null;

    function ownDataValue(holder, key) {
      try {
        var descriptor = Object.getOwnPropertyDescriptor(holder, key);
        return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
      } catch (_error) { return null; }
    }

    function trustedNativePrototype(name) {
      try {
        var current = root;
        var Constructor = null;
        for (var depth = 0; current && depth < 6; depth += 1) {
          var constructorDescriptor = Object.getOwnPropertyDescriptor(current, name);
          if (constructorDescriptor) {
            if (!Object.hasOwn(constructorDescriptor, 'value')) return null;
            Constructor = constructorDescriptor.value;
            break;
          }
          current = Object.getPrototypeOf(current);
        }
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

    function boundedVoiceLabel(value, fallback) {
      if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return fallback;
      var label = Array.from(value.replace(/\s+/gu, ' ').trim()).slice(0, 200).join('');
      return label || fallback;
    }

    function boundedVoiceLanguage(value) {
      if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return '';
      return Array.from(value.trim()).slice(0, 64).join('');
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

    function actionResult(actionStatus, snapshot) {
      return Object.freeze(Object.assign({ actionStatus: actionStatus }, snapshot || state()));
    }

    function signalTerminal(reason) {
      if (!onTerminal) return;
      try { onTerminal(reason); } catch (_error) { /* the local owner still observes the terminal state */ }
    }

    function nativeMethod(value, prototype, key) {
      if (!value || !prototype || typeof value !== 'object') return null;
      try {
        if (Object.getPrototypeOf(value) !== prototype) return null;
        if (Object.getOwnPropertyDescriptor(value, key)) return null;
        var descriptor = Object.getOwnPropertyDescriptor(prototype, key);
        return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
          ? descriptor.value
          : null;
      } catch (_error) { return null; }
    }

    function synthesisBoolean(synthesis, key) {
      try {
        if (!nativeSynthesisPrototype || Object.getPrototypeOf(synthesis) !== nativeSynthesisPrototype) {
          return { ok: false, value: false };
        }
        if (Object.getOwnPropertyDescriptor(synthesis, key)) return { ok: false, value: false };
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

    function nativeVoiceValue(voice, key) {
      if (!nativeVoicePrototype) return null;
      try {
        if (Object.getPrototypeOf(voice) !== nativeVoicePrototype) return null;
        if (Object.getOwnPropertyDescriptor(voice, key)) return null;
        var descriptor = Object.getOwnPropertyDescriptor(nativeVoicePrototype, key);
        if (!descriptor || typeof descriptor.get !== 'function' || descriptor.set !== undefined) return null;
        return { present: true, value: descriptor.get.call(voice) };
      } catch (_error) { return null; }
    }

    function projectVoice(voice) {
      if (!voice || typeof voice !== 'object') return null;
      try {
        if (!nativeVoicePrototype || Object.getPrototypeOf(voice) !== nativeVoicePrototype) return { local: false };
      } catch (_error) { return null; }
      var read = function readNative(key) { return nativeVoiceValue(voice, key); };
      var local = read('localService');
      if (!local) return null;
      if (!local.present || local.value !== true) return { local: false };
      var uri = read('voiceURI');
      if (!uri || !uri.present) return null;
      var canonicalId = boundedVoiceId(uri.value);
      if (!canonicalId || canonicalId !== uri.value) return null;
      var name = read('name');
      var language = read('lang');
      if (!name || !language || typeof name.value !== 'string' || typeof language.value !== 'string') return null;
      var canonicalLanguage = boundedVoiceLanguage(language.value);
      if (canonicalLanguage !== language.value.trim()) return null;
      return {
        local: true,
        voiceId: canonicalId,
        label: boundedVoiceLabel(name.value, canonicalId),
        lang: canonicalLanguage,
        voice: voice
      };
    }

    function localVoiceInventory() {
      var synthesis = speechSynthesis;
      if (!synthesis) return { status: 'unavailable', voices: [] };
      var getVoices = nativeMethod(synthesis, nativeSynthesisPrototype, 'getVoices');
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

    function invalidateOwnedSpeech() {
      speechGeneration += 1;
      ownUtterance = null;
      pendingSpeechActions = [];
      pendingSpeechTerminal = false;
      pendingSpeechOverflow = false;
    }

    function deferUntilSpeechEnds(action) {
      if (pendingSpeechTerminal) return actionResult('rejected', publish(queue[index]));
      var actionStatus = 'accepted';
      if (action.type === 'stop') {
        pendingSpeechActions = [{ type: 'stop' }];
        pendingSpeechTerminal = true;
      } else if (pendingSpeechActions.length >= MAX_PENDING_SPEECH_ACTIONS) {
        pendingSpeechActions = [{ type: 'stop' }];
        pendingSpeechTerminal = true;
        pendingSpeechOverflow = true;
        speechAvailability = 'error';
        actionStatus = 'terminal';
      } else {
        pendingSpeechActions.push(action);
      }
      if (!pendingSpeechOverflow) {
        var busy = synthesisBusy(speechSynthesis);
        speechAvailability = busy === null ? 'error' : (busy ? 'busy' : speechAvailability);
      }
      var snapshot = publish(queue[index]);
      if (actionStatus === 'terminal') signalTerminal('queue-overflow');
      return actionResult(actionStatus, snapshot);
    }

    function drainPendingSpeechActions() {
      while (!ownUtterance && pendingSpeechActions.length) {
        var action = pendingSpeechActions.shift();
        if (action.type === 'stop') {
          clearSession(true);
          return;
        }
        if (action.type === 'pause') {
          if (playback === 'playing') playback = 'paused';
          publish(queue[index]);
          continue;
        }
        if (action.type === 'resume') {
          if (playback === 'paused') playback = 'playing';
          if (playback === 'playing') {
            publish(queue[index]);
            speakCurrent();
          }
          continue;
        }
        if (action.type === 'repeat') {
          if (playback !== 'idle' && index >= 0) {
            publish(queue[index]);
            if (playback === 'playing') speakCurrent();
          }
          continue;
        }
        if (action.type === 'next' || action.type === 'previous') {
          var offset = action.type === 'next' ? 1 : -1;
          show(index + offset, { focus: true, speak: true });
          continue;
        }
        if (action.type === 'focus') {
          var position = queue.findIndex(function findPendingCandidate(candidate) {
            return candidate.element === action.element;
          });
          if (position >= 0) show(position, { focus: false, speak: true });
        }
      }
      if (sessionActive && !ownUtterance) publish(queue[index]);
    }

    function settleOwnedSpeech(utterance, generation, failed) {
      if (generation !== speechGeneration || ownUtterance !== utterance) return;
      ownUtterance = null;
      if (failed || pendingSpeechOverflow) speechAvailability = 'error';
      else {
        var availableVoice = selectedVoice();
        if (availableVoice) {
          var busy = synthesisBusy(speechSynthesis);
          speechAvailability = busy === null ? 'error' : (busy ? 'busy' : 'available');
        }
      }
      if (!pendingSpeechActions.length) {
        publish(queue[index]);
        return;
      }
      drainPendingSpeechActions();
    }

    function speakCurrent() {
      var current = queue[index];
      if (!current || playback !== 'playing') return state();
      var synthesis = speechSynthesis;
      if (!synthesis || typeof Utterance !== 'function') {
        speechAvailability = 'unavailable';
        return publish(current);
      }
      var voice = selectedVoice();
      if (!voice) {
        return publish(current);
      }
      var speak = nativeMethod(synthesis, nativeSynthesisPrototype, 'speak');
      if (!speak) {
        speechAvailability = 'error';
        return publish(current);
      }
      // Web Speech exposes one global queue and no per-utterance stop. A reference
      // to our utterance is therefore not proof that cancel/pause/resume is safe.
      if (ownUtterance) {
        deferUntilSpeechEnds({ type: 'repeat' });
        return state();
      }
      var busy = synthesisBusy(synthesis);
      if (busy === null) {
        speechAvailability = 'error';
        return publish(current);
      }
      if (busy) {
        speechAvailability = 'busy';
        return publish(current);
      }
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
          settleOwnedSpeech(utterance, generation, false);
        };
        utterance.onerror = function onSpeechError() {
          settleOwnedSpeech(utterance, generation, true);
        };
        var confirmedVoice = selectedVoice();
        if (!confirmedVoice || confirmedVoice !== voice || assignedUtteranceVoice(utterance) !== confirmedVoice) {
          ownUtterance = null;
          if (confirmedVoice) speechAvailability = 'error';
          return publish(current);
        }
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

    function assignedUtteranceVoice(utterance) {
      if (!nativeUtterancePrototype) return null;
      try {
        if (Object.getPrototypeOf(utterance) !== nativeUtterancePrototype) return null;
        if (Object.getOwnPropertyDescriptor(utterance, 'voice')) return null;
        var descriptor = Object.getOwnPropertyDescriptor(nativeUtterancePrototype, 'voice');
        if (!descriptor || typeof descriptor.get !== 'function') return null;
        return descriptor.get.call(utterance);
      } catch (_error) { return null; }
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
      if (ownUtterance && playback === 'playing') {
        deferUntilSpeechEnds({ type: 'focus', element: element });
        return;
      }
      show(position, { focus: false, speak: playback === 'playing' });
    }

    function handleVoicesChanged() {
      if (!sessionActive) return state();
      var selected = selectedVoice();
      if (selected) {
        var busy = synthesisBusy(speechSynthesis);
        speechAvailability = busy === null ? 'error' : (busy ? 'busy' : 'available');
      }
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
      pendingSpeechActions = [];
      pendingSpeechTerminal = false;
      pendingSpeechOverflow = false;
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
      if (playback !== 'playing') return actionResult('rejected');
      if (ownUtterance) return deferUntilSpeechEnds({ type: 'pause' });
      playback = 'paused';
      return actionResult('accepted', publish(queue[index]));
    }

    function resume() {
      if (ownUtterance) return deferUntilSpeechEnds({ type: 'resume' });
      if (playback === 'idle') {
        return actionResult('accepted', start({ voiceId: voiceId, rate: rate }));
      }
      if (playback !== 'paused') return actionResult('rejected');
      playback = 'playing';
      publish(queue[index]);
      return actionResult('accepted', speakCurrent());
    }

    function stop() {
      if (!sessionActive && !unsubscribeFocus && !unsubscribeVoices && !ownUtterance) {
        return actionResult('rejected');
      }
      if (ownUtterance) return deferUntilSpeechEnds({ type: 'stop' });
      return actionResult('accepted', clearSession(true));
    }

    function clearSession(restoreOriginalFocus) {
      sessionActive = false;
      lifecycleGeneration += 1;
      invalidateOwnedSpeech();
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
      if (playback === 'idle' || index < 0) return actionResult('rejected');
      if (ownUtterance && playback === 'playing') return deferUntilSpeechEnds({ type: 'repeat' });
      publish(queue[index]);
      return actionResult('accepted', playback === 'playing' ? speakCurrent() : state());
    }

    function navigate(direction) {
      if (playback === 'idle' || !queue.length) return actionResult('rejected');
      if (ownUtterance && playback === 'playing') {
        return deferUntilSpeechEnds({ type: direction });
      }
      return actionResult('accepted', show(index + (direction === 'next' ? 1 : -1), { focus: true }));
    }

    function setPreferences(preferences) {
      var requestedVoiceId = boundedVoiceId(preferences?.voiceId);
      var requestedRate = boundedRate(preferences?.rate);
      var inventory = localVoiceInventory();
      var selected = inventory.voices.find(function matchesRequestedVoice(voice) {
        return voice.voiceId === requestedVoiceId;
      }) || null;
      if (!requestedVoiceId || !selected) return publish(queue[index]);
      voiceId = requestedVoiceId;
      rate = requestedRate;
      speechAvailability = 'available';
      return publish(queue[index]);
    }

    function listLocalVoices() {
      var inventory = localVoiceInventory();
      return {
        status: inventory.status,
        voices: inventory.voices.map(function publicVoice(voice) {
          return { id: voice.voiceId, label: voice.label, lang: voice.lang };
        })
      };
    }

    return Object.freeze({
      start: start,
      pause: pause,
      resume: resume,
      stop: stop,
      repeat: repeat,
      previous: function previous() { return navigate('previous'); },
      next: function next() { return navigate('next'); },
      setPreferences: setPreferences,
      listLocalVoices: listLocalVoices,
      handleVoicesChanged: handleVoicesChanged,
      getState: state
    });
  });
})(globalThis);
