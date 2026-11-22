(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const stopTracks = stream => stream?.getTracks().forEach(track => track.stop());
  const activeUrls = new WeakMap();

  function record(stream, link, fileName, finished) {
    const formats = ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
    const mimeType = formats.find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? {mimeType} : {});
    const chunks = [];
    let size = 0;
    recorder.ondataavailable = ({data}) => {
      if (!data.size) return;
      chunks.push(data);
      size += data.size;
      if (size >= 128 * 1024 * 1024 && recorder.state === "recording") recorder.stop();
    };
    recorder.onstop = () => {
      if (chunks.length) {
        const type = recorder.mimeType || chunks[0].type;
        const url = URL.createObjectURL(new Blob(chunks, {type}));
        if (activeUrls.has(link)) URL.revokeObjectURL(activeUrls.get(link));
        activeUrls.set(link, url);
        link.href = url;
        link.download = fileName + (type.includes("mp4") ? ".mp4" : ".webm");
        link.hidden = false;
      }
      finished(chunks.length > 0);
    };
    recorder.start(1000);
    link.hidden = true;
    return recorder;
  }

  function setupAnimation() {
    const preview = byId("scene-preview");
    if (!preview) return;
    const play = byId("scene-play");
    const recordButton = byId("scene-record");
    const status = byId("scene-status");
    let renderer, object, camera, scene, recorder;
    let running = false, angle = 0, last = 0;
    function frame(time) {
      if (!running) return;
      angle += Math.min((time - last) / 1000, .1) * Number(byId("scene-speed").value);
      last = time;
      object.rotation.set(angle * .35, angle, angle * .12);
      renderer.render(scene, camera);
      requestAnimationFrame(frame);
    }
    async function initialize() {
      const THREE = await import("/static/vendor/three.module.min.js");
      const gl = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x13242b);
      camera = new THREE.PerspectiveCamera(38, 16 / 9, .1, 40);
      camera.position.z = 5.8;
      const material = new THREE.MeshStandardMaterial({
        color: byId("scene-color").value, metalness: .35, roughness: .23
      });
      function geometry() {
        switch (byId("scene-shape").value) {
          case "cube": return new THREE.BoxGeometry(1.65, 1.65, 1.65);
          case "sphere": return new THREE.SphereGeometry(1.15, 40, 32);
          case "icosahedron": return new THREE.IcosahedronGeometry(1.2, 0);
          case "torus": return new THREE.TorusGeometry(.92, .31, 32, 96);
          default: return new THREE.TorusKnotGeometry(.82, .25, 128, 24);
        }
      }
      object = new THREE.Mesh(geometry(), material);
      scene.add(object, new THREE.HemisphereLight(0xe1fffa, 0x486984, 1.55));
      const key = new THREE.DirectionalLight(0xfff3df, 3);
      key.position.set(4, 3, 4);
      scene.add(key);
      gl.setSize(960, 540, false);
      preview.replaceChildren(gl.domElement);
      renderer = gl;
      byId("scene-shape").onchange = () => {
        object.geometry.dispose();
        object.geometry = geometry();
        gl.render(scene, camera);
      };
      byId("scene-color").oninput = event => {
        material.color.set(event.target.value);
        gl.render(scene, camera);
      };
      recordButton.disabled = !gl.domElement.captureStream || !window.MediaRecorder;
      if (recordButton.disabled) status.textContent = "इस ब्राउज़र में वीडियो रिकॉर्डिंग उपलब्ध नहीं है।";
    }
    play.onclick = async () => {
      play.disabled = true;
      try {
        if (!renderer) await initialize();
        running = !running;
        play.textContent = running ? "प्रीव्यू रोकें" : "प्रीव्यू चलाएँ";
        if (running) {
          last = performance.now();
          requestAnimationFrame(frame);
        }
      } catch (error) {
        status.textContent = "3D प्रीव्यू खोलने में दिक्कत हुई। " + error.message;
      } finally {
        play.disabled = false;
      }
    };
    recordButton.onclick = async () => {
      if (recorder?.state === "recording") { recorder.stop(); return; }
      let stream;
      try {
        if (!running) await play.onclick();
        stream = renderer.domElement.captureStream(30);
        recorder = record(stream, byId("scene-download"), "rea-animation", saved => {
          stopTracks(stream);
          recordButton.textContent = "वीडियो रिकॉर्ड करें";
          play.disabled = false;
          status.textContent = saved ? "ऐनिमेशन डाउनलोड के लिए तैयार है।" : "वीडियो दर्ज नहीं हो पाया।";
        });
        play.disabled = true;
        recordButton.textContent = "रिकॉर्डिंग रोकें";
        status.textContent = "ऐनिमेशन रिकॉर्ड हो रहा है।";
      } catch (error) {
        stopTracks(stream);
        status.textContent = "रिकॉर्डिंग शुरू नहीं हुई। " + error.message;
      }
    };
  }

  function setupCall() {
    const status = byId("call-status");
    if (!status) return;
    const local = byId("call-local"), remote = byId("call-remote");
    const create = byId("call-create"), join = byId("call-join"), end = byId("call-end");
    const recordButton = byId("call-record"), unmute = byId("call-unmute");
    const input = byId("call-code");
    let call = null;
    if (document.body.hasAttribute("data-guest")) create.hidden = true;
    async function api(action, data, keepalive = false) {
      const response = await fetch("/api/rooms/" + action, {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify(data), keepalive
      });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || ("HTTP " + response.status));
      return result;
    }
    function finish(c, message) {
      if (call !== c) return;
      call = null;
      clearTimeout(c.timer);
      if (c.record?.state === "recording") c.record.stop();
      if (c.room) api("leave", c.room, true).catch(() => {});
      c.pc?.close();
      stopTracks(c.stream);
      local.srcObject = remote.srcObject = null;
      recordButton.hidden = end.hidden = unmute.hidden = true;
      byId("call-setup").hidden = false;
      join.disabled = create.disabled = false;
      status.textContent = message;
    }
    function report(c, error) {
      finish(c, "कॉल रुक गई। " + (error.message || error));
    }
    async function signal(c, type, value) {
      if (call === c) await api("send", {...c.room, signal: {type, value}});
    }
    async function poll(c) {
      try {
        const result = await api("poll", {...c.room, after: c.after});
        if (call !== c) return;
        if (result.ended) { finish(c, "कॉल समाप्त हो गई।"); return; }
        if (result.joined && !c.joinedAt) {
          c.joinedAt = Date.now();
          status.textContent = "दोनों सदस्य मौजूद हैं। मीडिया कनेक्शन बन रहा है…";
        }
        if (c.joinedAt && !c.everConnected && Date.now() - c.joinedAt > 65000) {
          throw new Error("मीडिया कनेक्शन नहीं बना। नेटवर्क और TURN सर्वर जाँचें।");
        }
        for (const event of result.events) {
          const {type, value} = event.signal;
          if (type === "candidate") {
            if (c.pc.remoteDescription) await c.pc.addIceCandidate(value);
            else c.candidates.push(value);
          } else {
            await c.pc.setRemoteDescription(value);
            for (const candidate of c.candidates.splice(0)) await c.pc.addIceCandidate(candidate);
            if (type === "offer") {
              await c.pc.setLocalDescription(await c.pc.createAnswer());
              await signal(c, "answer", c.pc.localDescription.toJSON());
            }
          }
          c.after = event.id;
        }
        if (call === c) c.timer = setTimeout(() => poll(c), c.pc.connectionState === "connected" ? 3500 : 650);
      } catch (error) { report(c, error); }
    }
    async function begin(host) {
      if (call) return;
      const code = input.value.trim().toUpperCase();
      if (!host && !code) { input.focus(); status.textContent = "कॉल का कोड दर्ज करें।"; return; }
      const c = {candidates: [], after: 0};
      call = c;
      create.disabled = join.disabled = true;
      status.textContent = "कैमरे और माइक्रोफ़ोन की अनुमति दें।";
      try {
        if (!navigator.mediaDevices || !window.RTCPeerConnection) {
          throw new Error("इस ब्राउज़र में HTTPS या localhost पर खोलें।");
        }
        c.stream = await navigator.mediaDevices.getUserMedia({audio: true, video: true});
        const config = await api("config", {});
        const room = await api(host ? "create" : "join", host ? {} : {code});
        c.room = {code: room.code || code, token: room.token};
        local.srcObject = c.stream;
        const pc = new RTCPeerConnection({iceServers: config.iceServers || []});
        c.pc = pc;
        c.stream.getTracks().forEach(track => pc.addTrack(track, c.stream));
        pc.onicecandidate = ({candidate}) => {
          if (candidate) signal(c, "candidate", candidate.toJSON()).catch(error => report(c, error));
        };
        pc.ontrack = ({streams}) => {
          remote.srcObject = streams[0];
          remote.play().catch(() => { if (call === c) unmute.hidden = false; });
        };
        pc.onconnectionstatechange = () => {
          if (call !== c) return;
          if (pc.connectionState === "connected") {
            c.everConnected = true;
            status.textContent = "कॉल जुड़ गई है।";
            recordButton.hidden = !window.MediaRecorder || !window.AudioContext || !HTMLCanvasElement.prototype.captureStream;
          } else if (pc.connectionState === "failed") {
            report(c, new Error("दोनों डिवाइस को जोड़ने के लिए TURN सर्वर की ज़रूरत हो सकती है।"));
          } else if (pc.connectionState === "disconnected") status.textContent = "दोबारा कनेक्ट होने का इंतज़ार है।";
        };
        byId("call-setup").hidden = true;
        end.hidden = false;
        if (host) {
          status.textContent = "कॉल कोड " + c.room.code + " दूसरे सदस्य को दें। उनके जुड़ने का इंतज़ार है।";
          await pc.setLocalDescription(await pc.createOffer());
          await signal(c, "offer", pc.localDescription.toJSON());
        } else status.textContent = "कॉल जुड़ रही है…";
        if (call === c) poll(c);
      } catch (error) { report(c, error); }
    }
    unmute.onclick = () => remote.play().then(() => { unmute.hidden = true; }).catch(error => {
      status.textContent = error.message;
    });
    recordButton.onclick = async () => {
      const c = call;
      if (!c) return;
      if (c.record?.state === "recording") { c.record.stop(); return; }
      recordButton.disabled = true;
      let mix, combined, timer;
      function cleanup() {
        clearInterval(timer);
        stopTracks(combined);
        mix?.close().catch(() => {});
        recordButton.disabled = false;
        recordButton.textContent = "कॉल रिकॉर्ड करें";
      }
      try {
        mix = new AudioContext();
        await mix.resume();
        if (call !== c) { cleanup(); return; }
        const destination = mix.createMediaStreamDestination();
        for (const stream of [c.stream, remote.srcObject]) {
          if (stream?.getAudioTracks().length) mix.createMediaStreamSource(stream).connect(destination);
        }
        const canvas = document.createElement("canvas");
        canvas.width = 960; canvas.height = 360;
        const ctx = canvas.getContext("2d");
        function draw() {
          ctx.fillStyle = "#13242b"; ctx.fillRect(0, 0, 960, 360);
          [local, remote].forEach((video, index) => {
            if (!video.videoWidth || video.readyState < 2) return;
            const scale = Math.min(480 / video.videoWidth, 360 / video.videoHeight);
            const w = video.videoWidth * scale, h = video.videoHeight * scale;
            ctx.drawImage(video, index * 480 + (480 - w) / 2, (360 - h) / 2, w, h);
          });
        }
        draw();
        timer = setInterval(draw, 1000 / 24);
        combined = canvas.captureStream(24);
        destination.stream.getAudioTracks().forEach(track => combined.addTrack(track));
        c.record = record(combined, byId("call-download"), "rea-call", saved => {
          cleanup();
          if (call === c || !call) status.textContent = saved ? "रिकॉर्डिंग डाउनलोड के लिए तैयार है।" : "रिकॉर्डिंग सहेजी नहीं जा सकी।";
        });
        recordButton.disabled = false;
        recordButton.textContent = "रिकॉर्डिंग रोकें";
        status.textContent = "कॉल का वीडियो और आवाज़ रिकॉर्ड हो रहे हैं।";
      } catch (error) {
        cleanup();
        status.textContent = "कॉल रिकॉर्ड नहीं हुई। " + error.message;
      }
    };
    create.onclick = () => begin(true);
    join.onclick = () => begin(false);
    end.onclick = () => { if (call) finish(call, "कॉल समाप्त हो गई।"); };
    window.addEventListener("pagehide", () => { if (call) finish(call, "कॉल समाप्त हो गई।"); });
  }
  setupAnimation();
  setupCall();
})();
