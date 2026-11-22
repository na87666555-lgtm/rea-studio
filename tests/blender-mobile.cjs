// Requires local Blender and ffmpeg, or REA_MOVIE_LIVE=1 to exercise the published app.
const {chromium}=require('playwright');
const {createServer}=require('node:http');
const {readFile,stat}=require('node:fs/promises');
const {execFileSync}=require('node:child_process');
const path=require('node:path'), assert=require('node:assert/strict');
const {createBridge}=require('../browser-bridge/server.cjs');
const live=process.env.REA_MOVIE_LIVE==='1';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
(async()=>{
 const root=path.resolve(__dirname,'..');
 const server=createServer(async(req,res)=>{try{const uri=new URL(req.url,'http://local').pathname;const f=path.resolve(root,'.'+(uri==='/'?'/index.html':uri));if(!f.startsWith(root+'/') || !(await stat(f)).isFile())return res.writeHead(404).end();const ext=path.extname(f);
 res.setHeader('content-type',({'.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json'})[ext]||'application/octet-stream');res.end(await readFile(f));}catch{res.writeHead(404).end();}});
 await listen(server);
 const origin='http://127.0.0.1:'+server.address().port;
 const bridge=createBridge({token:'test-key-only-for-the-local-MP4-renderer',origin});await listen(bridge);
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try {
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  if(live) {
    page.on('console',m=>{if(m.type()==='error') console.log('browser:',m.text().replace(/[0-9a-f-]{36}/gi,'JOB').slice(0,450));});
    page.on('requestfailed',r=>console.log('failed:',r.method(),new URL(r.url()).pathname.replace(/[0-9a-f-]{36}/gi,'JOB'),r.failure()?.errorText));
    page.on('response',r=>{if(r.url().includes('/v1/movies')) console.log('response:',r.status(),new URL(r.url()).pathname.replace(/[0-9a-f-]{36}/gi,'JOB'));});
  }
  if(!live) await page.route('https://rea-official-browser.onrender.com/v1/movies**', async r=>{
    const u=new URL(r.request().url());const h=r.request().headers();h.origin=origin;
    const res=await r.fetch({url:'http://127.0.0.1:'+bridge.address().port+u.pathname,headers:h});await r.fulfill({response:res});
  });
  await page.goto(live?'https://na87666555-lgtm.github.io/rea-studio/':origin);
  await page.locator('#input').fill('Blender में लाल रंग का घूमता 3D घन बनाओ'); await page.locator('#sendBtn').click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('rea.v1.chats')||'[]').some(c=>c.messages.some(m=>m.movieJob||m.movieVideo)),null,{timeout:100000});
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('video.movie-player')?.readyState>=1 || document.querySelector('.msg.assistant .err-box'),null,{timeout:750000});
  assert.equal(await page.locator('.msg.assistant .err-box').count(),0,await page.locator('.msg.assistant').last().innerText());
  assert.equal(await page.locator('.movie-player').evaluate(v=>v.duration),3);
  await page.reload();
  const link=page.locator('[download="rea-blender.mp4"]');
  const dl=page.waitForEvent('download');await link.click();const file=await dl;
  const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name,width,height,nb_frames','-of','json',await file.path()]));
  assert.equal(info.streams[0].codec_name,'h264');assert.equal(info.streams[0].nb_frames,'36');
  console.log('PASS mobile chat -> Blender Python -> 36 rendered frames -> playable and downloadable H.264 MP4, survives reload; live='+live);
 }finally{await browser.close();await new Promise(r=>bridge.close(r));await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
