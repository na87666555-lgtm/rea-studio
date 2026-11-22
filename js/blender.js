import { getFile, putFile } from './files.js';
import { streamChat } from './providers.js';

const base = 'https://rea-official-browser.onrender.com/v1/movies';
const allowedId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const name = /blender|ब्लेंडर|ब्लेन्डर|ब्लेंडर/i;
const request = /इंस्ट[ॉा]ल|इन्स्ट[ॉा]ल|बनाओ|बना\s*(?:दो|दें|देना|दीजिए)|बनाइ|बनाएं|बनाएँ|चलाओ|चला\s*(?:दो|दें)|चलाइ|रेंडर|रेन्डर|install|render|make|create|generate|animate|execute|\brun\b/i;
const guide = 'Blender में लाल रंग का घूमता 3D घन बनाओ';
const grammar = 'Return only a Rea Blender scene script. One movie(seconds=1..6,background="#RRGGBB") and 1 to 12 shape calls. shape("cube"|"sphere"|"torus"|"cone"|"cylinder"|"crystal", at=(x,y,z), size=(x,y,z), color="#RRGGBB", spin=(x,y,z), move=(x,y,z), tilt=(x,y,z)). Spin and tilt are degrees, move is displacement. Use only literal arguments. No imports, variables, loops, comments to the user, filesystem, bpy calls or Markdown. Approximate the requested subject with these shapes and motion. If unsuitable, return only UNSUPPORTED.';
const colors = {लाल:'#ef4848',नीला:'#3885ff',नीले:'#3885ff',हरा:'#3bbf74',पीला:'#ffcb4d',बैंगनी:'#ab69ed',गुलाबी:'#ff75a5',red:'#ef4848',blue:'#3885ff',green:'#3bbf74',yellow:'#ffcb4d'};
const shapes = {घन:'cube',क्यूब:'cube',गोला:'sphere',गेंद:'sphere',छल्ला:'torus',शंकु:'cone',बेलन:'cylinder',क्रिस्टल:'crystal',cube:'cube',sphere:'sphere',ball:'sphere',ring:'torus',torus:'torus',cone:'cone',cylinder:'cylinder',crystal:'crystal'};
export function blenderRequest(text, files=[]) {
  const first = String(text).split('\n')[0].trim();
  if (!name.test(first) || !request.test(first) || /(?:कैसे|क्यों|मत |नहीं |how (?:do|can|to)|don't|do not)/i.test(first)) return null;
  if (files.length) {
    if (files.length===1 && /\.py$/i.test(files[0].name) && files[0].size<=8192) return {file:files[0].id};
    return {notice:'रेंडर के लिए एक .py दृश्य फ़ाइल (8 KB तक) भेजें।'};
  }
  if (text.includes('\n') && /\S/.test(text.slice(text.indexOf('\n')))) {
    const body=text.slice(text.indexOf('\n')).trim();
    const block=/^```(?:python|py)?\s*\n([\s\S]+?)\n```$/i.exec(body);
    if (block) return {source:block[1]};
    if (body.startsWith('movie(') || body.startsWith('shape(')) return {source:body};
    if (/```/.test(body)) return {notice:'पूरा Python दृश्य एक कोड ब्लॉक में भेजें।'};
  }
  const words=text.toLowerCase().replace(/[।,.!?]/gu,' ').split(/\s+/u);
  const shape=words.map(w=>shapes[w]).find(Boolean);
  const simple = /^(?:blender|ब्लेंडर|ब्लेन्डर|में|एक|का|की|के|रंग|घूमता|घूमती|हुआ|3d|3डी|वीडियो|mp4|बनाओ|बना|दो|दें|दीजिए|बनाएँ|बनाएं|बनाइए|सेकंड|सेकण्ड|सेकेंड|सेकंडों|seconds?|s|render|रेंडर|करो|करें|make|create|a|in|with|spinning|rotating|video|of|for|\d+)$/i;
  const normalized=words.map(w=>w.replace(/[०-९]/g,c=>String('०१२३४५६७८९'.indexOf(c))));
  if (shape && normalized.every(w=>!w || shapes[w] || colors[w] || simple.test(w))) {
    const duration=normalized.join(' ').match(/(\d+)\s*(?:सेकंड|सेकण्ड|सेकेंड|seconds?\b|s\b)/i);
    const seconds=duration?Number(duration[1]):3;
    if (seconds<1 || seconds>6) return {notice:'एक वीडियो की अवधि 1 से 6 सेकंड रखें।'};
    return {source:'movie(seconds='+seconds+')\nshape("'+shape+'", color="'+(words.map(w=>colors[w]).find(Boolean)||'#24d7b1')+'", tilt=(18, 8, 0), spin=(30, 0, 330))'};
  }
  if (/इंस्ट[ॉा]ल|install|नमूना|sample|demo/i.test(text) && !shape && !/बना|make|create|कहानी/i.test(text)) return {example:true};
  return {prompt:text};
}

function owner() {
  const key='rea.movieDevice';
  let id=localStorage.getItem(key);
  if (!/^[0-9a-f]{64}$/.test(id||'')) {
    id=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
    localStorage.setItem(key,id);
  }
  return 'Movie '+id;
}
async function api(path, signal, body, binary=false) {
  const headers={Authorization:owner()};
  if(body) headers['Content-Type']='application/json';
  const timeout=AbortSignal.timeout(90000);
  const res=await fetch(base+path,{method:body?'POST':'GET',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',cache:'no-store',headers,signal:AbortSignal.any([signal,timeout]),...(body?{body:JSON.stringify(body)}:{})});
  if (!res.ok) throw new Error((await res.json().catch(()=>({}))).error || 'वीडियो सेवा उपलब्ध नहीं है।');
  if (!binary) return res.json();
  if (!res.headers.get('Content-Type')?.startsWith('video/mp4')) throw new Error('सर्वर से MP4 नहीं मिला।');
  return res.blob();
}
function pause(signal) {
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    const cancel=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},2200);
    signal.addEventListener('abort',cancel,{once:true});
  });
}

export async function renderMovie(spec, msg, {connection, model, signal, progress, persist}) {
  msg.model='Blender · Python';
  let id=msg.movieJob;
  if (!id) {
    let source=spec.source;
    if (spec.file) source=await (await getFile(spec.file))?.text();
    if (spec.example) {
      const res=await fetch('media/blender-example.py',{signal});
      if (!res.ok) throw new Error('उदाहरण स्क्रिप्ट उपलब्ध नहीं है।');
      source=await res.text();
    }
    if (spec.prompt) {
      if (!connection || !model) throw new Error('इस वर्णन को स्क्रिप्ट में बदलने के लिए मॉडल चाहिए। बिना मॉडल के लिखें: '+guide+'। या अपनी movie()/shape() दृश्य स्क्रिप्ट भेजें।');
      progress('दृश्य की Python स्क्रिप्ट बन रही है…');
      let answer='';
      await streamChat({conn:connection,model,system:grammar,messages:[{role:'user',content:spec.prompt}],signal,onDelta:t=>{answer+=t;}});
      source=answer.trim().replace(/^```(?:python|py)?\s*\n/i,'').replace(/\n```$/,'');
      if (source==='UNSUPPORTED') throw new Error('इस दृश्य को उपलब्ध आकृतियों और गति से नहीं बनाया जा सकता।');
    }
    if (!source || new Blob([source]).size>8192) throw new Error('Python दृश्य स्क्रिप्ट खाली है या 8 KB से बड़ी है।');
    msg.movieSource=source;
    progress('Blender सर्वर पर रेंडर शुरू हो रहा है…');
    const created=await api('',signal,{source});
    if (!allowedId.test(created.id)) throw new Error('रेंडर सेवा से काम का सही नंबर नहीं मिला।');
    msg.movieJob=id=created.id; persist();
  }
  if (!allowedId.test(id)) throw new Error('रेंडर नंबर मान्य नहीं है।');
  try {
    for (;;) {
      const j=await api('/'+id,signal);
      if (j.state==='done') break;
      if (!['queued','rendering','encoding'].includes(j.state)) throw new Error(j.error || 'वीडियो रेंडर बंद हो गया।');
      progress(j.state==='encoding'?'फ़्रेम से MP4 बन रहा है…':j.total?'Blender: '+j.frame+' / '+j.total+' फ़्रेम पूरे':'Blender में Python दृश्य खुल रहा है…');
      await pause(signal);
    }
    progress('MP4 इस डिवाइस पर सहेजा जा रहा है…');
    const blob=await api('/'+id+'/video',signal,null,true);
    if (blob.size<100 || (await blob.slice(4,8).text())!=='ftyp') throw new Error('पूरा MP4 नहीं मिला।');
    await putFile(id,blob); msg.movieVideo=id;
    msg.content='Blender ने दृश्य रेंडर किया। MP4 यहीं चला सकते हैं या डाउनलोड कर सकते हैं।';
    delete msg.movieJob;
  } catch(e) {
    if (signal.aborted) { await api('/'+id+'/stop',AbortSignal.timeout(5000),{}).catch(()=>{}); delete msg.movieJob; }
    throw e;
  }
}

const urls=new Map();
export function releaseMovie(id) {const url=urls.get(id); if(url) URL.revokeObjectURL(url); urls.delete(id);}
export async function showMovies(root) {
  for (const el of root.querySelectorAll('[data-movie-id]')) {
    const id=el.dataset.movieId;
    if (!allowedId.test(id) || el.dataset.loaded) continue;
    el.dataset.loaded='true';
    try {
      let url=urls.get(id);
      if (!url) {
        const blob=await getFile(id);
        if (!el.isConnected) continue;
        if (!(blob instanceof Blob)) { el.querySelector('small').hidden=false; continue; }
        url=urls.get(id) || URL.createObjectURL(blob); urls.set(id,url);
      }
      el.querySelector('video').src=url;
      const link=el.querySelector('a');link.href=url;link.hidden=false;
    } catch { /* storage can be unavailable on a different device */ }
    if (!el.querySelector('video').getAttribute('src')) el.querySelector('small').hidden=false;
  }
}
