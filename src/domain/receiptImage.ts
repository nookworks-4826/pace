/** Pure, bounded image operations. No network, storage, EXIF or OCR text. */
export interface Point { x: number; y: number }
export type Quad = [Point, Point, Point, Point];
export interface Raster { width: number; height: number; data: Uint8ClampedArray }
export const defaultQuad: Quad = [{x:.15,y:.05},{x:.85,y:.05},{x:.85,y:.95},{x:.15,y:.95}];
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max,n));
function gray(r: Raster, x: number, y: number) { const i=(y*r.width+x)*4; return .299*r.data[i]+.587*r.data[i+1]+.114*r.data[i+2]; }
export function validQuad(q: Quad): boolean {
  if (q.length !== 4 || q.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x<0 || p.y<0 || p.x>1 || p.y>1)) return false;
  const crosses = q.map((p,i) => {const a=q[(i+1)%4],b=q[(i+2)%4];return (a.x-p.x)*(b.y-a.y)-(a.y-p.y)*(b.x-a.x);});
  const area = Math.abs(q.reduce((s,p,i)=>s+p.x*q[(i+1)%4].y-q[(i+1)%4].x*p.y,0))/2;
  return crosses.every(n=>n>0.0001) && area > .025;
}
export function imageQuality(r: Raster): string[] {
  let sum=0, bright=0, dark=0, lap=0, count=0;
  const step=Math.max(1,Math.floor(Math.max(r.width,r.height)/320));
  for(let y=step;y<r.height-step;y+=step)for(let x=step;x<r.width-step;x+=step){
    const g=gray(r,x,y);sum+=g;bright+=g>252?1:0;dark+=g<35?1:0;
    const l=gray(r,x-step,y)+gray(r,x+step,y)+gray(r,x,y-step)+gray(r,x,y+step)-4*g;lap+=l*l;count++;
  }
  if (!count) return ['画像が小さすぎます。もう少し近づいてください'];
  const warnings=[];
  if (Math.min(r.width,r.height)<350) warnings.push('画像が小さすぎます。もう少し近づいてください');
  if(sum/count<75 || dark/count>.65)warnings.push('暗い画像です。明るい場所で撮影してください');
  // White paper is expected: flag near-uniform overexposure, not normal white receipts.
  if(bright/count>.97 && lap/count<15)warnings.push('白飛びの可能性があります。照明を調整してください');
  if(lap/count<25)warnings.push('画像がぶれている可能性があります');
  return warnings;
}
/** Find a connected light paper component on a small grid, then estimate its four corners.
 * Detection is a suggestion only; callers MUST require a person's crop confirmation. */
