const el = id => document.getElementById(id);
const local = el('local');
const remote = el('remote');
const status = el('status');
const AudioMixer = window.AudioContext || window.webkitAudioContext;
const canRecord = Boolean(window.MediaRecorder && AudioMixer && HTMLCanvasElement.prototype.captureStream);
let active = null;
let downloadUrl = null;

function stopTracks(stream) {
  stream?.getTracks().forEach(track => track.stop());
}

function pack(id, description) {
  const payload = JSON.stringify({ id, type: description.type, sdp: description.sdp });
  const bytes = new TextEncoder().encode(payload);
  const base64 = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
  return base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function unpack(value, type) {
  try {
    const input = value.trim();
    if (!input || input.length > 120000) throw new Error();
    let code = input;
    if (type === 'offer') {
      const invitation = new URL(input);
      if (invitation.origin !== location.origin || invitation.pathname !== location.pathname) throw new Error();
      code = new URLSearchParams(invitation.hash.slice(1)).get('join');
    }
    if (!code || !/^[a-zA-Z0-9_-]+$/.test(code)) throw new Error();
    const bytes = Uint8Array.from(atob(code.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed.id !== 'string' || !/^[a-f0-9-]{36}$/.test(parsed.id)
      || parsed.type !== type || typeof parsed.sdp !== 'string' || !parsed.sdp.startsWith('v=0')) throw new Error();
    return parsed;
  } catch {
    throw new Error(type === 'offer' ? 'इस Rea पेज का पूरा निमंत्रण लिंक पेस्ट करें।' : 'दूसरे सदस्य का पूरा जवाब कोड पेस्ट करें।');
  }
}

function sendControl(call, message) {
  if (call.channel?.readyState === 'open') call.channel.send(message);
}

function finish(call, message) {
  if (active !== call) return;
  active = null;
  clearTimeout(call.disconnect);
  call.cancel.abort();
  if (call.recorder?.state === 'recording') call.recorder.stop();
  sendControl(call, 'hangup');
  call.pc?.close();
  stopTracks(call.stream);
  local.srcObject = remote.srcObject = null;
  for (const id of ['exchange', 'end', 'record', 'unmute', 'their-recording', 'record-help']) el(id).hidden = true;
  el('setup').hidden = false;
  el('outgoing').value = el('reply').value = '';
  el('accept').disabled = false;
  status.textContent = message;
}

function bindChannel(call, channel) {
  if (active !== call || channel.label !== 'rea-call') { channel.close(); return; }
  call.channel = channel;
  channel.onmessage = ({ data }) => {
    if (active !== call) return;
    if (data === 'hangup') finish(call, 'दूसरे सदस्य ने कॉल समाप्त कर दी।');
    if (data === 'recording-on' || data === 'recording-off') el('their-recording').hidden = data === 'recording-off';
  };
  channel.onclose = () => {
    if (active === call) finish(call, 'दूसरे सदस्य से कनेक्शन बंद हो गया।');
  };
}

function gather(call) {
  const pc = call.pc;
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    function done() {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', changed);
      call.cancel.signal.removeEventListener('abort', done);
      resolve();
    }
    function changed() { if (pc.iceGatheringState === 'complete') done(); }
    const timer = setTimeout(done, 8500);
    pc.addEventListener('icegatheringstatechange', changed);
    call.cancel.signal.addEventListener('abort', done, { once: true });
  });
}

function stateChanged(call) {
  if (active !== call) return;
  const state = call.pc.connectionState;
  clearTimeout(call.disconnect);
  if (state === 'connected') {
    status.textContent = 'कॉल जुड़ गई है।';
    el('exchange').hidden = true;
    el('record').disabled = false;
    el('record').hidden = el('record-help').hidden = !canRecord;
  } else if (state === 'disconnected') {
    status.textContent = 'कनेक्शन टूट गया है। दोबारा जुड़ने का इंतज़ार है…';
    call.disconnect = setTimeout(() => finish(call, 'दूसरे सदस्य से कनेक्शन बंद हो गया।'), 15000);
  } else if (state === 'failed') {
    finish(call, 'दोनों नेटवर्क सीधे जुड़ नहीं पाए। एक ही Wi-Fi या दूसरे नेटवर्क से नई कॉल आज़माएँ।');
  }
}

