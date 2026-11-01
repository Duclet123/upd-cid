import urllib.request,urllib.error,json,base64,time
BASE='http://127.0.0.1:8877/v1/projects/demo-cid/databases/(default)/documents'
ROOT='projects/demo-cid/databases/(default)/documents/'
def tok(uid):
 enc=lambda x:base64.urlsafe_b64encode(json.dumps(x).encode()).decode().rstrip('=')
 now=int(time.time())
 return enc({'alg':'none','typ':'JWT'})+'.'+enc({'iss':'https://securetoken.google.com/demo-cid','aud':'demo-cid','sub':uid,'user_id':uid,'iat':now,'exp':now+3600,'auth_time':now,'firebase':{'identities':{},'sign_in_provider':'custom'}})+'.'
def val(x):
 if isinstance(x,bool):return {'booleanValue':x}
 if isinstance(x,int):return {'integerValue':str(x)}
 if isinstance(x,str):return {'stringValue':x}
 if isinstance(x,list):return {'arrayValue':{'values':[val(v) for v in x]}}
 if x is None:return {'nullValue':None}
 return {'mapValue':{'fields':{k:val(v) for k,v in x.items()}}}
def fields(x):return {k:val(v) for k,v in x.items()}
def call(method,path,data=None,auth='owner'):
 req=urllib.request.Request(BASE+path,data=json.dumps(data).encode() if data is not None else None,method=method,headers={**({'Authorization':'Bearer '+auth} if auth else {}),'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=20) as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:return e.code,json.load(e)
def expect(status,result,expected,label):
 assert status==expected,(label,status,result)
 print('PASS',label)
def write(path,data,transform=False):
 result={'update':{'name':ROOT+path,'fields':fields(data)}}
 if transform:result['updateTransforms']=[{'fieldPath':'at','setToServerValue':'REQUEST_TIME'}]
 return result
for uid,rank in [('admin','Director'),('agent','Detective I')]:
 st,res=call('PATCH','/users/'+uid,{'fields':fields({'rank':rank,'name':uid})});expect(st,res,200,'seed '+uid)
admin=tok('admin');agent=tok('agent')
st,res=call('GET','/records/new-warrant',auth=admin);expect(st,res,404,'authenticated read of not-yet-existing record')
def save(data,version,auth=admin,actor='admin'):
 data={**data,'version':version,'auditId':'event'+str(version)}
 log={'actorUid':actor,'actorName':actor,'version':version,'action':'created' if version==1 else 'updated','changes':{'test':{'before':'x','after':'y'}}}
 return call('POST',':commit',{'writes':[write('records/new-warrant',data),write('records/new-warrant/history/event'+str(version),log,True)]},auth),data
record={'id':'new-warrant','col':'warrants','targets':['citizen-a','citizen-b'],'reason':'Test','workflow':{'status':'Draft'}}
(st,res),record=save(record,1);expect(st,res,200,'create multi-citizen draft + audit atomically')
(st,res),_=save({**record,'workflow':{'status':'Submitted'}},2);expect(st,res,403,'cannot submit a warrant for approval')
(st,res),submitted=save({**record,'reason':'Editable draft'},2,agent,'agent');expect(st,res,200,'ordinary detective edits a draft')
(st,res),_=save({**submitted,'workflow':{'status':'Approved'}},3);expect(st,res,403,'director cannot approve a warrant either')
(st,res),approved=save({**submitted,'reason':'Still a draft request'},3);expect(st,res,200,'draft remains editable')
st,res=call('GET','/records/new-warrant/history/event1',auth='');expect(st,res,403,'history is private')
# Trash atomically preserves the exact active record and private audit trail.
trash={'col':'warrants','record':approved,'deletedBy':'admin','deletedUid':'admin','auditId':'trashevent'}
trashWrite=write('trash/new-warrant',trash);trashWrite['updateTransforms']=[{'fieldPath':'deletedAt','setToServerValue':'REQUEST_TIME'}]
log={'actorUid':'admin','actorName':'admin','version':3,'action':'trashed','changes':{'lifecycle':{'before':'Active','after':'Trash'}}}
st,res=call('POST',':commit',{'writes':[trashWrite,write('records/new-warrant/history/trashevent',log,True),{'delete':ROOT+'records/new-warrant'}]},admin);expect(st,res,200,'move draft warrant to trash')
restored={**approved,'version':4,'auditId':'restoreevent','updatedAt':100}
log.update(version=4,action='restored')
st,res=call('POST',':commit',{'writes':[write('records/new-warrant',restored),{'delete':ROOT+'trash/new-warrant'},write('records/new-warrant/history/restoreevent',log,True)]},admin);expect(st,res,200,'restore draft warrant with complete history')
st,res=call('DELETE','/records/new-warrant/history/event1',auth=admin);expect(st,res,403,'cannot delete history from an active record')
trash={'col':'warrants','record':restored,'deletedBy':'admin','deletedUid':'admin','auditId':'trash-for-permanent'}
trashWrite=write('trash/new-warrant',trash);trashWrite['updateTransforms']=[{'fieldPath':'deletedAt','setToServerValue':'REQUEST_TIME'}]
log.update(version=4,action='trashed')
st,res=call('POST',':commit',{'writes':[trashWrite,write('records/new-warrant/history/trash-for-permanent',log,True),{'delete':ROOT+'records/new-warrant'}]},admin);expect(st,res,200,'prepare trash item for permanent deletion')
st,res=call('DELETE','/trash/new-warrant',auth=agent);expect(st,res,403,'ordinary detective cannot permanently delete trash')
st,res=call('DELETE','/trash/new-warrant',auth=admin);expect(st,res,403,'permanent deletion requires a lock')
st,tr=call('GET','/trash/new-warrant',auth=admin)
def lock(actor,auth):
 fields_={**tr['fields'],'purging':val(True),'purgeUid':val(actor)}
 return call('POST',':commit',{'writes':[{'update':{'name':ROOT+'trash/new-warrant','fields':fields_},'updateTransforms':[{'fieldPath':'purgeStartedAt','setToServerValue':'REQUEST_TIME'}]}]},auth)
st,res=lock('agent',agent);expect(st,res,403,'ordinary detective cannot take a purge lock')
st,res=lock('admin',admin);expect(st,res,200,'director takes permanent deletion lock')
lockedRestore={**restored,'version':5,'auditId':'locked-restore'};log.update(version=5,action='restored')
st,res=call('POST',':commit',{'writes':[write('records/new-warrant',lockedRestore),{'delete':ROOT+'trash/new-warrant'},write('records/new-warrant/history/locked-restore',log,True)]},admin);expect(st,res,403,'cannot restore during permanent deletion')
st,res=call('DELETE','/records/new-warrant/history/event1',auth=agent);expect(st,res,403,'ordinary detective cannot delete history')
st,entries=call('GET','/records/new-warrant/history',auth=admin);expect(st,entries,200,'director reads history for cleanup')
st,res=call('POST',':commit',{'writes':[{'delete':entry['name']} for entry in entries.get('documents',[])]},admin);expect(st,res,200,'director batch deletes all history entries')
st,res=call('DELETE','/trash/new-warrant',auth=admin);expect(st,res,200,'director permanently removes locked trash record')
st,res=call('GET','/records/new-warrant/history');expect(st,res,200,'verify orphan history cleanup');assert not res.get('documents')
# Registry uniqueness is normalized and enforced atomically, not just by UI.
def registry_write(recordId,col,value,auth=admin,actor='admin',reserve=True,key_override=None):
 field={'citizens':'citizenId','vehicles':'plate','weapons':'serial'}[col]
 normalized=''.join(value.upper().split());key=key_override or col+'_'+normalized
 data={'id':recordId,'col':col,field:value,'uniqueKey':key,'version':1,'auditId':'identity-audit','fullName':'Registry Test'}
 audit={'actorUid':actor,'actorName':actor,'version':1,'action':'created','changes':{'identity':{'before':'','after':value}}}
 writes=[write('records/'+recordId,data),write('records/'+recordId+'/history/identity-audit',audit,True)]
 if reserve:writes.append(write('uniqueKeys/'+key,{'recordId':recordId,'col':col,'value':normalized}))
 return call('POST',':commit',{'writes':writes},auth),data,key
(st,res),citizen,key=registry_write('citizen-original','citizens',' ab c123 ');expect(st,res,200,'reserve normalized citizen ID')
(st,res),_,_=registry_write('citizen-duplicate','citizens','ABC123');expect(st,res,403,'block duplicate citizen ID across users')
(st,res),_,_=registry_write('citizen-no-lock','citizens','OTHER123',reserve=False);expect(st,res,403,'cannot bypass unique identity reservation')
(st,res),_,_=registry_write('citizen-fake-key','citizens','ABC123',key_override='citizens_FAKE');expect(st,res,403,'cannot forge a different unique key')
(st,res),_,_=registry_write('vehicle-original','vehicles',' ab 12 cd ');expect(st,res,200,'reserve normalized plate')
(st,res),_,_=registry_write('vehicle-duplicate','vehicles','AB12CD');expect(st,res,403,'block duplicate plate')
(st,res),_,_=registry_write('weapon-original','weapons',' sn-123 ');expect(st,res,200,'reserve firearm serial')
(st,res),_,_=registry_write('weapon-duplicate','weapons','SN-123');expect(st,res,403,'block duplicate firearm serial')
st,res=call('DELETE','/uniqueKeys/'+key,auth=admin);expect(st,res,403,'cannot release identity of an active record')
trashData={'col':'citizens','record':citizen,'deletedBy':'admin','deletedUid':'admin','auditId':'trash-identity'}
trashWrite=write('trash/citizen-original',trashData);trashWrite['updateTransforms']=[{'fieldPath':'deletedAt','setToServerValue':'REQUEST_TIME'}]
audit={'actorUid':'admin','actorName':'admin','version':1,'action':'trashed','changes':{'state':{'before':'Active','after':'Trash'}}}
st,res=call('POST',':commit',{'writes':[trashWrite,write('records/citizen-original/history/trash-identity',audit,True),{'delete':ROOT+'records/citizen-original'},{'delete':ROOT+'uniqueKeys/'+key}]},admin);expect(st,res,200,'moving citizen to trash releases its identity atomically')
(st,res),_,_=registry_write('citizen-replacement','citizens','ABC123');expect(st,res,200,'identity can be used after previous record moves to trash')
restoredCitizen={**citizen,'version':2,'auditId':'restore-identity'};audit.update(version=2,action='restored')
st,res=call('POST',':commit',{'writes':[write('records/citizen-original',restoredCitizen),write('records/citizen-original/history/restore-identity',audit,True),write('uniqueKeys/'+key,{'recordId':'citizen-original','col':'citizens','value':'ABC123'}),{'delete':ROOT+'trash/citizen-original'}]},admin);expect(st,res,403,'restoration cannot create a duplicate citizen')
# Changing an identifier moves its reservation without leaving an old lock.
updatedVehicle={'id':'vehicle-original','col':'vehicles','plate':'NEW 456','uniqueKey':'vehicles_NEW456','version':2,'auditId':'identity-change','fullName':'Registry Test'}
audit={'actorUid':'admin','actorName':'admin','version':2,'action':'updated','changes':{'plate':{'before':' ab 12 cd ','after':'NEW 456'}}}
st,res=call('POST',':commit',{'writes':[write('records/vehicle-original',updatedVehicle),write('records/vehicle-original/history/identity-change',audit,True),write('uniqueKeys/vehicles_NEW456',{'recordId':'vehicle-original','col':'vehicles','value':'NEW456'}),{'delete':ROOT+'uniqueKeys/vehicles_AB12CD'}]},admin);expect(st,res,200,'identifier edits move their unique reservation')
legacy={'id':'legacy-warrant','col':'warrants','targets':['citizen-a'],'reason':'Legacy','version':1,'auditId':'old','workflow':{'status':'Approved','reviewedBy':'Former reviewer'}}
st,res=call('PATCH','/records/legacy-warrant',{'fields':fields(legacy)});expect(st,res,200,'seed legacy approved warrant')
updated={**legacy,'version':2,'auditId':'legacy-draft','workflow':{'status':'Draft'},'legacyWorkflow':legacy['workflow'],'reason':'Editable draft request'}
audit={'actorUid':'agent','actorName':'agent','version':2,'action':'updated','changes':{'workflow':{'before':'Approved','after':'Draft'}}}
st,res=call('POST',':commit',{'writes':[write('records/legacy-warrant',updated),write('records/legacy-warrant/history/legacy-draft',audit,True)]},agent);expect(st,res,200,'legacy approval statuses can be archived and reopened as drafts')
from concurrent.futures import ThreadPoolExecutor
with ThreadPoolExecutor(max_workers=2) as pool:
 first=pool.submit(registry_write,'race-first','vehicles','RACE 123')
 second=pool.submit(registry_write,'race-second','vehicles','race123',agent,'agent')
 outcomes=sorted([first.result()[0][0],second.result()[0][0]])
 assert outcomes==[200,403],outcomes
print('PASS concurrent duplicate plate attempts allow exactly one winner')
print('ALL RULE SCENARIOS PASSED')
