import assert from 'node:assert/strict';
import { readFileSync, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { discoverInteriorPanoramas, cubeSample, renderInteriorPanorama, extractLexusInterior } from '../server/lexus-interior.ts';
import { loadSharp } from '../src/lib/convertRasterImage.ts';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/lexus-interior.json', import.meta.url)));
const page = 'https://www.lexus.com/models/NX-hybrid?trim=nxh-1';
const panos = discoverInteriorPanoramas(fixture, page);
assert.equal(panos.length, 10);
assert.ok(panos.every(p=>p.urls.length === 6 && p.urls.every(u=>u.includes('/350h/interior/') && !/[{}]/.test(u))));
assert.equal(discoverInteriorPanoramas(fixture, page.replace('lexus.com','example.com')).length, 0);
assert.equal(discoverInteriorPanoramas(fixture, page.replace('nxh-1','nx-0')).length, 10);
assert.deepEqual([[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].map(v=>cubeSample(...v).face), [0,1,2,3,4,5]);
const sharp = await loadSharp();
const buffers = await Promise.all(Array.from({length:6}, async (_,face)=>{
 const pixels = Buffer.alloc(64*64*3);
 for(let y=0;y<64;y++)for(let x=0;x<64;x++){const i=(y*64+x)*3;pixels[i]=face*40;pixels[i+1]=x*4;pixels[i+2]=y*4;}
 return sharp(pixels,{raw:{width:64,height:64,channels:3}}).png().toBuffer();
}));
const outputs=[];
await renderInteriorPanorama(buffers,async(frame,jpeg)=>outputs.push(jpeg),96,42);
assert.equal(outputs.length,36);
assert.equal(new Set(outputs.map(b=>createHash('sha256').update(b).digest('hex'))).size,36);
for(const [frame,face] of [[1,4],[10,0],[19,5],[28,1]]){
 const {data,info}=await sharp(outputs[frame-1]).raw().toBuffer({resolveWithObject:true});
 assert.ok(Math.abs(data[(21*info.width+48)*3]-face*40)<6,`Frame ${frame} points at expected cube face`);
}
console.log('PASS: scoped interior trim discovery, six-face orientation, and 36 distinct rendered angles.');
if(process.env.QC_LIVE==='1'){
 const dir=process.env.QC_CACHE_DIR;
 assert.ok(dir,'QC_CACHE_DIR required');
 const result=await extractLexusInterior(page,dir,'http://localhost:3002');
 assert.equal(result.length,360);
 for(const label of new Set(result.map(i=>i.sequenceColor))){
  const frames=result.filter(i=>i.sequenceColor===label);
  const hashes=await Promise.all(frames.map(async i=>createHash('sha256').update(await fs.readFile(path.join(dir,i.cachedUrl.replace('/cached-images-original/','')))).digest('hex')));
  assert.equal(new Set(hashes).size,36,label);
 }
 console.log('PASS: all 10 live interior trims produce 36 unique JPEG angles (360 frames).');
}
