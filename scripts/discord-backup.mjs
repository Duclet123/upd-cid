import {createSign,createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';

export const PROJECT='cid-upd',PART_BYTES=7*1024*1024;
const MAGIC=Buffer.from('CIDBACKUP1\n');
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function validateAccount(account){if(account?.project_id!==PROJECT)throw Error('Unexpected Firebase project; expected cid-upd.');if(!account.client_email||!account.private_key)throw Error('Incomplete read-only Firebase service account.');}
export function validateWebhook(value){let url;try{url=new URL(value);}catch{throw Error('Missing or invalid DISCORD_BACKUP_WEBHOOK_URL.');}if(url.protocol!=='https:'||url.hostname!=='discord.com'||url.port||url.username||url.password||url.hash||!/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))throw Error('Use an official discord.com incoming webhook URL.');const thread=url.searchParams.get('thread_id');if(thread&&!/^\d+$/.test(thread))throw Error('Invalid Discord thread ID.');url.search='';if(thread)url.searchParams.set('thread_id',thread);url.searchParams.set('wait','true');return url;}
export function encryptionKey(value){if(typeof value!=='string'||!(/^[A-Za-z0-9+/]{43}=$/.test(value)))throw Error('BACKUP_ENCRYPTION_KEY must be a base64-encoded random 32-byte key.');const key=Buffer.from(value,'base64');if(key.length!==32)throw Error('Invalid backup encryption key.');return key;}
async function readJSON(response,label){try{return await response.json();}catch{throw Error(label+' returned an unreadable response.');}}
async function safeFetch(fetchImpl,url,options,label){try{return await fetchImpl(url,{...options,signal:AbortSignal.timeout(60000),redirect:'error'});}catch{throw Error(label+' could not connect. No secret URL or response body is logged.');}}
export async function firestoreToken(serviceAccount,{fetchImpl=fetch,now=Date.now()}={}){
 validateAccount(serviceAccount);const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url'),issued=Math.floor(now/1000);
 const jwt=encode({alg:'RS256',typ:'JWT'})+'.'+encode({iss:serviceAccount.client_email,scope:'https://www.googleapis.com/auth/datastore',aud:'https://oauth2.googleapis.com/token',iat:issued,exp:issued+3600});
 let signature;try{signature=createSign('RSA-SHA256').update(jwt).sign(serviceAccount.private_key,'base64url');}catch{throw Error('Invalid service-account signing key.');}
 const response=await safeFetch(fetchImpl,'https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:jwt+'.'+signature})},'Google authentication');
 if(!response.ok)throw Error('Google authentication failed: HTTP '+response.status);const data=await readJSON(response,'Google authentication');if(!data.access_token)throw Error('Google authentication did not return an access token.');return data.access_token;
}
export async function exportFirestore({serviceAccount,fetchImpl=fetch,wait=delay,now=Date.now(),maxDocuments=100000,maxBytes=128*1024*1024}){
 validateAccount(serviceAccount);const token=await firestoreToken(serviceAccount,{fetchImpl,now}),root=`projects/${PROJECT}/databases/(default)/documents`,api='https://firestore.googleapis.com/v1/';
 // All list operations use the same point in time, including orphaned history parents.
 const readTime=new Date(now-1000).toISOString(),documents=[],counts={},visited=new Set();let bytes=0,requests=0;
 async function request(path,options={}){for(let attempt=0;attempt<5;attempt++){
  if(Date.now()-now>45*60*1000)throw Error('Backup exceeded the snapshot time budget. No completion manifest was sent.');
  requests++;const response=await safeFetch(fetchImpl,api+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}},'Firestore');
  if([429,500,502,503,504].includes(response.status)&&attempt<4){await wait(500*2**attempt);continue;}if(!response.ok)throw Error('Firestore export failed: HTTP '+response.status);return await readJSON(response,'Firestore');
 }}
 const encodePath=path=>path.split('/').map(encodeURIComponent).join('/');
 async function collections(parent){const result=[];let pageToken='';do{const data=await request(encodePath(parent)+':listCollectionIds',{method:'POST',body:JSON.stringify({pageSize:100,readTime,...(pageToken?{pageToken}:{})})});result.push(...data.collectionIds||[]);pageToken=data.nextPageToken||'';}while(pageToken);return result;}
 async function walk(parent,depth=0){if(depth>40)throw Error('Unsupported Firestore nesting depth.');for(const collection of await collections(parent)){
  let pageToken='';do{const query=new URLSearchParams({pageSize:'100',showMissing:'true',readTime,...(pageToken?{pageToken}:{})});const data=await request(encodePath(parent+'/'+collection)+'?'+query);
   for(const document of data.documents||[]){if(typeof document.name!=='string'||!document.name.startsWith(root+'/'))throw Error('Unexpected document namespace.');if(visited.has(document.name))continue;visited.add(document.name);
    if(document.updateTime){const row={path:document.name.slice(root.length+1),fields:document.fields||{},createTime:document.createTime,updateTime:document.updateTime};bytes+=Buffer.byteLength(JSON.stringify(row));if(documents.length>=maxDocuments||bytes>maxBytes)throw Error('Backup exceeded its document or size safety limit. No completion manifest was sent.');documents.push(row);counts[collection]=(counts[collection]||0)+1;}
    await walk(document.name,depth+1);
   }pageToken=data.nextPageToken||'';
  }while(pageToken);
 }}
 await walk(root);documents.sort((a,b)=>a.path.localeCompare(b.path));return {format:'cid-firestore-backup',version:1,project:PROJECT,database:'(default)',readTime,createdAt:new Date(now).toISOString(),sourceCommit:process.env.GITHUB_SHA||null,includes:['All Firestore collections and subcollections, including orphaned history'],excludes:['Firebase Authentication accounts/passwords','External photo/video/file bytes','Browser-local recent records and notification state'],counts,requests,documents};
}
export function sealBackup(snapshot,keyValue,{partBytes=PART_BYTES}={}){
 const key=encryptionKey(keyValue);if(!Number.isInteger(partBytes)||partBytes<128||partBytes>PART_BYTES)throw Error('Invalid backup part size.');
 const compressed=gzipSync(Buffer.from(JSON.stringify(snapshot)),{level:9}),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(MAGIC);
 const ciphertext=Buffer.concat([cipher.update(compressed),cipher.final()]),header=Buffer.from(JSON.stringify({cipher:'aes-256-gcm',compression:'gzip',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64')})+'\n'),encrypted=Buffer.concat([MAGIC,header,ciphertext]);
 const backupId='cid-'+snapshot.createdAt.replace(/[^0-9TZ]/g,'')+'-'+randomBytes(4).toString('hex'),parts=[];
 for(let offset=0;offset<encrypted.length;offset+=partBytes){const data=encrypted.subarray(offset,offset+partBytes);parts.push({name:backupId+'.cidbackup.part'+String(parts.length+1).padStart(4,'0'),bytes:data.length,sha256:sha256(data),data});}
 return {parts,manifest:{format:'cid-discord-backup-manifest',version:1,backupId,project:PROJECT,readTime:snapshot.readTime,createdAt:snapshot.createdAt,sourceCommit:snapshot.sourceCommit||null,documentCount:snapshot.documents.length,counts:snapshot.counts,includes:snapshot.includes,excludes:snapshot.excludes,encryption:'AES-256-GCM; key stored separately',bytes:encrypted.length,sha256:sha256(encrypted),parts:parts.map(({data,...metadata})=>metadata)}};
}
export function openBackup(manifest,parts,keyValue){
 if(manifest?.format!=='cid-discord-backup-manifest'||manifest.version!==1||manifest.project!==PROJECT||!Array.isArray(manifest.parts)||!manifest.parts.length||manifest.parts.length>100000||!Number.isSafeInteger(manifest.bytes)||manifest.bytes<1||manifest.bytes>256*1024*1024||parts.length!==manifest.parts.length)throw Error('Invalid or incomplete backup manifest.');
 const buffers=parts.map((part,index)=>{const bytes=Buffer.from(part),expected=manifest.parts[index];if(bytes.length!==expected.bytes||sha256(bytes)!==expected.sha256)throw Error('Backup part integrity check failed.');return bytes;});
 const encrypted=Buffer.concat(buffers);if(encrypted.length!==manifest.bytes||sha256(encrypted)!==manifest.sha256||!encrypted.subarray(0,MAGIC.length).equals(MAGIC))throw Error('Backup integrity check failed.');
 const end=encrypted.indexOf(10,MAGIC.length);if(end<0||end>1024)throw Error('Invalid encrypted backup header.');let header;try{header=JSON.parse(encrypted.subarray(MAGIC.length,end).toString());}catch{throw Error('Invalid encrypted backup header.');}if(header.cipher!=='aes-256-gcm'||header.compression!=='gzip')throw Error('Unsupported backup encryption.');
 let snapshot;try{const decipher=createDecipheriv('aes-256-gcm',encryptionKey(keyValue),Buffer.from(header.iv,'base64'));decipher.setAAD(MAGIC);decipher.setAuthTag(Buffer.from(header.tag,'base64'));snapshot=JSON.parse(gunzipSync(Buffer.concat([decipher.update(encrypted.subarray(end+1)),decipher.final()]),{maxOutputLength:256*1024*1024}).toString());}catch{throw Error('Backup decryption failed. Check the encryption key and downloaded parts.');}
 if(snapshot.project!==PROJECT||snapshot.format!=='cid-firestore-backup'||snapshot.version!==1||!Array.isArray(snapshot.documents)||snapshot.documents.length!==manifest.documentCount||snapshot.readTime!==manifest.readTime||snapshot.createdAt!==manifest.createdAt||JSON.stringify(snapshot.counts)!==JSON.stringify(manifest.counts))throw Error('Invalid decrypted snapshot.');return snapshot;
}
export async function sendDiscordFile(webhookUrl,{name,data,content},{fetchImpl=fetch,wait=delay}={}){
 const url=validateWebhook(webhookUrl);for(let attempt=0;attempt<6;attempt++){
  const form=new FormData();form.set('payload_json',JSON.stringify({content,allowed_mentions:{parse:[]},attachments:[{id:0,filename:name}]}));form.set('files[0]',new Blob([data],{type:'application/octet-stream'}),name);
  const response=await safeFetch(fetchImpl,url,{method:'POST',body:form},'Discord upload');
  if(response.status===429&&attempt<5){let data;try{data=await response.json();}catch{throw Error('Discord returned an unreadable rate limit.');}const seconds=Number(data.retry_after);if(!Number.isFinite(seconds)||seconds<0||seconds>300)throw Error('Discord requested a long retry. Run the backup later.');await wait(Math.ceil(seconds*1000)+100);continue;}
  if([500,502,503,504].includes(response.status)&&attempt<5){await wait(1000*2**attempt);continue;}
  if(!response.ok)throw Error('Discord upload failed: HTTP '+response.status+(response.status===413?' (file too large).':''));const message=await readJSON(response,'Discord');if(!message.id||!message.attachments?.some(a=>a.filename===name))throw Error('Discord did not confirm the uploaded file.');return {messageId:message.id,channelId:message.channel_id};
 }throw Error('Discord retry limit reached.');
}
export async function runDiscordBackup({serviceAccount,webhookUrl,keyValue,send=false,fetchImpl=fetch,wait=delay,now=Date.now(),partBytes=PART_BYTES}){
 if(send){validateWebhook(webhookUrl);encryptionKey(keyValue);}const snapshot=await exportFirestore({serviceAccount,fetchImpl,wait,now});
 if(!send)return {mode:'preview',project:PROJECT,readTime:snapshot.readTime,documentCount:snapshot.documents.length,counts:snapshot.counts,requests:snapshot.requests,sent:false};
 const {parts,manifest}=sealBackup(snapshot,keyValue,{partBytes});for(let index=0;index<parts.length;index++){const part=parts[index],receipt=await sendDiscordFile(webhookUrl,{...part,content:`CID backup ${manifest.backupId} · encrypted part ${index+1}/${parts.length}. Complete only when the final manifest is posted.`},{fetchImpl,wait});Object.assign(manifest.parts[index],receipt);}
 // A completion manifest is sent only after every part has been acknowledged.
 await sendDiscordFile(webhookUrl,{name:manifest.backupId+'.manifest.json',data:Buffer.from(JSON.stringify(manifest,null,2)),content:`CID backup COMPLETE · ${manifest.backupId} · ${manifest.documentCount} Firestore documents · ${parts.length} encrypted parts. Keep every part, this manifest and the separate encryption key.`},{fetchImpl,wait});
 return {mode:'send',backupId:manifest.backupId,project:PROJECT,readTime:snapshot.readTime,documentCount:snapshot.documents.length,parts:parts.length,sent:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{if(!process.env.FIREBASE_BACKUP_SERVICE_ACCOUNT)throw Error('Missing FIREBASE_BACKUP_SERVICE_ACCOUNT repository secret.');let serviceAccount;try{serviceAccount=JSON.parse(process.env.FIREBASE_BACKUP_SERVICE_ACCOUNT);}catch{throw Error('Invalid FIREBASE_BACKUP_SERVICE_ACCOUNT JSON.');}console.log(JSON.stringify(await runDiscordBackup({serviceAccount,webhookUrl:process.env.DISCORD_BACKUP_WEBHOOK_URL,keyValue:process.env.BACKUP_ENCRYPTION_KEY,send:process.env.BACKUP_MODE==='send'})));}catch(error){console.error(error.message);process.exitCode=1;}
}
