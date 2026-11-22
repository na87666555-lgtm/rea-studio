import test from 'node:test';
import assert from 'node:assert/strict';
import {blenderRequest} from '../js/blender.js';
test('install request from the screenshot routes to Blender rather than an LLM',()=>{
 assert.deepEqual(blenderRequest('अपने सिस्टम में ब्लेंडर इंस्टॉलकरो'),{example:true});
 assert.deepEqual(blenderRequest('Blender का नमूना रेंडर करो'),{example:true});
 assert.match(blenderRequest('Blender में लाल रंग का घूमता 3D घन बनाओ').source, /"cube".*#ef4848/);
 assert.match(blenderRequest('Blender में ५ सेकंड का गोला बनाओ').source,/seconds=5/);
 assert.ok(blenderRequest('Blender में अंतरिक्षयान का वीडियो बनाओ').prompt);
 assert.equal(blenderRequest('Blender कैसे इंस्टॉल करूँ?'),null);
 assert.equal(blenderRequest('Python चलाओ'),null);
});
test('explicit scene code or a Python attachment is used as submitted',()=>{
 const script='shape("cone", color="#abcdef")';
 assert.equal(blenderRequest('Blender चलाओ\n```python\n'+script+'\n```').source,script);
 assert.equal(blenderRequest('Blender चलाओ',[{id:'f',name:'scene.py',size:200}]).file,'f');
});
