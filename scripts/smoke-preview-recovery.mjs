import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import {resolveSvgVariables,previewBackground} from '../src/lib/svgPreview.ts';
import {loadRemoteValidatedThumb} from '../src/lib/thumbnailLoader.ts';
const icons=JSON.parse(fs.readFileSync(new URL('./fixtures/pure-preview-icons.json',import.meta.url)));
for(const svg of icons){const repaired=resolveSvgVariables(svg);assert.ok(!repaired.includes('var('));const {data}=await sharp(Buffer.from(repaired)).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.ok(data.some((value,index)=>index%4===3&&value>0),'Icon contains visible painted pixels');}
const {data}=await sharp(Buffer.from(icons[7])).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.equal(previewBackground(data),'#3f3f46','White icon gets contrasting background');
const previous=globalThis.Image;
globalThis.Image=class{naturalWidth=20;naturalHeight=20;set src(value){if(value.includes('good'))queueMicrotask(()=>this.onload?.());}};
try{const jobs=Array.from({length:12},(_,i)=>loadRemoteValidatedThumb(`https://example.com/stuck-${i}.png`));jobs.push(loadRemoteValidatedThumb('https://example.com/good.png'));const results=await Promise.allSettled(jobs);assert.equal(results.filter(r=>r.status==='rejected').length,12);assert.equal(results[12].status,'fulfilled','Hung previews release all queue slots');}finally{globalThis.Image=previous;}
console.log('PASS: all 12 Pure SVGs paint, white icons contrast, stalled image queue recovers.');
if(process.env.SMOKE_BASE_URL){
 const base=process.env.SMOKE_BASE_URL;
 const items=icons.map(svg=>({url:'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64')}));
 items.push({url:'https://pureforyou.com/cdn/shop/files/QU6-1_PURE-US-SHOPIFY.png?v=1721824200'});
 const r=await fetch(base+'/api/warm-image-thumbs-batch',{method:'POST',headers:{'Content-Type':'application/json','X-VDX-Local-Request':'1'},body:JSON.stringify({items,sourcePageUrl:'https://pureforyou.com/collections/all'}),signal:AbortSignal.timeout(60000)});
 assert.ok(r.ok);const result=await r.json();
 for(const item of items){const meta=result.results[item.url];assert.ok(meta?.ok,meta?.error);const response=await fetch(base+meta.thumbUrl);assert.ok(response.ok);const bytes=Buffer.from(await response.arrayBuffer());const {data}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.ok(data.some((value,index)=>index%4===3&&value>0),'API preview paints');}
 console.log('PASS: API generates and serves visible previews for 12 Pure SVGs and reported product PNG.');
}