async function start(joining) {
  if (active) return;
  let offer;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices || !window.RTCPeerConnection)
      throw new Error('कॉल के लिए HTTPS और WebRTC वाला ब्राउज़र चाहिए।');
    if (joining) offer = unpack(el('invitation').value, 'offer');
  } catch (error) { status.textContent = error.message; return; }
  const call = { id: offer?.id || crypto.randomUUID(), cancel: new AbortController() };
  active = call;
  el('setup').hidden = true;
  el('end').hidden = false;
  status.textContent = 'कैमरा और माइक्रोफ़ोन चालू करने की अनुमति दें।';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (active !== call) { stopTracks(stream); return; }
    call.stream = local.srcObject = stream;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    call.pc = pc;
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    pc.onconnectionstatechange = () => stateChanged(call);
    pc.ontrack = ({ streams }) => {
      if (active !== call) return;
      remote.srcObject = streams[0];
      remote.play().catch(() => { if (active === call) el('unmute').hidden = false; });
    };
    if (joining) {
      pc.ondatachannel = event => bindChannel(call, event.channel);
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    } else {
      bindChannel(call, pc.createDataChannel('rea-call'));
    }
    status.textContent = 'कनेक्शन तैयार हो रहा है…';
    await pc.setLocalDescription(joining ? await pc.createAnswer() : await pc.createOffer());
    if (active !== call) return;
    await gather(call);
    if (active !== call) return;
    const description = pc.localDescription;
    if (!description.sdp.includes('a=candidate:')) throw new Error('नेटवर्क का पता नहीं मिला। नेटवर्क बदलकर फिर कोशिश करें।');
    const code = pack(call.id, description);
    const invitation = new URL(location.pathname, location.origin);
    invitation.hash = 'join=' + code;
    el('outgoing').value = joining ? code : invitation.href;
    el('out-label').textContent = joining ? 'यह जवाब कोड कॉल बनाने वाले को भेजें।' : 'यह निमंत्रण लिंक दूसरे सदस्य को भेजें।';
    el('reply-area').hidden = joining;
    el('share').hidden = typeof navigator.share !== 'function';
    el('exchange').hidden = false;
    status.textContent = joining ? 'कॉल बनाने वाला आपका जवाब जोड़ेगा। यह पेज खुला रखें।' : 'कॉल तैयार है। जवाब मिलने तक यह पेज खुला रखें।';
  } catch (error) {
    finish(call, 'कॉल शुरू नहीं हुई। ' + error.message);
  }
}

el('accept').onclick = async () => {
  const call = active;
  if (!call) return;
  try {
    const answer = unpack(el('reply').value, 'answer');
    if (answer.id !== call.id) throw new Error('यह जवाब दूसरी कॉल का है। इसी निमंत्रण का जवाब लें।');
    el('accept').disabled = true;
    await call.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    if (active === call && call.pc.connectionState !== 'connected') {
      el('exchange').hidden = true;
      status.textContent = 'कॉल जुड़ रही है…';
    }
  } catch (error) {
    if (active === call) { el('accept').disabled = false; status.textContent = error.message; }
  }
};

function recordingCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 360;
  const ctx = canvas.getContext('2d');
  function draw() {
    ctx.fillStyle = '#17152a';
    ctx.fillRect(0, 0, 960, 360);
    [local, remote].forEach((video, index) => {
      if (!video.videoWidth || video.readyState < 2) return;
      const scale = Math.min(480 / video.videoWidth, 360 / video.videoHeight);
      const w = scale * video.videoWidth, h = scale * video.videoHeight;
      ctx.drawImage(video, index * 480 + (480 - w) / 2, (360 - h) / 2, w, h);
    });
  }
  draw();
  const stream = canvas.captureStream(24);
  return { stream, timer: setInterval(draw, 1000 / 24) };
}

