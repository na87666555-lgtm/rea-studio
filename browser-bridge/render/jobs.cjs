'use strict';
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');

const fail = (status, publicMessage) => Object.assign(new Error(publicMessage), {status, publicMessage});
const LIFETIME = 30 * 60 * 1000;
const deadline = 12 * 60 * 1000;

function processStep(job, bin, args, dir, onLine) {
  job.stop.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {cwd:dir, env:{PATH:process.env.PATH, HOME:dir, TMPDIR:dir, LANG:'C.UTF-8', OMP_NUM_THREADS:'1', OPENBLAS_NUM_THREADS:'1'}, stdio:['ignore','pipe','ignore']});
    const kill = () => child.kill('SIGKILL');
    job.stop.signal.addEventListener('abort', kill, {once:true});
    createInterface({input:child.stdout}).on('line', onLine);
    child.once('error', reject);
    child.once('close', code => {
      job.stop.signal.removeEventListener('abort', kill);
      if (code !== 0 || job.stop.signal.aborted || job.error) reject(new Error('render failed'));
      else resolve();
    });
  });
}

function createMovieJobs() {
  const jobs = new Map();
  let publicStarts = [];
  let busy = false;
  function clean() {
    for (const [id,j] of jobs) if (j.finished && Date.now()-j.finished > LIFETIME) jobs.delete(id);
  }
  const timer = setInterval(clean, 60000);
  timer.unref();
  function publicState(j) {
    return {id:j.id, state:j.state, frame:j.frame, total:j.total, ...(j.error ? {error:j.error} : {})};
  }
  async function render(j, source) {
    let dir;
    const timer = setTimeout(() => { j.error='रेंडर ने समय सीमा पार कर दी। छोटा दृश्य बनाएँ।'; j.stop.abort(); }, deadline);
    try {
      dir = await fs.mkdtemp(path.join(os.tmpdir(),'rea-movie-'));
      const input = path.join(dir,'input.py');
      await fs.writeFile(input, source, {mode:0o600});
      j.state='rendering';
      await processStep(j,'blender',['-b','-t','1','-noaudio','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',path.join(__dirname,'render.py'),'--',input,dir],dir,line=>{
        if (/^REA_TOTAL \d+$/.test(line)) j.total=Number(line.split(' ')[1]);
        if (/^REA_FRAME \d+$/.test(line)) j.frame=Number(line.split(' ')[1]);
        if (line.startsWith('REA_ERROR ')) j.error=line.slice(10,260);
      });
      if (!j.total || j.frame !== j.total) throw new Error('incomplete frames');
      j.state='encoding';
      const dest=path.join(dir,'video.mp4');
      await processStep(j,'ffmpeg',['-nostdin','-v','error','-framerate','12','-i',path.join(dir,'frame-%04d.png'),'-c:v','libx264','-preset','veryfast','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart',dest],dir,()=>{});
      const stat = await fs.stat(dest);
      if (stat.size < 128 || stat.size > 8*1024*1024) throw new Error('invalid media size');
      j.bytes = await fs.readFile(dest);
      j.state='done';
    } catch {
      j.state=j.stop.signal.aborted && !j.error ? 'stopped':'failed';
      if (j.state==='failed' && !j.error) j.error='Blender या MP4 एन्कोडर काम पूरा नहीं कर पाया।';
    } finally {
      clearTimeout(timer);
      if (dir) await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
      j.finished=Date.now(); busy=false;
    }
  }
  return {
    start(owner, source, publicMovie = false) {
      clean();
      if (typeof source!=='string' || !source.trim() || Buffer.byteLength(source)>8192) throw fail(400,'दृश्य की Python स्क्रिप्ट 8 KB तक रखें।');
      if (busy) throw fail(409,'सर्वर पर एक Blender रेंडर पहले से चल रहा है। उसके बाद फिर कोशिश करें।');
      if (publicMovie) {
        const now = Date.now();
        publicStarts = publicStarts.filter(t => now-t < 86400000);
        if (publicStarts.length >= 30 || publicStarts.filter(t => now-t < 3600000).length >= 6)
          throw fail(429,'सार्वजनिक रेंडर की सीमा अभी पूरी है। बाद में फिर कोशिश करें।');
        publicStarts.push(now);
      }
      while (jobs.size >= 8) jobs.delete(jobs.keys().next().value);
      const j={id:randomUUID(),owner,state:'queued',frame:0,total:0,stop:new AbortController()};
      jobs.set(j.id,j);busy=true;void render(j,source);
      return publicState(j);
    },
    get(owner,id) {
      clean();
      const j=jobs.get(id);
      if (!j || j.owner!==owner) throw fail(404,'रेंडर सर्वर पर अब उपलब्ध नहीं है। नया रेंडर शुरू कर सकते हैं।');
      return {status:()=>publicState(j), cancel:()=>{if (!j.finished) j.stop.abort();}, bytes:()=>{
        if (j.state!=='done' || !j.bytes) throw fail(409,'MP4 अभी तैयार नहीं है।');
        return j.bytes;
      }};
    },
    close() {clearInterval(timer); for (const j of jobs.values()) if (!j.finished) j.stop.abort();}
  };
}
module.exports={createMovieJobs};
