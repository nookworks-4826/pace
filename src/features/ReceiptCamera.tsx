import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
export function ReceiptCamera({onPhoto,onClose,onFallback}:{onPhoto:(f:File)=>void;onClose:()=>void;onFallback:()=>void}) {
  const video=useRef<HTMLVideoElement>(null),stream=useRef<MediaStream|null>(null),[ready,setReady]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    let cancelled=false;
    const stop=()=>{stream.current?.getTracks().forEach(t=>t.stop());stream.current=null;};
    void navigator.mediaDevices?.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:1920}},audio:false}).then(s=>{
      if(cancelled){s.getTracks().forEach(t=>t.stop());return;}stream.current=s;if(video.current){video.current.srcObject=s;void video.current.play().catch(()=>setError('カメラを開始できません。端末のカメラを利用できます。'));}
    }).catch(()=>{if(!cancelled)setError('カメラを開始できません。端末のカメラを利用できます。');});
    const hidden=()=>{if(document.hidden){stop();setReady(false);setError('カメラを停止しました。撮影を開き直してください。');}};
    document.addEventListener('visibilitychange',hidden);
    return()=>{cancelled=true;stop();document.removeEventListener('visibilitychange',hidden);};
  },[]);
  async function shoot(){
    const v=video.current;if(!v||!ready)return;const c=document.createElement('canvas'),scale=Math.min(1,1800/Math.max(v.videoWidth,v.videoHeight));c.width=Math.round(v.videoWidth*scale);c.height=Math.round(v.videoHeight*scale);
    c.getContext('2d')?.drawImage(v,0,0,c.width,c.height);
    try{const blob=await new Promise<Blob|null>(resolve=>c.toBlob(resolve,'image/jpeg',.9));if(blob){stream.current?.getTracks().forEach(t=>t.stop());onPhoto(new File([blob],'receipt.jpg',{type:'image/jpeg'}));}}finally{c.width=0;c.height=0;}
  }
  return <div className="receipt-camera"><div className="camera-stage"><video ref={video} playsInline muted autoPlay onLoadedMetadata={()=>setReady(true)}/><div className="camera-guide"/><span>レシート全体を枠内に入れてください</span></div>{error&&<p role="alert" className="form-error">{error}</p>}<p className="hint">明るい場所で、真上から撮影してください。</p><div className="button-row"><button type="button" className="button button-primary" disabled={!ready} onClick={()=>void shoot()}><Camera size={18}/>撮影する</button><button type="button" className="chip" onClick={onClose}><X size={16}/>閉じる</button><button type="button" className="text-button" onClick={onFallback}>端末のカメラ</button></div></div>;
}
