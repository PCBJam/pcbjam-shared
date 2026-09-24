export interface PlatformConfiguration { apiBase: string; runtimeVersion: string }
let configuration: Readonly<PlatformConfiguration> | undefined;
/** Called by the trusted editor before using the host. Never exposed to guests. */
export function configurePlatform(value: PlatformConfiguration) {
  const url=new URL(value.apiBase);
  if(url.origin!==value.apiBase || !/^[a-f0-9]{64}$/.test(value.runtimeVersion)
    || !(url.protocol==='https:' || url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))) throw new Error('Invalid plugin platform configuration');
  if(configuration && JSON.stringify(configuration)!==JSON.stringify(value))throw new Error('Reload PCBJam to change plugin services');
  configuration=Object.freeze({...value});
}
export const platformConfiguration = () => configuration;
export async function boundedResponse(response:Response, maxBytes:number) {
  const reader=response.body?.getReader();
  if(!reader)throw new Error('Missing plugin response');
  const chunks:Uint8Array[]=[];let size=0;
  try {
    for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
      if(size>maxBytes)throw new Error('Plugin response exceeds its limit');chunks.push(value);}
    const result=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result;
  }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
export async function platformRequest(path:string, method='GET', data?:unknown, signal?:AbortSignal, timeoutMs=10000) {
  if(!configuration)throw new Error('Plugin platform is not configured');
  const deadline=AbortSignal.timeout(timeoutMs);
  const response=await fetch(configuration.apiBase+'/api/plugin-platform/v1/'+path,{
    method,credentials:'include',redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,deadline]):deadline,
    headers:{'Content-Type':'application/json','X-PCBJam-Plugin-Platform':'1'},
    ...(data===undefined?{}:{body:JSON.stringify(data)}),
  });
  const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedResponse(response,8*1024*1024)));
  if(!response.ok)throw Object.assign(new Error(result.error??'Plugin operation failed'), typeof result.code==='string'&&/^[A-Z_]{1,40}$/.test(result.code)?{code:result.code}:{});
  return result;
}
/** Binary GET from the platform (bundles). Errors still arrive as JSON. */
export async function platformBytes(path:string, maxBytes:number, signal?:AbortSignal, timeoutMs=60000) {
  if(!configuration)throw new Error('Plugin platform is not configured');
  const deadline=AbortSignal.timeout(timeoutMs);
  const response=await fetch(configuration.apiBase+'/api/plugin-platform/v1/'+path,{
    method:'GET',credentials:'include',redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,deadline]):deadline,
    headers:{'X-PCBJam-Plugin-Platform':'1'},
  });
  const bytes=await boundedResponse(response,maxBytes);
  if(!response.ok){let error='Plugin operation failed';try{error=JSON.parse(new TextDecoder().decode(bytes)).error??error;}catch{/* non-JSON error body */}throw new Error(error);}
  return bytes;
}
export async function sha256(bytes:Uint8Array) {
  const digest=await crypto.subtle.digest('SHA-256',new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function verifyText(text:string, expected?:{sha256:string;bytes:number}) {
  const bytes=new TextEncoder().encode(text);
  if(!expected||bytes.length!==expected.bytes||await sha256(bytes)!==expected.sha256)throw new Error('Plugin artifact integrity check failed');
}
/** Version is the hash of the exact manifest; artifacts cannot be mixed. */
export async function runtimeAssets(base:string, signal:AbortSignal) {
  if(!configuration)return null; // Explicit legacy POC adapter only.
  signal=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
  if(new URL(base).pathname!==`/plugin-runtime/${configuration.runtimeVersion}/`)throw new Error('Incompatible plugin runtime');
  const response=await fetch(new URL('manifest.json',base),{signal,redirect:'error',credentials:'omit'});
  if(!response.ok)throw new Error('Plugin runtime unavailable');
  const text=new TextDecoder().decode(await boundedResponse(response,16384)).trim();
  if(await sha256(new TextEncoder().encode(text))!==configuration.runtimeVersion)throw new Error('Runtime manifest integrity check failed');
  const manifest=JSON.parse(text);
  if(manifest.apiVersion!==1||manifest.protocolVersion!==1)throw new Error('Unsupported plugin runtime');
  const load=async(name:string)=>{
    const meta=manifest.files[name];
    if(!meta||!Number.isSafeInteger(meta.bytes)||meta.bytes<=0||meta.bytes>4*1024*1024)throw new Error('Invalid runtime artifact');
    const response=await fetch(new URL(name,base),{signal,redirect:'error',credentials:'omit'});
    if(!response.ok)throw new Error('Missing runtime artifact');
    const bytes=await boundedResponse(response,meta.bytes);
    if(bytes.length!==meta.bytes||await sha256(bytes)!==meta.sha256)throw new Error('Runtime artifact integrity check failed');
    return bytes;
  };
  return {load};
}
