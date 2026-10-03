import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { LockKeyhole, ShieldCheck } from 'lucide-react';
import { AsyncForm, Field } from '../components/UI';
import { getVaultStatus, initializeVault, unlockVault } from '../domain/vault';
import { APP_NAME } from '../types';
import { getLockConfig } from '../domain/security';
import { LockScreen } from './Security';

export function VaultGate({children}: {children: ReactNode}) {
  const [status,setStatus]=useState<{enabled:boolean;unlocked:boolean}|null>(null);
  const [failed,setFailed]=useState(false);
  const [phrase,setPhrase]=useState('');
  const [legacyVerified,setLegacyVerified]=useState(false);
  useEffect(()=>{
    const refresh=()=>void getVaultStatus().then(setStatus).catch(()=>setFailed(true));
    refresh();window.addEventListener('pace:vault-status',refresh);
    return()=>window.removeEventListener('pace:vault-status',refresh);
  },[]);
  if(failed)return <main className="vault-screen"><h1>保存領域を開けませんでした</h1><p>データは削除していません。通常のブラウザで開き直してください。</p><button className="button button-primary" onClick={()=>location.reload()}>開き直す</button></main>;
  if(!status)return <main className="vault-screen" role="status"><ShieldCheck size={32}/><p>保管庫を準備しています</p></main>;
  if(status.enabled&&status.unlocked)return children;
  if(!status.enabled&&!legacyVerified&&getLockConfig().kind!=='none')return <LockScreen onUnlocked={()=>setLegacyVerified(true)}/>;
  return <main className="vault-screen">
    <img src={`${import.meta.env.BASE_URL}icon-sunny-192.png`} width="68" height="68" alt=""/>
    <h1>{APP_NAME}</h1><section className="surface vault-panel">
      <LockKeyhole size={28}/><h2>{status.enabled?'保管庫を開く':'端末内のデータを暗号化'}</h2>
      <AsyncForm label={status.enabled?'開く':'暗号化して始める'} onSubmit={async f=>{
        if(!status.enabled&&phrase!==f.get('confirmation'))throw new Error('2つの入力が一致していません。');
        if(status.enabled)await unlockVault(phrase);else await initializeVault(phrase);
        setPhrase('');setStatus(await getVaultStatus());
      }}>
        <Field label="パスフレーズ（12文字以上）"><input name="passphrase" required minLength={12} type="password" autoComplete={status.enabled?'current-password':'new-password'} value={phrase} onChange={e=>setPhrase(e.target.value)} data-autofocus/></Field>
        {!status.enabled&&<><Field label="もう一度入力"><input name="confirmation" required minLength={12} type="password" autoComplete="new-password"/></Field><p className="hint">忘れるとデータを開けません。パスワード管理アプリなどに保管してください。すでにある記録も引き継ぎます。</p></>}
        <p className="hint">パスフレーズは送信しません。指紋・Face IDの画面ロックとは別に、アプリ起動時に必要です。</p>
      </AsyncForm>
    </section>
  </main>;
}
