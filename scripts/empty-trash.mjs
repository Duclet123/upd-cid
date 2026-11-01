import {createSign} from 'node:crypto';
import {pathToFileURL} from 'node:url';

// Destructive mode is opt-in. Credentials are provided only through Actions secrets.
export async function emptyTrash({serviceAccount, dryRun=true, fetchImpl=fetch, now=Date.now()}) {
  if(serviceAccount.project_id !== 'cid-upd') throw Error('Unexpected Firebase project; expected cid-upd.');
  if(!serviceAccount.client_email || !serviceAccount.private_key) throw Error('Incomplete service account.');
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const issued = Math.floor(now/1000);
  const body = encode({alg:'RS256',typ:'JWT'})+'.'+encode({iss:serviceAccount.client_email,scope:'https://www.googleapis.com/auth/datastore',aud:'https://oauth2.googleapis.com/token',iat:issued,exp:issued+3600});
  const assertion = body+'.'+createSign('RSA-SHA256').update(body).sign(serviceAccount.private_key,'base64url');
  const tokenResponse = await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}),signal:AbortSignal.timeout(30000)});
  if(!tokenResponse.ok) throw Error('Service-account authentication failed: HTTP '+tokenResponse.status);
  const token = (await tokenResponse.json()).access_token;
  if(!token) throw Error('Authentication did not return an access token.');
  const root=`https://firestore.googleapis.com/v1/projects/${serviceAccount.project_id}/databases/(default)/documents`;
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  async function request(url,options={}) {
    for(let attempt=0;attempt<4;attempt++){
      const response=await fetchImpl(url,{...options,headers,signal:AbortSignal.timeout(30000)});
      if([429,500,502,503,504].includes(response.status)&&attempt<3){await new Promise(r=>setTimeout(r,250*2**attempt));continue;}
      return response;
    }
  }
  async function list(path){const docs=[];let page='';do{const response=await request(root+'/'+path+'?pageSize=100'+(page?'&pageToken='+encodeURIComponent(page):''));if(!response.ok)throw Error('Firestore listing failed: HTTP '+response.status);const data=await response.json();docs.push(...(data.documents||[]));page=data.nextPageToken||'';}while(page);return docs;}
  const candidates=await list('trash');let purged=0,skipped=0,eligible=0;
  for(const doc of candidates){
    const timestamp=doc.fields?.deletedAt?.timestampValue;
    if(!timestamp||Date.parse(timestamp)>now){skipped++;continue;}
    eligible++;if(dryRun)continue;
    const id=doc.name.split('/').at(-1),url='https://firestore.googleapis.com/v1/'+doc.name;
    // Lock with compare-and-swap. Restores are rejected once purging starts.
    const lock=await request(url+'?updateMask.fieldPaths=purging&currentDocument.updateTime='+encodeURIComponent(doc.updateTime),{method:'PATCH',body:JSON.stringify({fields:{purging:{booleanValue:true}}})});
    if([404,409,412].includes(lock.status)){skipped++;continue;}
    if(!lock.ok)throw Error('Unable to lock trash item: HTTP '+lock.status);
    const locked=await lock.json();
    // Firestore does not automatically delete a document's history subcollection.
    for(const entry of await list('records/'+encodeURIComponent(id)+'/history')){
      const response=await request('https://firestore.googleapis.com/v1/'+entry.name,{method:'DELETE'});
      if(!response.ok&&response.status!==404)throw Error('History cleanup failed: HTTP '+response.status);
    }
    const removed=await request(url+'?currentDocument.updateTime='+encodeURIComponent(locked.updateTime),{method:'DELETE'});
    if(!removed.ok&&removed.status!==404)throw Error('Trash cleanup failed: HTTP '+removed.status);
    purged++;
  }
  return {dryRun,eligible,purged,skipped};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    if(!process.env.FIREBASE_SERVICE_ACCOUNT)throw Error('Missing FIREBASE_SERVICE_ACCOUNT repository secret. Automatic cleanup is not configured.');
    const result=await emptyTrash({serviceAccount:JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT),dryRun:process.env.DRY_RUN!=='false'});
    console.log(JSON.stringify(result));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
