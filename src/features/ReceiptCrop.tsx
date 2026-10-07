import type { PointerEvent } from 'react';
import type { Quad } from '../domain/receiptImage';
export function ReceiptCrop({preview,quad,onChange,disabled}:{preview:string;quad:Quad;onChange:(q:Quad)=>void;disabled:boolean}) {
  function move(event:PointerEvent<SVGCircleElement>,index:number) {
    if(disabled)return;
    const svg=event.currentTarget.ownerSVGElement!;
    const bounds=svg.getBoundingClientRect();
    const p={x:Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),y:Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height))};
    const next=quad.map((old,i)=>i===index?p:old) as Quad;onChange(next);
  }
  return <div className="receipt-crop"><p className="hint">レシートの四隅を合わせてください。枠の外は読み取りません。</p>
    <div className="crop-image"><img src={preview} alt="切り抜くレシートの範囲"/><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="レシートの四隅"><polygon points={quad.map(p=>`${p.x*100},${p.y*100}`).join(' ')} fill="#285dd714" stroke="#285dd7" strokeWidth=".6"/>{quad.map((p,i)=><circle key={i} cx={p.x*100} cy={p.y*100} r="2.8" fill="#fff" stroke="#285dd7" strokeWidth=".8" style={{touchAction:'none',cursor:'grab'}} onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);move(e,i);}} onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))move(e,i);}}/>)}</svg></div>
    <details><summary>四隅を細かく調整・回転</summary>{quad.map((p,i)=><div className="corner-controls" key={i}><b>{['左上','右上','右下','左下'][i]}</b>{(['x','y'] as const).map(axis=><label key={axis}>{axis==='x'?'横':'縦'}<input aria-label={`${['左上','右上','右下','左下'][i]} ${axis==='x'?'横':'縦'}`} type="range" min="0" max="1000" disabled={disabled} value={Math.round(p[axis]*1000)} onChange={e=>{const next=quad.map((old,j)=>j===i?{...old,[axis]:Number(e.target.value)/1000}:old) as Quad;onChange(next);}}/></label>)}</div>)}</details>
  </div>;
}
