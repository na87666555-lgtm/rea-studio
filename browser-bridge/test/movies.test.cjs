const test=require('node:test');
const assert=require('node:assert/strict');
const {createBridge}=require('../server.cjs');
const origin='https://studio.example', token='private-test-only-render-credential';
test('movies require the paired device, check ownership and accept no executable server code',async()=>{
  const server=createBridge({origin,token,launch:()=>{throw new Error('must not open Chromium');}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  async function req(path,auth,body){return fetch(base+path,{method:body?'POST':'GET',headers:{origin,authorization:'Bearer '+auth,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});}
  try {
    assert.equal((await req('/v1/movies','invalid',{source:'shape("cube")'})).status,401);
    const publicHeaders={origin,authorization:'Movie '+'a'.repeat(64),'content-type':'application/json'};
    for (const route of ['/v1/connect','/v1/pair-code']) {
      assert.equal((await fetch(base+route,{method:'POST',headers:publicHeaders,body:'{}'})).status,401);
    }
    const code=(await (await req('/v1/pair-code',token,{})).json()).code;
    const device=(await (await req('/v1/pair','',{code})).json()).token;
    const res=await req('/v1/movies',device,{source:'import os'});
    assert.equal(res.status,202);const {id}=await res.json();
    assert.equal((await req('/v1/movies/'+id,token)).status,404);
    assert.equal((await fetch(base+'/v1/movies/'+id,{headers:publicHeaders})).status,404);
    assert.equal((await req('/v1/movies/'+id+'/video',device)).status,409);
    assert.equal((await req('/v1/movies',device,{source:'shape("sphere")'})).status,409);
    let state;
    for(let i=0;i<100;i++){
      state=await (await req('/v1/movies/'+id,device)).json();
      if(state.state==='failed')break;
      await new Promise(r=>setTimeout(r,100));
    }
    assert.equal(state.state,'failed'); assert.ok(state.error);
  } finally {await new Promise(r=>server.close(r));}
});
