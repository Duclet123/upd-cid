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
(st,res),submitted=save({**record,'workflow':{'status':'Submitted','submittedUid':'admin','submittedBy':'admin','submittedAt':1}},2);expect(st,res,200,'submit draft + audit')
(st,res),_=save({**submitted,'reason':'silently changed'},3);expect(st,res,403,'deny editing submitted warrant')
review={**submitted,'workflow':{**submitted['workflow'],'status':'Approved','note':'','reviewedUid':'agent','reviewedBy':'agent','reviewedAt':2}}
(st,res),_=save(review,3,agent,'agent');expect(st,res,403,'deny approval by ordinary detective')
review['workflow'].update(reviewedUid='admin',reviewedBy='admin')
(st,res),approved=save(review,3);expect(st,res,200,'director approves submitted warrant')
st,res=call('GET','/records/new-warrant/history/event1',auth='');expect(st,res,403,'history is private')
# Trash atomically preserves the exact active record and private audit trail.
trash={'col':'warrants','record':approved,'deletedBy':'admin','deletedUid':'admin','auditId':'trashevent'}
trashWrite=write('trash/new-warrant',trash);trashWrite['updateTransforms']=[{'fieldPath':'deletedAt','setToServerValue':'REQUEST_TIME'}]
log={'actorUid':'admin','actorName':'admin','version':3,'action':'trashed','changes':{'lifecycle':{'before':'Active','after':'Trash'}}}
st,res=call('POST',':commit',{'writes':[trashWrite,write('records/new-warrant/history/trashevent',log,True),{'delete':ROOT+'records/new-warrant'}]},admin);expect(st,res,200,'move approved warrant to trash')
restored={**approved,'version':4,'auditId':'restoreevent','updatedAt':100}
log.update(version=4,action='restored')
st,res=call('POST',':commit',{'writes':[write('records/new-warrant',restored),{'delete':ROOT+'trash/new-warrant'},write('records/new-warrant/history/restoreevent',log,True)]},admin);expect(st,res,200,'restore approved warrant with complete history')
print('ALL RULE SCENARIOS PASSED')
