(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $$ = (selector, parent = document) => Array.from(parent.querySelectorAll(selector));
  const STORE = {
    memories: 'orbit.local.memories.v1',
    timeline: 'orbit.local.timeline.v1',
    autonomy: 'orbit.local.autonomy.v1'
  };

  const els = {
    appShell: $('appShell'),
    connectionChip: $('connectionChip'),
    connectionText: $('connectionText'),
    modelName: $('modelName'),
    modelButton: $('modelButton'),
    modelDialog: $('modelDialog'),
    modelStatusBox: $('modelStatusBox'),
    modelStatusTitle: $('modelStatusTitle'),
    modelStatusDescription: $('modelStatusDescription'),
    prompt: $('promptInput'),
    send: $('sendButton'),
    voice: $('voiceButton'),
    composerHint: $('composerHint'),
    attachment: $('attachmentButton'),
    fileInput: $('fileInput'),
    attachmentLabel: $('attachmentLabel'),
    avatarWrap: $('avatarWrap'),
    presenceScene: document.querySelector('.presence-scene'),
    presenceState: $('presenceState'),
    presenceSubstate: $('presenceSubstate'),
    sessionLabel: $('sessionLabel'),
    activityFeed: $('activityFeed'),
    autonomyToggle: $('autonomyToggle'),
    autonomyLabel: $('autonomyLabel'),
    runTitle: $('runTitle'),
    runDescription: $('runDescription'),
    planList: $('planList'),
    timeline: $('timeline'),
    responseSheet: $('responseSheet'),
    responseContent: $('responseContent'),
    responseMeta: $('responseMeta'),
    toastRegion: $('toastRegion'),
    memoryList: $('memoryList'),
    memoryCount: $('memoryCount'),
    memoryDialog: $('memoryDialog'),
    memoryInput: $('memoryInput'),
    privacyDialog: $('privacyDialog'),
    rendererDialog: $('rendererDialog'),
    commandPalette: $('commandPalette'),
    paletteInput: $('paletteInput'),
    paletteScrim: $('paletteScrim'),
    localVideo: $('localVideo'),
    cameraPlaceholder: $('cameraPlaceholder'),
    cameraStatus: $('cameraStatus'),
    studioLiveState: $('studioLiveState'),
    studioClock: $('studioClock'),
    studioStage: document.querySelector('.studio-stage'),
    startPresence: $('startPresenceButton'),
    presenceButtonLabel: $('presenceButtonLabel'),
    studioMic: $('studioMicButton'),
    studioMicLabel: $('studioMicLabel'),
    endPresence: $('endPresenceButton')
  };

  const state = {
    model: 'gemma4:31b',
    modelOnline: false,
    messages: [],
    memories: load(STORE.memories, []),
    timeline: load(STORE.timeline, []),
    autonomy: load(STORE.autonomy, false),
    sending: false,
    lastResponse: '',
    attachmentNames: [],
    recognition: null,
    recording: false,
    mediaStream: null,
    presenceStartedAt: null,
    presenceTimer: null,
    analyser: null,
    audioContext: null,
    animationFrame: null
  };

  const SYSTEM_PROMPT = `You are Orbit, a private local AI agent in an offline-first workspace. Be useful, grounded, concise, and intentional. Help the user turn an outcome into a clear plan or a finished answer. Never claim that you browsed, ran software, sent a message, edited a file, used a camera, or completed an external action unless a real connected tool explicitly reported it. For consequential actions, surface a proposed step and ask for approval. Prefer short sections and practical next steps. You are powered locally by Ollama.`;

  function load(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* local storage may be unavailable */ }
  }

  function safeText(value, limit = 180) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function toast(message, kind = '') {
    const node = document.createElement('div');
    node.className = `toast ${kind}`.trim();
    node.textContent = message;
    els.toastRegion.appendChild(node);
    window.setTimeout(() => {
      node.style.opacity = '0';
      node.style.transform = 'translateY(6px)';
      window.setTimeout(() => node.remove(), 240);
    }, 4200);
  }

  function setPresence(mode, detail) {
    const labels = {
      ready: ['Orbit is present', detail || 'Listening for an intention'],
      listening: ['Orbit is listening', detail || 'Put your thought into words'],
      thinking: ['Orbit is thinking', detail || 'Drafting a local response'],
      speaking: ['Orbit is speaking', detail || 'A response is ready'],
      offline: ['Orbit needs a local model', detail || 'Start Ollama to continue']
    };
    const [title, subtitle] = labels[mode] || labels.ready;
    els.presenceState.textContent = title;
    els.presenceSubstate.textContent = subtitle;
    els.avatarWrap.classList.toggle('listening', mode === 'listening');
    els.avatarWrap.classList.toggle('speaking', mode === 'speaking');
  }

  function setSending(sending) {
    state.sending = sending;
    els.send.disabled = sending;
    els.prompt.disabled = sending;
    if (sending) {
      els.sessionLabel.textContent = 'Thinking locally';
      els.send.setAttribute('aria-label', 'Orbit is thinking');
      setPresence('thinking');
    } else {
      els.send.setAttribute('aria-label', 'Send message');
    }
  }

  function renderMemory() {
    const count = state.memories.length;
    els.memoryCount.textContent = `${count} ${count === 1 ? 'item' : 'items'}`;
    els.memoryList.replaceChildren();
    if (!count) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<span>◇</span><p>Nothing has been saved yet.</p><small>When you choose to retain a detail, it will show up here.</small>';
      els.memoryList.appendChild(empty);
      return;
    }
    state.memories.slice().reverse().forEach((memory) => {
      const item = document.createElement('article');
      item.className = 'memory-item';
      const icon = document.createElement('i');
      icon.textContent = '◇';
      const body = document.createElement('div');
      const text = document.createElement('p');
      text.textContent = memory.text;
      const time = document.createElement('small');
      time.textContent = `Saved ${formatTime(memory.createdAt)}`;
      body.append(text, time);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Forget this memory');
      remove.textContent = '×';
      remove.addEventListener('click', () => removeMemory(memory.id));
      item.append(icon, body, remove);
      els.memoryList.appendChild(item);
    });
  }

  function addMemory(text) {
    const clean = safeText(text, 340);
    if (!clean) return;
    state.memories.push({ id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, text: clean, createdAt: Date.now() });
    save(STORE.memories, state.memories);
    renderMemory();
    closeDialog(els.memoryDialog);
    els.memoryInput.value = '';
    toast('Saved in private device memory.', 'success');
  }

  function removeMemory(id) {
    state.memories = state.memories.filter((memory) => memory.id !== id);
    save(STORE.memories, state.memories);
    renderMemory();
    toast('That memory was removed from this device.');
  }

  function clearMemory() {
    if (!state.memories.length) {
      toast('There is no saved memory on this device.');
      return;
    }
    if (!window.confirm('Forget every saved Orbit memory on this device?')) return;
    state.memories = [];
    save(STORE.memories, state.memories);
    renderMemory();
    toast('Private device memory cleared.', 'success');
  }

  function formatTime(timestamp) {
    try {
      return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
    } catch (_) {
      return 'just now';
    }
  }

  function renderTimeline() {
    els.timeline.replaceChildren();
    if (!state.timeline.length) {
      const empty = document.createElement('div');
      empty.className = 'timeline-empty';
      empty.innerHTML = '<span>○</span><p>Your useful moments will appear here.</p>';
      els.timeline.appendChild(empty);
      return;
    }
    state.timeline.slice(0, 4).forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'timeline-entry';
      const dot = document.createElement('i');
      const body = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = entry.title;
      const detail = document.createElement('small');
      detail.textContent = `${formatTime(entry.createdAt)} · ${entry.detail}`;
      body.append(title, detail);
      row.append(dot, body);
      els.timeline.appendChild(row);
    });
  }

  function addTimeline(title, detail) {
    state.timeline.unshift({ title: safeText(title, 70), detail: safeText(detail, 110), createdAt: Date.now() });
    state.timeline = state.timeline.slice(0, 20);
    save(STORE.timeline, state.timeline);
    renderTimeline();
  }

  function addActivity(title, detail, emphasis = false) {
    const current = els.activityFeed.querySelector('.activity-item.quiet');
    if (current) current.remove();
    const item = document.createElement('article');
    item.className = 'activity-item';
    const ring = document.createElement('span');
    ring.className = 'activity-ring';
    const copy = document.createElement('div');
    const strong = document.createElement('strong');
    const small = document.createElement('small');
    strong.textContent = title;
    small.textContent = detail;
    copy.append(strong, small);
    item.append(ring, copy);
    if (emphasis) item.style.borderColor = 'rgba(199,255,145,.18)';
    els.activityFeed.prepend(item);
    const items = $$('.activity-item', els.activityFeed);
    items.slice(3).forEach((node) => node.remove());
  }

  function determinePlan(prompt) {
    const lower = prompt.toLowerCase();
    if (/research|compare|find|learn|source|market|news/.test(lower)) {
      return {
        title: 'Research & brief',
        description: 'Orbit is framing the question, the evidence standard, and a reviewable synthesis before it proposes any outside lookup.',
        steps: [['Clarify the research question', 'Scope, assumptions, and what good evidence means', 'Working'], ['Map the perspectives', 'Source types and tensions to resolve', 'Queued'], ['Return a decision-ready brief', 'Claims, uncertainty, and next moves', 'Queued']]
      };
    }
    if (/build|code|app|website|prototype|debug|ship/.test(lower)) {
      return {
        title: 'Build a thoughtful path',
        description: 'Orbit is translating the request into a build brief, small milestones, and a safe review point before anything changes.',
        steps: [['Shape the build brief', 'Outcome, constraints, and definition of done', 'Working'], ['Design the smallest useful path', 'Components, risks, and dependencies', 'Queued'], ['Prepare a reviewable change set', 'Nothing is applied without your approval', 'Queued']]
      };
    }
    if (/plan|week|schedule|organize|focus|task/.test(lower)) {
      return {
        title: 'Make room for what matters',
        description: 'Orbit is looking for the real outcome, the finite time available, and a calm sequence that stays adaptable.',
        steps: [['Name the outcome', 'Distinguish essential work from noise', 'Working'], ['Make an honest route', 'Time, energy, and dependency-aware plan', 'Queued'], ['Hold a useful checkpoint', 'A short review instead of silent automation', 'Queued']]
      };
    }
    if (/write|draft|idea|launch|create|story|design/.test(lower)) {
      return {
        title: 'Shape the idea',
        description: 'Orbit is extracting the core intent, choosing a voice, and preparing a concrete first pass for your review.',
        steps: [['Find the sharpest intention', 'Audience, tone, and the useful constraint', 'Working'], ['Make a strong first pass', 'Structure before polish', 'Queued'], ['Refine with your judgment', 'Keep authorship and approval with you', 'Queued']]
      };
    }
    return {
      title: 'Turn intention into motion',
      description: 'Orbit is turning your words into a brief route and will keep consequential choices visible.',
      steps: [['Understand the outcome', 'Listen for the real job to be done', 'Working'], ['Draft a careful route', 'Sources, tools, and boundaries', 'Queued'], ['Bring back the useful parts', 'Reviewable, not hidden', 'Queued']]
    };
  }

  function updatePlan(prompt) {
    const plan = determinePlan(prompt);
    els.runTitle.textContent = plan.title;
    els.runDescription.textContent = plan.description;
    els.planList.replaceChildren();
    plan.steps.forEach((step, index) => {
      const item = document.createElement('li');
      item.className = `plan-item ${index === 0 ? 'current' : ''}`;
      const number = document.createElement('span');
      number.className = 'plan-index';
      number.textContent = String(index + 1).padStart(2, '0');
      const body = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = step[0];
      const detail = document.createElement('small');
      detail.textContent = step[1];
      body.append(name, detail);
      const status = document.createElement('span');
      status.className = `plan-state ${index ? 'muted' : ''}`;
      status.textContent = step[2];
      item.append(number, body, status);
      els.planList.appendChild(item);
    });
  }

  function updateModelUI(payload) {
    state.modelOnline = Boolean(payload && payload.online);
    const models = Array.isArray(payload?.models) ? payload.models : [];
    const exact = models.find((model) => model === state.model) || models.find((model) => model.startsWith('gemma4:31b'));
    if (exact) state.model = exact;
    els.modelName.textContent = state.model;
    els.connectionChip.classList.remove('checking', 'online', 'offline');
    els.modelStatusBox.classList.remove('online', 'offline');

    if (state.modelOnline) {
      els.connectionChip.classList.add('online');
      els.connectionText.textContent = 'Local model ready';
      els.modelStatusBox.classList.add('online');
      els.modelStatusTitle.textContent = exact ? `${exact} is available locally` : 'Ollama is online';
      els.modelStatusDescription.textContent = exact
        ? 'Orbit can use this local model without a cloud key.'
        : `Ollama found ${models.length} local ${models.length === 1 ? 'model' : 'models'}, but not gemma4:31b.`;
      setPresence('ready');
    } else {
      els.connectionChip.classList.add('offline');
      els.connectionText.textContent = 'Ollama offline';
      els.modelStatusBox.classList.add('offline');
      els.modelStatusTitle.textContent = 'Ollama is not reachable';
      els.modelStatusDescription.textContent = 'Start Ollama on this device, then install gemma4:31b to talk locally.';
      setPresence('offline');
    }
  }

  async function checkHealth() {
    els.connectionChip.classList.add('checking');
    try {
      const response = await fetch('/api/health', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('The local bridge did not respond.');
      const payload = await response.json();
      updateModelUI(payload);
      return payload;
    } catch (_) {
      const payload = { online: false, models: [] };
      updateModelUI(payload);
      return payload;
    }
  }

  function showResponse(text, meta = 'Generated locally') {
    state.lastResponse = text;
    els.responseContent.textContent = text;
    els.responseMeta.textContent = meta;
    els.responseSheet.hidden = false;
    els.responseSheet.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeResponse() {
    els.responseSheet.hidden = true;
  }

  function buildMessages(userText) {
    const memoryContext = state.memories.length
      ? `\n\nUser-approved device memory:\n${state.memories.map((m) => `- ${m.text}`).join('\n')}`
      : '';
    const current = [{ role: 'system', content: SYSTEM_PROMPT + memoryContext }, ...state.messages, { role: 'user', content: userText }];
    return current.slice(-18);
  }

  async function runPrompt(rawText) {
    const userText = safeText(rawText, 8000);
    if (!userText || state.sending) return;
    closeResponse();
    state.messages.push({ role: 'user', content: userText });
    state.messages = state.messages.slice(-14);
    updatePlan(userText);
    addActivity('Orbit is mapping the request', state.autonomy ? 'Autonomy is on; decisions remain visible' : 'Approval-first route');
    addTimeline('New intention', userText);
    els.prompt.value = '';
    resizeComposer();
    state.attachmentNames = [];
    els.attachmentLabel.hidden = true;
    els.attachmentLabel.textContent = '';
    setSending(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model: state.model, messages: buildMessages(userText) })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Local model request failed.');
      const content = safeText(payload?.message?.content || payload?.response, 12000);
      if (!content) throw new Error('The local model returned an empty response.');
      state.messages.push({ role: 'assistant', content });
      state.messages = state.messages.slice(-14);
      showResponse(content, `Generated with ${state.model} on this device`);
      addActivity('A local response is ready', 'Review the answer or continue the thread', true);
      addTimeline('Orbit prepared a response', content);
      els.sessionLabel.textContent = 'Response ready for review';
      setPresence('speaking', 'A local response is ready');
      window.setTimeout(() => {
        if (!('speechSynthesis' in window) || !window.speechSynthesis.speaking) setPresence('ready');
      }, 2100);
    } catch (error) {
      const detail = error?.message || 'Could not reach the local model.';
      showResponse(`Orbit could not reach ${state.model} locally.\n\n${detail}\n\nStart Ollama, make sure the model is installed, then try again:\nollama pull gemma4:31b`, 'No cloud fallback was used');
      addActivity('Local model needs attention', 'No cloud fallback was used');
      els.sessionLabel.textContent = 'Local model unavailable';
      setPresence('offline', 'No cloud fallback was used');
      toast('Orbit stayed local and did not use a cloud fallback.', 'error');
    } finally {
      setSending(false);
    }
  }

  function resizeComposer() {
    els.prompt.style.height = 'auto';
    els.prompt.style.height = `${Math.min(els.prompt.scrollHeight, 100)}px`;
  }

  function speakLastResponse() {
    if (!state.lastResponse) {
      toast('There is no response to read yet.');
      return;
    }
    speakText(state.lastResponse);
  }

  function speakText(text) {
    if (!('speechSynthesis' in window)) {
      toast('This browser does not expose a local speech voice.', 'error');
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 6000));
    utterance.rate = 1.03;
    utterance.pitch = 1;
    utterance.onstart = () => {
      setPresence('speaking', 'Reading from your device');
      els.studioStage.classList.add('live');
    };
    utterance.onend = utterance.onerror = () => {
      if (!state.mediaStream) els.studioStage.classList.remove('live');
      setPresence(state.modelOnline ? 'ready' : 'offline');
    };
    window.speechSynthesis.speak(utterance);
  }

  function startVoice() {
    if (state.recording) {
      state.recognition?.stop();
      return;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast('Speech input is not available in this browser. Type instead, or use a browser/device speech engine that runs locally.', 'error');
      els.prompt.focus();
      return;
    }
    try {
      const recognition = new SpeechRecognition();
      state.recognition = recognition;
      recognition.lang = navigator.language || 'en-US';
      recognition.continuous = false;
      recognition.interimResults = true;
      let finalText = '';
      recognition.onstart = () => {
        state.recording = true;
        els.voice.classList.add('recording');
        els.voice.setAttribute('aria-label', 'Stop listening');
        els.composerHint.textContent = 'Listening… speak naturally';
        setPresence('listening');
      };
      recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const phrase = event.results[i][0].transcript;
          if (event.results[i].isFinal) finalText += phrase;
          else interim += phrase;
        }
        els.prompt.value = finalText || interim;
        resizeComposer();
      };
      recognition.onerror = (event) => {
        if (event.error !== 'aborted' && event.error !== 'no-speech') toast(`Voice input: ${event.error}. You can keep using typed input.`, 'error');
      };
      recognition.onend = () => {
        const finalPrompt = safeText(finalText || els.prompt.value, 8000);
        state.recording = false;
        els.voice.classList.remove('recording');
        els.voice.setAttribute('aria-label', 'Speak to Orbit');
        els.composerHint.innerHTML = 'Press <kbd>⌘</kbd><kbd>↵</kbd> to send';
        if (finalPrompt) runPrompt(finalPrompt);
        else setPresence(state.modelOnline ? 'ready' : 'offline');
      };
      recognition.start();
    } catch (_) {
      toast('The browser could not start voice input. Type to Orbit instead.', 'error');
    }
  }

  function showView(viewName, options = {}) {
    const valid = ['home', 'workbench', 'memory', 'studio'];
    const name = valid.includes(viewName) ? viewName : 'home';
    $$('.view').forEach((view) => view.classList.toggle('active', view.dataset.view === name));
    $$('.rail-button[data-view-target]').forEach((button) => button.classList.toggle('active', button.dataset.viewTarget === name));
    if (name === 'studio') document.title = 'Orbit — Presence Studio';
    else if (name === 'workbench') document.title = 'Orbit — Agent Workspace';
    else if (name === 'memory') document.title = 'Orbit — Private Memory';
    else document.title = 'Orbit — Local Agent';
    if (options.focusComposer) window.setTimeout(() => els.prompt.focus(), 220);
    if (options.scroll !== false) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setAutonomy(enabled) {
    state.autonomy = Boolean(enabled);
    save(STORE.autonomy, state.autonomy);
    els.autonomyToggle.setAttribute('aria-pressed', String(state.autonomy));
    els.autonomyLabel.textContent = state.autonomy ? 'Propose & stage' : 'Approval-first';
    toast(state.autonomy
      ? 'Orbit can stage more of the plan, but still surfaces consequential decisions.'
      : 'Orbit will wait for approval before each proposed action.');
  }

  function openDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }

  function filterPalette() {
    const query = els.paletteInput.value.trim().toLowerCase();
    $$('.palette-list button').forEach((button) => {
      button.hidden = Boolean(query) && !button.textContent.toLowerCase().includes(query);
    });
  }

  function openPalette() {
    els.commandPalette.hidden = false;
    window.setTimeout(() => els.paletteInput.focus(), 10);
  }

  function closePalette() {
    els.commandPalette.hidden = true;
    els.paletteInput.value = '';
    filterPalette();
  }

  function handlePalette(action) {
    closePalette();
    if (action === 'speak') startVoice();
    if (action === 'workbench') showView('workbench');
    if (action === 'studio') showView('studio');
    if (action === 'memory') showView('memory');
  }

  async function startPresence() {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('This browser does not provide local camera capture.', 'error');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
      state.mediaStream = stream;
      els.localVideo.srcObject = stream;
      els.localVideo.classList.add('visible');
      els.cameraPlaceholder.classList.add('hidden');
      els.cameraStatus.classList.add('on');
      els.cameraStatus.innerHTML = '<i></i> Local only';
      els.startPresence.disabled = true;
      els.presenceButtonLabel.textContent = 'Local camera active';
      els.studioMic.disabled = false;
      els.endPresence.disabled = false;
      els.studioLiveState.textContent = 'Presence linked locally';
      els.studioStage.classList.add('live');
      state.presenceStartedAt = Date.now();
      startPresenceClock();
      prepareAudioVisuals(stream);
      setPresence('listening', 'Local camera and microphone are active');
      toast('Camera and microphone are active in this browser only.', 'success');
    } catch (error) {
      toast('Camera or microphone permission was not granted. Nothing was captured.', 'error');
    }
  }

  function startPresenceClock() {
    window.clearInterval(state.presenceTimer);
    state.presenceTimer = window.setInterval(() => {
      if (!state.presenceStartedAt) return;
      const seconds = Math.floor((Date.now() - state.presenceStartedAt) / 1000);
      const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
      const remainder = String(seconds % 60).padStart(2, '0');
      els.studioClock.textContent = `${minutes}:${remainder}`;
    }, 1000);
  }

  function prepareAudioVisuals(stream) {
    try {
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = state.audioContext.createMediaStreamSource(stream);
      state.analyser = state.audioContext.createAnalyser();
      state.analyser.fftSize = 64;
      source.connect(state.analyser);
      const data = new Uint8Array(state.analyser.frequencyBinCount);
      const drawAudio = () => {
        if (!state.analyser || !state.mediaStream) return;
        state.analyser.getByteFrequencyData(data);
        const level = data.reduce((sum, value) => sum + value, 0) / (data.length * 255);
        els.studioStage.style.setProperty('--voice-level', String(Math.max(.05, level)));
        els.avatarWrap.style.setProperty('--voice-level', String(Math.max(.05, level)));
        state.animationFrame = requestAnimationFrame(drawAudio);
      };
      drawAudio();
    } catch (_) {
      // Presence can still operate as a local camera preview without visualization.
    }
  }

  function toggleStudioMic() {
    if (!state.mediaStream) return;
    const audioTrack = state.mediaStream.getAudioTracks()[0];
    if (!audioTrack) {
      toast('No microphone track is available in this local preview.', 'error');
      return;
    }
    audioTrack.enabled = !audioTrack.enabled;
    const on = audioTrack.enabled;
    els.studioMicLabel.textContent = on ? 'Mic on' : 'Mic off';
    els.studioMic.classList.toggle('primary', on);
    toast(on ? 'Local microphone is on.' : 'Local microphone is muted.');
  }

  function endPresence() {
    state.mediaStream?.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
    state.presenceStartedAt = null;
    window.clearInterval(state.presenceTimer);
    if (state.animationFrame) cancelAnimationFrame(state.animationFrame);
    state.animationFrame = null;
    state.analyser = null;
    if (state.audioContext) state.audioContext.close().catch(() => {});
    state.audioContext = null;
    els.localVideo.srcObject = null;
    els.localVideo.classList.remove('visible');
    els.cameraPlaceholder.classList.remove('hidden');
    els.cameraStatus.classList.remove('on');
    els.cameraStatus.innerHTML = '<i></i> Off';
    els.startPresence.disabled = false;
    els.presenceButtonLabel.textContent = 'Start local camera';
    els.studioMic.disabled = true;
    els.studioMicLabel.textContent = 'Mic off';
    els.studioMic.classList.remove('primary');
    els.endPresence.disabled = true;
    els.studioLiveState.textContent = 'Avatar ready';
    els.studioClock.textContent = '00:00';
    els.studioStage.classList.remove('live');
    setPresence(state.modelOnline ? 'ready' : 'offline');
    toast('Local presence session ended.');
  }

  function drawSignalField() {
    const canvas = $('signalCanvas');
    const context = canvas.getContext('2d');
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let width = 0;
    let height = 0;
    let points = [];
    let frame = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.max(17, Math.round(width / 95));
      points = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.3 + .25,
        vx: (Math.random() - .5) * .08,
        vy: (Math.random() - .5) * .06,
        o: Math.random() * .25 + .08
      }));
    };

    const paint = () => {
      context.clearRect(0, 0, width, height);
      points.forEach((point, index) => {
        if (!reduce) {
          point.x += point.vx;
          point.y += point.vy;
          if (point.x < -10 || point.x > width + 10) point.vx *= -1;
          if (point.y < -10 || point.y > height + 10) point.vy *= -1;
        }
        context.beginPath();
        context.fillStyle = `rgba(183, 232, 187, ${point.o})`;
        context.arc(point.x, point.y, point.r, 0, Math.PI * 2);
        context.fill();
        for (let j = index + 1; j < points.length; j += 1) {
          const other = points[j];
          const dx = point.x - other.x;
          const dy = point.y - other.y;
          const distance = Math.hypot(dx, dy);
          if (distance < 108) {
            context.beginPath();
            context.moveTo(point.x, point.y);
            context.lineTo(other.x, other.y);
            context.strokeStyle = `rgba(142, 200, 177, ${.045 * (1 - distance / 108)})`;
            context.lineWidth = .5;
            context.stroke();
          }
        }
      });
      if (!reduce) frame = requestAnimationFrame(paint);
    };
    window.addEventListener('resize', resize, { passive: true });
    resize();
    paint();
    return () => cancelAnimationFrame(frame);
  }

  function attachEvents() {
    els.send.addEventListener('click', () => runPrompt(els.prompt.value));
    els.prompt.addEventListener('input', resizeComposer);
    els.prompt.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        runPrompt(els.prompt.value);
      }
    });
    els.voice.addEventListener('click', startVoice);
    els.attachment.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', () => {
      const files = Array.from(els.fileInput.files || []);
      state.attachmentNames = files.map((file) => file.name);
      if (!files.length) return;
      els.attachmentLabel.hidden = false;
      els.attachmentLabel.textContent = files.length === 1 ? files[0].name : `${files.length} local files`;
      toast('File selected locally. This starter bridge does not upload or send file contents to the model yet.');
    });

    $$('.intent-pill, .capability-tile').forEach((button) => button.addEventListener('click', () => {
      els.prompt.value = button.dataset.prompt || '';
      resizeComposer();
      showView('home', { focusComposer: true });
    }));
    $('homeBrand').addEventListener('click', () => showView('home'));
    $('returnHomeButton').addEventListener('click', () => showView('home', { focusComposer: true }));
    $('openWorkbench').addEventListener('click', () => showView('workbench'));
    $('capabilitiesButton').addEventListener('click', () => showView('workbench'));
    $('openStudioFromAvatar').addEventListener('click', () => showView('studio'));
    $$('[data-view-target]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.viewTarget)));
    $('newRunButton').addEventListener('click', () => showView('home', { focusComposer: true }));
    $('workbenchSettings').addEventListener('click', () => openDialog(els.privacyDialog));

    els.autonomyToggle.addEventListener('click', () => setAutonomy(!state.autonomy));
    $('privacyButton').addEventListener('click', () => openDialog(els.privacyDialog));
    $('renderInfoButton').addEventListener('click', () => openDialog(els.rendererDialog));

    els.modelButton.addEventListener('click', async () => {
      openDialog(els.modelDialog);
      await checkHealth();
    });
    els.connectionChip.addEventListener('click', async () => {
      await checkHealth();
      toast(state.modelOnline ? 'Local Ollama bridge is available.' : 'Ollama is not reachable on this device.', state.modelOnline ? 'success' : 'error');
    });
    $('copyModelCommand').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText('ollama pull gemma4:31b');
        toast('Local install command copied.', 'success');
      } catch (_) {
        toast('Copy this: ollama pull gemma4:31b');
      }
    });
    $$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => closeDialog($(button.dataset.closeDialog))));

    $('addMemoryButton').addEventListener('click', () => openDialog(els.memoryDialog));
    $('saveMemoryButton').addEventListener('click', () => addMemory(els.memoryInput.value));
    els.memoryInput.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') addMemory(els.memoryInput.value);
    });
    $('clearMemoryButton').addEventListener('click', clearMemory);

    $('closeResponseButton').addEventListener('click', closeResponse);
    $('speakResponseButton').addEventListener('click', speakLastResponse);
    $('reviewResponseButton').addEventListener('click', () => showView('workbench'));

    $('commandButton').addEventListener('click', openPalette);
    els.paletteScrim.addEventListener('click', closePalette);
    els.paletteInput.addEventListener('input', filterPalette);
    $$('.palette-list button').forEach((button) => button.addEventListener('click', () => handlePalette(button.dataset.paletteAction)));

    els.startPresence.addEventListener('click', startPresence);
    els.studioMic.addEventListener('click', toggleStudioMic);
    els.endPresence.addEventListener('click', endPresence);

    els.presenceScene.addEventListener('pointermove', (event) => {
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      const bounds = els.presenceScene.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width - .5) * 2;
      const y = ((event.clientY - bounds.top) / bounds.height - .5) * 2;
      els.avatarWrap.style.transform = `rotateY(${x * 3.6}deg) rotateX(${-y * 1.6}deg) translate3d(${x * 4}px, ${y * 2}px, 0)`;
    });
    els.presenceScene.addEventListener('pointerleave', () => { els.avatarWrap.style.transform = ''; });

    document.addEventListener('keydown', (event) => {
      const isPaletteOpen = !els.commandPalette.hidden;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        isPaletteOpen ? closePalette() : openPalette();
      }
      if (event.key === 'Escape') {
        if (isPaletteOpen) closePalette();
        else closeResponse();
      }
      if (!isPaletteOpen && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'v' && document.activeElement !== els.prompt && document.activeElement?.tagName !== 'TEXTAREA') {
        startVoice();
      }
    });

    window.addEventListener('beforeunload', endPresence);
  }

  function init() {
    renderMemory();
    renderTimeline();
    els.autonomyToggle.setAttribute('aria-pressed', String(state.autonomy));
    els.autonomyLabel.textContent = state.autonomy ? 'Propose & stage' : 'Approval-first';
    attachEvents();
    resizeComposer();
    drawSignalField();
    checkHealth();
  }

  init();
})();
