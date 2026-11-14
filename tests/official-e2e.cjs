// Real phone UI -> real bridge -> real Chromium. Website pages are fixtures;
// no personal account or provider traffic is used in this test.
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const { readFile, stat } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createBridge } = require('../browser-bridge/server.cjs');
const { submitPrompt } = require('../browser-bridge/providers.cjs');

function fixture(site) {
  const editor = site === 'chatgpt' ? '<textarea id="prompt-textarea"></textarea>' : site === 'gemini'
    ? '<div role="textbox" contenteditable="true"></div>' : '<div class="ProseMirror" contenteditable="true"></div>';
  const button = site === 'gemini' ? '<button class="send-button">Send</button>' : '<button data-testid="send-button">Send</button>';
  return `<!doctype html><html><head><meta charset="utf-8"><style>textarea,[contenteditable]{display:block;width:350px;height:60px;border:1px solid black}button{margin:10px}</style></head><body>
  <h2>${site}</h2>${editor}${button}<div id="answers"></div><script>
  document.querySelector('button').onclick=()=>{
    const el=document.querySelector('textarea,[contenteditable]'); const text=el.value || el.innerText;
    let result;
    if(text.includes('ONE useful final answer')) result='एक साझा वेबसाइट जवाब';
    else if('${site}'==='chatgpt') result=text.includes('SHARED_FILE_TOKEN')?'योजना: PLAN_TOKEN':'missing attachment';
    else if('${site}'==='gemini') result=text.includes('PLAN_TOKEN')?JSON.stringify({answer:'बनाया BUILD_TOKEN',files:[{path:'index.html',content:'<h1>BRIDGE_CODE_TOKEN</h1>'}]}):'missing plan';
    else result=JSON.stringify({answer:text.includes('BRIDGE_CODE_TOKEN')?'जाँच सफल':'missing file',files:[]});
    const box=document.createElement('${site === 'gemini' ? 'model-response' : 'div'}');
    ${site === 'chatgpt' ? "box.dataset.messageAuthorRole='assistant';" : site === 'claude' ? "box.dataset.testid='assistant-message';" : ''}
    box.innerText=result; document.querySelector('#answers').append(box); el.value=''; el.innerText='';
  };</script></body></html>`;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' };
  const frontend = createServer(async (req,res) => { try {
    const n=decodeURIComponent(new URL(req.url,'http://local').pathname); const f=path.resolve(root,'.'+(n==='/'?'/index.html':n));
    if(!f.startsWith(root+'/') || !(await stat(f)).isFile()) return res.writeHead(404).end();
    res.setHeader('content-type',types[path.extname(f)]||'text/plain'); res.end(await readFile(f));
  } catch {res.writeHead(404).end();} });
  await new Promise(r=>frontend.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${frontend.address().port}`;
  const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
  const bridgeBrowser=await chromium.launch({headless:true,executablePath,args:['--no-sandbox']});
  let lastBridgePage;
  const launch=async()=>({
    newContext:async options=>{
      const context=await bridgeBrowser.newContext(options); context.on('page',p=>{lastBridgePage=p;});
      const original=context.route.bind(context);
      context.route=async (pattern,handler)=>{
        await original(pattern,handler);
        for(const [url,site] of [['https://chatgpt.com/**','chatgpt'],['https://gemini.google.com/**','gemini'],['https://claude.ai/**','claude']]) {
          await original(url,r=>r.fulfill({status:200,contentType:'text/html',body:fixture(site)}));
        }
      };
      return context;
    }, close:async()=>bridgeBrowser.close(),
  });
  const token='test-only-browser-service-key-1234567890';
  const bridge=createBridge({token,origin,launch,sendPrompt:(page,svc,prompt,opts)=>submitPrompt(page,svc,prompt,{...opts,timeoutMs:6000,settleMs:100,pollMs:25})});
  await new Promise(r=>bridge.listen(0,'127.0.0.1',r));
  const bridgeUrl=`http://127.0.0.1:${bridge.address().port}`;
  const browser=await chromium.launch({headless:true,executablePath,args:['--no-sandbox']});
  try {
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const page=await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);
    await page.locator('.welcome [data-action="new-team"]').click();
    await page.locator('#tdMode').selectOption('website');
    await page.locator('#tdTitle').fill('असली वेबसाइट टीम');
    await page.locator('#teamWebsiteHint [data-action="official-browser"]').click();
    await page.locator('#officialUrl').fill(bridgeUrl); await page.locator('#officialToken').fill(token);
    await page.locator('[data-action="official-connect"]').click();
    await page.waitForFunction(()=>!document.querySelector('#officialControls').hidden);
    for(const [id,host] of [['chatgpt','chatgpt.com'],['gemini','gemini.google.com'],['claude','claude.ai']]) {
      await page.locator(`[data-action="official-site"][data-site="${id}"]`).click();
      await page.waitForFunction(h=>document.querySelector('#officialSite').textContent.includes(h),host);
      if(id==='chatgpt') {
        await page.locator('#officialScreen').click({position:{x:50,y:80}});
        await page.locator('#officialText').fill('screen-input-test');
        await page.locator('[data-action="official-type"]').click();
        await page.waitForFunction(()=>!document.querySelector('#officialText').value);
        assert.equal(await lastBridgePage.locator('#prompt-textarea').inputValue(),'screen-input-test');
      }
      await page.locator('[data-action="official-ack"]').click();
      await page.waitForFunction(()=>document.querySelector('#officialSite').textContent.includes('पुष्टि दर्ज'));
    }
    await page.locator('#officialDialog [data-action="close-dialog"]').click();
    await page.locator('#teamForm [type="submit"]').click();
    await page.locator('#fileInput').setInputFiles({ name:'brief.txt', mimeType:'text/plain', buffer:Buffer.from('SHARED_FILE_TOKEN') });
    await page.waitForFunction(()=>!document.querySelector('.att-chip .tool-spin'));
    await page.locator('#input').fill('एक छोटा पेज बनाओ'); await page.locator('#sendBtn').click();
    await page.waitForFunction(()=>document.querySelector('.team-status')?.textContent.includes('साझा जवाब तैयार'),null,{timeout:20000});
    await page.waitForFunction(()=>document.querySelector('.msg.assistant > .content')?.textContent.includes('एक साझा वेबसाइट जवाब'),null,{timeout:10000});
    await page.waitForFunction(()=>!document.querySelector('#sendBtn').classList.contains('stop'));
    await page.locator('#projectBtn').click(); assert.equal(await page.locator('#projectPath').inputValue(),'index.html');
    assert.ok((await page.locator('#projectContent').inputValue()).includes('BRIDGE_CODE_TOKEN'));
    assert.deepEqual(errors,[]);
    console.log('PASS: phone UI -> authenticated bridge -> browser controls -> three fixture sites -> code handoff -> one result. Provider logins are not simulated as real.');
    await context.close();
  } finally {
    await browser.close(); await new Promise(r=>bridge.close(r)); await new Promise(r=>frontend.close(r));
    await bridgeBrowser.close().catch(()=>{});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