export function detectReceipt(r: Raster): Quad | null {
  const s=Math.min(1,240/Math.max(r.width,r.height)),w=Math.max(1,Math.round(r.width*s)),h=Math.max(1,Math.round(r.height*s));
  const light=new Uint8Array(w*h),visited=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)light[y*w+x]=gray(r,Math.min(r.width-1,Math.floor(x/s)),Math.min(r.height-1,Math.floor(y/s)))>165?1:0;
  // Close small text holes so glyphs do not split a receipt into strips.
  const mask=new Uint8Array(light.length);
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){let n=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)n+=light[(y+dy)*w+x+dx];mask[y*w+x]=n>=5?1:0;}
  let best: number[] = [],bestScore=0;
  for(let start=0;start<mask.length;start++){
    if(!mask[start]||visited[start])continue;
    const queue=[start];visited[start]=1;let center=0;
    for(let head=0;head<queue.length;head++){
      const i=queue[head],x=i%w,y=Math.floor(i/w);
      if(x>w*.25&&x<w*.75&&y>h*.2&&y<h*.8)center++;
      for(const j of [x>0?i-1:-1,x<w-1?i+1:-1,y>0?i-w:-1,y<h-1?i+w:-1])if(j>=0&&!visited[j]&&mask[j]){visited[j]=1;queue.push(j);}
    }
    const score=queue.length+center*2;
    if(score>bestScore){best=queue;bestScore=score;}
  }
  if(best.length<mask.length*.08 || best.length>mask.length*.94)return null;
  const points=best.map(i=>({x:(i%w+.5)/w,y:(Math.floor(i/w)+.5)/h}));
  const extremum=(fn:(p:Point)=>number,sign:number)=>points.reduce((a,b)=>fn(b)*sign<fn(a)*sign?b:a);
  const q:Quad=[extremum(p=>p.x+p.y,1),extremum(p=>p.x-p.y,-1),extremum(p=>p.x+p.y,-1),extremum(p=>p.x-p.y,1)];
  return validQuad(q)?q:null;
}
function solve(matrix: number[][]): number[] {
  for(let i=0;i<8;i++){
    let pivot=i;for(let j=i+1;j<8;j++)if(Math.abs(matrix[j][i])>Math.abs(matrix[pivot][i]))pivot=j;
    [matrix[i],matrix[pivot]]=[matrix[pivot],matrix[i]];
    if(Math.abs(matrix[i][i])<1e-10)throw new Error('レシートの四隅を確認してください。');
    const n=matrix[i][i];for(let k=i;k<=8;k++)matrix[i][k]/=n;
    for(let j=0;j<8;j++)if(j!==i){const v=matrix[j][i];for(let k=i;k<=8;k++)matrix[j][k]-=v*matrix[i][k];}
  }
  return matrix.map(row=>row[8]);
}
/** True projective rectification; samples exclusively inside the confirmed quadrilateral. */
export function rectifyReceipt(r: Raster, q: Quad, maxEdge=1600): Raster {
  if(!validQuad(q))throw new Error('レシートの四隅を確認してください。');
  const p=q.map(t=>({x:t.x*(r.width-1),y:t.y*(r.height-1)}));
  const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
  let w=Math.round(Math.max(distance(p[0],p[1]),distance(p[3],p[2]))),h=Math.round(Math.max(distance(p[0],p[3]),distance(p[1],p[2])));
  const scale=Math.min(1,maxEdge/Math.max(w,h));w=Math.max(2,Math.round(w*scale));h=Math.max(2,Math.round(h*scale));
  const dest=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
  const matrix:number[][]=[];
  dest.forEach((t,i)=>{const {x,y}=t,a=p[i];matrix.push([x,y,1,0,0,0,-a.x*x,-a.x*y,a.x],[0,0,0,x,y,1,-a.y*x,-a.y*y,a.y]);});
  const [a,b,c,d,e,f,g,j]=solve(matrix),data=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const u=x/(w-1),v=y/(h-1),den=g*u+j*v+1;
    const sx=clamp((a*u+b*v+c)/den,0,r.width-1),sy=clamp((d*u+e*v+f)/den,0,r.height-1);
    const x0=Math.floor(sx),y0=Math.floor(sy),x1=Math.min(r.width-1,x0+1),y1=Math.min(r.height-1,y0+1),dx=sx-x0,dy=sy-y0;
    const i=(y*w+x)*4;
    for(let k=0;k<3;k++)data[i+k]=r.data[(y0*r.width+x0)*4+k]*(1-dx)*(1-dy)+r.data[(y0*r.width+x1)*4+k]*dx*(1-dy)+r.data[(y1*r.width+x0)*4+k]*(1-dx)*dy+r.data[(y1*r.width+x1)*4+k]*dx*dy;
    data[i+3]=255;
  }
  return {width:w,height:h,data};
}
/** Contrast stretch and local-mean binarization; integral buffer bounded by 1600px crop. */
export function prepareReceipt(r: Raster, binarize=true): Raster {
  const {width:w,height:h}=r,values=new Uint8Array(w*h),hist=new Uint32Array(256);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const v=Math.round(gray(r,x,y));values[y*w+x]=v;hist[v]++;}
  const percentile=(p:number)=>{let n=0;for(let i=0;i<256;i++){n+=hist[i];if(n>=w*h*p)return i;}return 255;};
  // Sparse ink can occupy less than 2% of a photo. Never map the paper's tone to black.
  const lo=Math.min(80,percentile(.02)),hi=percentile(.98),span=Math.max(30,hi-lo);
  const integral=new Uint32Array((w+1)*(h+1));
  for(let y=0;y<h;y++){let row=0;for(let x=0;x<w;x++){const v=clamp(Math.round((values[y*w+x]-lo)*255/span),0,255);values[y*w+x]=v;row+=v;integral[(y+1)*(w+1)+x+1]=integral[y*(w+1)+x+1]+row;}}
  const data=new Uint8ClampedArray(w*h*4),radius=Math.max(8,Math.round(w/35));
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const x0=Math.max(0,x-radius),y0=Math.max(0,y-radius),x1=Math.min(w,x+radius+1),y1=Math.min(h,y+radius+1);
    const mean=(integral[y1*(w+1)+x1]-integral[y0*(w+1)+x1]-integral[y1*(w+1)+x0]+integral[y0*(w+1)+x0])/((x1-x0)*(y1-y0));
    const v=binarize?(values[y*w+x]<mean-12?0:255):values[y*w+x],i=(y*w+x)*4;
    data[i]=data[i+1]=data[i+2]=v;data[i+3]=255;
  }
  return {width:w,height:h,data};
}
export function rasterCanvas(r: Raster): HTMLCanvasElement {
  const c=document.createElement('canvas');c.width=r.width;c.height=r.height;
  const ctx=c.getContext('2d');if(!ctx)throw new Error('画像を準備できませんでした。');
  const image=ctx.createImageData(r.width,r.height);image.data.set(r.data);ctx.putImageData(image,0,0);return c;
}
export async function decodeReceipt(file: File): Promise<HTMLCanvasElement> {
  const dimensions=imageDimensions(new Uint8Array(await file.slice(0,1_048_576).arrayBuffer()));
  if(!dimensions||dimensions.width*dimensions.height>24_000_000)throw new Error('JPEG・PNG・WebPの24MP以下の写真を選んでください。');
  let source: ImageBitmap | HTMLImageElement;let url='';
  try {source=await createImageBitmap(file,{imageOrientation:'from-image'});}catch{
    url=URL.createObjectURL(file);try{source=await new Promise<HTMLImageElement>((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('image'));i.src=url;});}catch{URL.revokeObjectURL(url);throw new Error('image');}
  }
  try{
    const w=source instanceof HTMLImageElement?source.naturalWidth:source.width,h=source instanceof HTMLImageElement?source.naturalHeight:source.height;
    if(!w||!h||w*h>24_000_000)throw new Error('画像が大きすぎます。小さい写真を選んでください。');
    const scale=Math.min(1,1800/Math.max(w,h)),c=document.createElement('canvas');c.width=Math.round(w*scale);c.height=Math.round(h*scale);
    const ctx=c.getContext('2d');if(!ctx)throw new Error('image');ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(source,0,0,c.width,c.height);return c;
  }finally{if('close' in source)source.close();if(url)URL.revokeObjectURL(url);}
}
export function canvasRaster(c: HTMLCanvasElement): Raster {const ctx=c.getContext('2d');if(!ctx)throw new Error('image');return ctx.getImageData(0,0,c.width,c.height);}
/** Read dimensions before allocating a decoded image, including highly compressed PNGs. */
export function imageDimensions(bytes:Uint8Array):{width:number;height:number}|null {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const result=(width:number,height:number)=>width>0&&height>0?{width,height}:null;
  if(bytes.length>=24&&bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71&&bytes[12]===73&&bytes[13]===72&&bytes[14]===68&&bytes[15]===82)return result(view.getUint32(16),view.getUint32(20));
  const text=(start:number,end:number)=>String.fromCharCode(...bytes.slice(start,end));
  if(bytes.length>=25&&text(0,4)==='RIFF'&&text(8,12)==='WEBP'){
    const format=text(12,16);
    if(format==='VP8X'&&bytes.length>=30)return result(1+bytes[24]+bytes[25]*256+bytes[26]*65536,1+bytes[27]+bytes[28]*256+bytes[29]*65536);
    if(format==='VP8 '&&bytes.length>=30&&bytes[23]===157&&bytes[24]===1&&bytes[25]===42)return result(view.getUint16(26,true)&0x3fff,view.getUint16(28,true)&0x3fff);
    if(format==='VP8L'&&bytes[20]===47){const packed=view.getUint32(21,true);return result(1+(packed&0x3fff),1+((packed>>>14)&0x3fff));}
  }
  if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216){
    let i=2;
    while(i+4<=bytes.length){
      if(bytes[i++]!==255)return null;
      while(i<bytes.length&&bytes[i]===255)i++;
      const marker=bytes[i++];
      if(marker===217||marker===218)return null;
      if(marker===216||(marker>=208&&marker<=215))continue;
      if(i+2>bytes.length)return null;const size=view.getUint16(i);
      if(size<2||i+size>bytes.length)return null;
      if(marker>=192&&marker<=207&&![196,200,204].includes(marker))return size>=8?result(view.getUint16(i+5),view.getUint16(i+3)):null;
      i+=size;
    }
  }
  return null;
}
export function receiptFraming(quad:Quad,width:number,height:number):string[] {
  const messages:string[]=[];
  let area=0;for(let i=0;i<4;i++){const a=quad[i],b=quad[(i+1)%4];area+=a.x*b.y-b.x*a.y;}
  if(Math.abs(area)/2<.25)messages.push('もう少し近づいてください。');
  if(quad.some(p=>p.x<.015||p.y<.015||p.x>.985||p.y>.985))messages.push('レシート全体を写してください。端が切れている可能性があります。');
  if(Math.abs(Math.atan2((quad[1].y-quad[0].y)*height,(quad[1].x-quad[0].x)*width))*180/Math.PI>12)messages.push('大きく傾いています。真上からの撮影をおすすめします。');
  return messages;
}