el('record').onclick = async () => {
  const call = active;
  if (!call) return;
  const button = el('record');
  button.disabled = true;
  if (call.recorder?.state === 'recording') { call.recorder.stop(); return; }
  let mix, capture;
  function release() {
    if (capture) { clearInterval(capture.timer); stopTracks(capture.stream); }
    mix?.close().catch(() => {});
  }
  try {
    mix = new AudioMixer();
    await mix.resume();
    if (active !== call) { release(); return; }
    const output = mix.createMediaStreamDestination();
    for (const stream of [call.stream, remote.srcObject]) {
      if (!stream?.getAudioTracks().length) throw new Error('दोनों सदस्यों की आवाज़ उपलब्ध होने पर रिकॉर्ड करें।');
      mix.createMediaStreamSource(stream).connect(output);
    }
    capture = recordingCanvas();
    output.stream.getAudioTracks().forEach(track => capture.stream.addTrack(track));
    const mime = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(t => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(capture.stream, mime ? { mimeType: mime } : {});
    const chunks = [];
    let bytes = 0, failed = false;
    recorder.ondataavailable = ({ data }) => {
      if (!data.size) return;
      chunks.push(data);
      bytes += data.size;
      if (bytes >= 128 * 1024 * 1024 && recorder.state === 'recording') recorder.stop();
    };
    recorder.onerror = () => { failed = true; };
    recorder.onstop = () => {
      release();
      call.recorder = null;
      if (active === call) sendControl(call, 'recording-off');
      if (chunks.length) {
        const type = recorder.mimeType || chunks[0].type;
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
        downloadUrl = URL.createObjectURL(new Blob(chunks, { type }));
        const link = el('download');
        link.href = downloadUrl;
        link.download = 'rea-call-' + Date.now() + (type.includes('mp4') ? '.mp4' : '.webm');
        link.hidden = false;
      }
      if (!active || active === call) {
        button.textContent = 'कॉल रिकॉर्ड करें';
        button.disabled = false;
        if (active === call)
          status.textContent = failed ? 'रिकॉर्डिंग बीच में रुक गई।' : chunks.length ? 'रिकॉर्डिंग डाउनलोड के लिए तैयार है।' : 'रिकॉर्डिंग सहेजी नहीं जा सकी।';
      }
    };
    recorder.start(1000);
    call.recorder = recorder;
    sendControl(call, 'recording-on');
    button.disabled = false;
    button.textContent = 'रिकॉर्डिंग रोकें';
    status.textContent = 'दोनों सदस्यों का वीडियो और आवाज़ रिकॉर्ड हो रहे हैं।';
  } catch (error) {
    release();
    button.disabled = false;
    status.textContent = 'रिकॉर्डिंग शुरू नहीं हुई। ' + error.message;
  }
};
el('create').onclick = () => start(false);
el('join').onclick = () => start(true);
el('end').onclick = () => { if (active) finish(active, 'कॉल समाप्त हो गई।'); };
el('copy').onclick = async () => {
  const field = el('outgoing');
  try {
    await navigator.clipboard.writeText(field.value);
    status.textContent = 'कॉपी हो गया। इसे दूसरे सदस्य को भेजें।';
  } catch {
    field.focus();
    field.select();
    status.textContent = 'चुना हुआ टेक्स्ट कॉपी करके दूसरे सदस्य को भेजें।';
  }
};
el('share').onclick = async () => {
  try { await navigator.share({ text: el('outgoing').value }); }
  catch (error) { if (error.name !== 'AbortError') status.textContent = 'साझा नहीं हुआ। कॉपी करके भेजें।'; }
};
el('unmute').onclick = () => remote.play().then(() => { el('unmute').hidden = true; })
  .catch(() => { status.textContent = 'आवाज़ चलाने के लिए ब्राउज़र की मीडिया अनुमति जाँचें।'; });
if (location.hash.startsWith('#join=')) {
  el('invitation').value = location.href;
  history.replaceState(null, '', location.pathname + location.search);
  el('invitation-entry').open = true;
  el('create').hidden = true;
  status.textContent = 'आपको वीडियो कॉल का निमंत्रण मिला है। जुड़ने के लिए इसे स्वीकार करें।';
}
addEventListener('pagehide', () => {
  if (active) finish(active, 'कॉल समाप्त हो गई।');
  if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; el('download').hidden = true; }
});
