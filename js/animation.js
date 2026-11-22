const shapeNames = new Map(Object.entries({
  cube: 'cube', घन: 'cube', क्यूब: 'cube', sphere: 'sphere', ball: 'sphere', गोला: 'sphere', गोल: 'sphere', गेंद: 'sphere',
  ring: 'torus', torus: 'torus', छल्ला: 'torus', रिंग: 'torus', knot: 'knot', गाँठ: 'knot', गांठ: 'knot',
  crystal: 'icosahedron', क्रिस्टल: 'icosahedron'
}));
const colorNames = new Map(Object.entries({
  red: '#f04b52', लाल: '#f04b52', blue: '#4984ff', नीला: '#4984ff', नीले: '#4984ff', नीली: '#4984ff',
  green: '#45c181', हरा: '#45c181', हरी: '#45c181', हरे: '#45c181', purple: '#9866ec', बैंगनी: '#9866ec',
  yellow: '#f5ca42', पीला: '#f5ca42', pink: '#ef80ba', गुलाबी: '#ef80ba', orange: '#f59a48', नारंगी: '#f59a48',
  white: '#ffffff', सफेद: '#ffffff', सफ़ेद: '#ffffff', black: '#222233', काला: '#222233'
}));
const action = /^(make|show|animate|render|open|create|run|play|generate|बनाओ|बना|बनाएं|बनाएँ|बनाइए|बनाइये|बनाना|बनाकर|करो|करें|चलाओ|चलाएँ|चलाएं|चलाइए|खोलो|खोलें|दिखाओ|दिखाएँ|दिखाएं|दिखाइए)$/u;
const description = new Set((
  'please a an the of with my me for new in on and set to give ' +
  '3d three.js threejs scene animation preview spinning rotating shape slowly fast faster slow speed color colour ' +
  '3डी थ्रीडी थ्री जेएस जेएस. ऐनिमेशन एनिमेशन एनीमेशन प्रीव्यू रंग गति स्पीड तेज तेज़ धीमा धीमी ' +
  'कृपया एक नया नई में का की के से को इस इसे मेरे लिए और घूमता घूमती घूमते घूमने घुमता घुमती ' +
  'घूमता हुआ हुई हुए वाला वाली है दो दें दे दीजिए कर करके मुझे वीडियो'
).split(' '));
const sceneWord = /^(3d|3डी|थ्रीडी|three\.js|threejs|animation|preview|ऐनिमेशन|एनिमेशन|एनीमेशन|प्रीव्यू|spinning|rotating|घूमता|घूमती|घूमते|घुमता|घुमती|घूमने|animate)$/u;

