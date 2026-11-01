function createBrowserMicrophone(onError, onLimit) {
  let media = null;
  let disposed = false;
  let limit;
  const interrupted = () => {
    dispose();
    onError(new DOMException('麦克风录音已中断。', 'NotReadableError'));
  };
  const hidden = () => {
    if (document.visibilityState === 'hidden') interrupted();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(limit);
    window.removeEventListener('pagehide', interrupted);
    document.removeEventListener('visibilitychange', hidden);
    for (const track of media?.getTracks() ?? []) {
      track.removeEventListener('ended', interrupted);
      track.stop();
    }
    media = null;
  };
  const stream = navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, autoGainControl: true, echoCancellation: false, noiseSuppression: false },
    video: false,
  }).then(result => {
    if (disposed || document.visibilityState === 'hidden') {
      result.getTracks().forEach(track => track.stop());
      throw new DOMException('录音已取消。', 'AbortError');
    }
    media = result;
    for (const track of media.getAudioTracks()) track.addEventListener('ended', interrupted, { once: true });
    window.addEventListener('pagehide', interrupted, { once: true });
    document.addEventListener('visibilitychange', hidden);
    limit = setTimeout(onLimit, 120000);
    return media;
  });
  return { stream, dispose };
}

export function installBrowserCapture(Session) {
  Session.prototype.acquire = async function(timings) {
    if (!this.claim()) throw new DOMException('麦克风正在使用。', 'InvalidStateError');
    let ready = false;
    try {
      if (this.cancelled) throw new DOMException('录音已取消。', 'AbortError');
      timings?.mark('device_requested');
      this.microphone = createBrowserMicrophone(error => this.fail(error), () => this.options.onLimit());
      const stream = await this.duringStartup(this.microphone.stream);
      ready = true;
      return stream;
    } finally {
      if (!ready) this.cancel();
    }
  };
}

export function installMicrophonePermission(WebviewElement) {
  const initialize = WebviewElement.prototype._initElement;
  const views = new Map();
  WebviewElement.prototype._initElement = function(endpoint, extension, options, parent) {
    if (extension?.id.value === 'openai.chatgpt') {
      const origin = new URL(this.webviewContentEndpoint(endpoint)).origin;
      this.element.allow += `; microphone ${origin}`;
      views.set(this.element, origin);
    }
    return initialize.call(this, endpoint, extension, options, parent);
  };
  const receive = event => {
    if (event.data?.type !== 'codex-web-transcribe' || event.ports.length !== 1) return;
    const allowed = [...views].some(([element, origin]) => element.isConnected && event.origin === origin && event.source?.parent === element.contentWindow);
    if (!allowed) return;
    const port = event.ports[0];
    const audio = event.data.audio;
    if (!(audio instanceof Blob) || !audio.type.startsWith('audio/') || audio.size === 0 || audio.size > 16 * 1024 * 1024) {
      port.postMessage({ error: '录音文件无效或超过 16 MiB。' });
      port.close();
      return;
    }
    const controller = new AbortController();
    port.onmessage = message => { if (message.data === 'abort') controller.abort(); };
    fetch('/api/voice/transcribe', { method: 'POST', headers: { 'Content-Type': audio.type }, body: audio, signal: controller.signal })
      .then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.message);
        return result;
      })
      .then(result => port.postMessage(result), error => port.postMessage({ error: error.message }))
      .finally(() => port.close());
  };
  window.addEventListener('message', receive);
  return { dispose: () => {
    WebviewElement.prototype._initElement = initialize;
    window.removeEventListener('message', receive);
    views.clear();
  } };
}

export function transcribeBrowserAudio(audio, { signal } = {}) {
  signal?.throwIfAborted();
  const origin = new URLSearchParams(location.search).get('parentOrigin');
  if (!origin || new URL(origin).protocol !== 'https:') throw new Error('无法确定语音输入的工作台地址。');
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      channel.port1.close();
    };
    const abort = () => {
      channel.port1.postMessage('abort');
      finish();
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      channel.port1.postMessage('abort');
      finish();
      reject(new Error('语音转写超过三分钟，请重新录音。'));
    }, 180000);
    channel.port1.onmessage = event => {
      finish();
      if (event.data.error) reject(new Error(event.data.error));
      else if (typeof event.data.text !== 'string') reject(new Error('语音转写返回内容无效。'));
      else resolve(event.data);
    };
    signal?.addEventListener('abort', abort, { once: true });
    window.top.postMessage({ type: 'codex-web-transcribe', audio }, origin, [channel.port2]);
  });
}