export function parseAnimationCommand(text) {
  if (typeof text !== 'string' || text.length > 180 || /[?？\n]/u.test(text)) return null;
  const words = text.normalize('NFC').toLowerCase().replace(/[०-९]/gu, digit => String('०१२३४५६७८९'.indexOf(digit)))
    .trim().replace(/[.,।!]+$/u, '').split(/\s+/u);
  if (!words.some(word => action.test(word)) || !words.some(word => sceneWord.test(word))) return null;
  const color = words.find(word => colorNames.has(word) || /^#[a-f0-9]{6}$/u.test(word));
  const shape = words.find(word => shapeNames.has(word));
  const speed = words.find(word => /^(slow|slowly|fast|faster|धीमा|धीमी|तेज|तेज़)$/u.test(word));
  if (!words.every(word => action.test(word) || description.has(word) || colorNames.has(word) ||
        shapeNames.has(word) || word === color)) return null;
  return {
    shape: shapeNames.get(shape),
    color: colorNames.get(color) || color,
    speed: speed ? (/^(slow|slowly|धीमा|धीमी)$/u.test(speed) ? .5 : 2) : undefined
  };
}

const element = name => document.getElementById('animation' + name);
let scenePromise;
let active = false;
let lastFrame = 0;
let rotation = 0;
let frameId = 0;
let recorder;
let previousDownload;

async function setupScene() {
  const THREE = await import('./vendor/three.module.min.js');
  const gl = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x13242b);
  const camera = new THREE.PerspectiveCamera(38, 16 / 9, .1, 40);
  camera.position.z = 5.8;
  const material = new THREE.MeshStandardMaterial({color: element('Color').value, metalness: .35, roughness: .23});
  function geometry() {
    switch (element('Shape').value) {
      case 'cube': return new THREE.BoxGeometry(1.65, 1.65, 1.65);
      case 'sphere': return new THREE.SphereGeometry(1.15, 40, 32);
      case 'icosahedron': return new THREE.IcosahedronGeometry(1.2, 0);
      case 'torus': return new THREE.TorusGeometry(.92, .31, 32, 96);
      default: return new THREE.TorusKnotGeometry(.82, .25, 128, 24);
    }
  }
  const mesh = new THREE.Mesh(geometry(), material);
  scene.add(mesh, new THREE.HemisphereLight(0xe1fffa, 0x486984, 1.55));
  const key = new THREE.DirectionalLight(0xfff3df, 3);
  key.position.set(4, 3, 4);
  scene.add(key);
  gl.setSize(960, 540, false);
  element('Preview').replaceChildren(gl.domElement);
  function render() { gl.render(scene, camera); }
  element('Shape').onchange = () => { mesh.geometry.dispose(); mesh.geometry = geometry(); render(); };
  element('Color').oninput = () => { material.color.set(element('Color').value); render(); };
  const canRecord = !!(gl.domElement.captureStream && window.MediaRecorder);
  function frame(time) {
    if (!active) return;
    rotation += Math.min((time - lastFrame) / 1000, .1) * Number(element('Speed').value);
    lastFrame = time;
    mesh.rotation.set(rotation * .35, rotation, rotation * .12);
    render();
    frameId = requestAnimationFrame(frame);
  }
  function togglePlay(play) {
    cancelAnimationFrame(frameId);
    active = play;
    element('Play').textContent = play ? 'रोकें' : 'चलाएँ';
    element('Play').setAttribute('aria-pressed', String(play));
    if (active) { lastFrame = performance.now(); frameId = requestAnimationFrame(frame); }
  }
  element('Play').disabled = false;
  element('Play').onclick = () => togglePlay(!active);
  element('Record').disabled = !canRecord;
  element('Record').onclick = () => {
    if (recorder) { if (recorder.state === 'recording') recorder.stop(); return; }
    togglePlay(true);
    let stream;
    try {
      stream = gl.domElement.captureStream(30);
      const type = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(t => MediaRecorder.isTypeSupported(t));
      recorder = new MediaRecorder(stream, type ? {mimeType: type} : {});
      let size = 0;
      const chunks = [];
      recorder.ondataavailable = ({data}) => {
        if (!data.size) return;
        chunks.push(data);
        size += data.size;
        if (size >= 128 * 1024 * 1024 && recorder.state === 'recording') recorder.stop();
      };
      recorder.onstop = () => {
        const mime = recorder.mimeType || chunks[0]?.type;
        stream.getTracks().forEach(track => track.stop());
        recorder = null;
        element('Play').disabled = false;
        element('Record').textContent = 'वीडियो रिकॉर्ड करें';
        if (!chunks.length) { element('Status').textContent = 'वीडियो रिकॉर्ड नहीं हो पाया।'; return; }
        if (previousDownload) URL.revokeObjectURL(previousDownload);
        previousDownload = URL.createObjectURL(new Blob(chunks, {type: mime}));
        const link = element('Download');
        link.href = previousDownload;
        link.download = 'rea-animation.' + (mime.includes('mp4') ? 'mp4' : 'webm');
        link.hidden = false;
        element('Status').textContent = 'ऐनिमेशन डाउनलोड के लिए तैयार है।';
      };
      recorder.start(1000);
      element('Play').disabled = true;
      element('Record').textContent = 'रिकॉर्डिंग रोकें';
      element('Status').textContent = 'वीडियो रिकॉर्ड हो रहा है।';
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      recorder = null;
      element('Status').textContent = 'रिकॉर्डिंग शुरू नहीं हुई। ' + error.message;
    }
  };
  render();
  return {togglePlay, canRecord};
}

export async function openAnimationStudio(options = {}) {
  const dialog = element('Dialog');
  if (!dialog.open) dialog.showModal();
  for (const [key, id, event] of [['shape', 'Shape', 'change'], ['color', 'Color', 'input'], ['speed', 'Speed', 'input']]) {
    if (options[key] == null) continue;
    element(id).value = options[key];
    element(id).dispatchEvent(new Event(event));
  }
  try {
    if (!scenePromise) scenePromise = setupScene();
    const ready = await scenePromise;
    if (dialog.open) {
      ready.togglePlay(true);
      if (!recorder) element('Status').textContent = ready.canRecord ? '' : 'इस ब्राउज़र में रिकॉर्डिंग उपलब्ध नहीं है।';
    }
  } catch (error) {
    scenePromise = undefined;
    element('Status').textContent = '3D प्रीव्यू शुरू नहीं हुआ। ब्राउज़र में WebGL उपलब्ध होना चाहिए।';
    throw error;
  }
}

if (typeof document !== 'undefined') {
  const openButton = document.getElementById('openAnimation');
  openButton?.addEventListener('click', () => openAnimationStudio().catch(() => {}));
  element('Close')?.addEventListener('click', () => element('Dialog').close());
  element('Dialog')?.addEventListener('close', () => {
    if (recorder?.state === 'recording') recorder.stop();
    active = false;
    cancelAnimationFrame(frameId);
  });
}
