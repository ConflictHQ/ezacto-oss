#!/usr/bin/env python3
"""Provision, exercise and remove only this disposable CSV proof target.
Uses Wrangler's existing OAuth without changing it. No production bindings.
"""
import hashlib,json,os,pathlib,re,secrets,subprocess,time,urllib.request,urllib.error,uuid
ROOT=pathlib.Path(__file__).resolve().parents[2]
ACCOUNT='00000000000000000000000000000000'
name='ezacto-csv1184-proof-'+secrets.token_hex(4)
out=pathlib.Path('/tmp')/name;out.mkdir(mode=0o700)
env=dict(os.environ,CLOUDFLARE_ACCOUNT_ID=ACCOUNT);env.pop('CLOUDFLARE_API_TOKEN',None)
manifest={'name':name,'account_id':ACCOUNT,'created':[],'source_revision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()}
def save(): (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
def cli(*args,stdin=None):
 p=subprocess.run(['npx','wrangler',*args],cwd=ROOT,env=env,input=stdin,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 (out/('command-'+str(time.time_ns())+'.log')).write_text(p.stdout)
 if p.returncode: raise RuntimeError('Wrangler command failed: '+ ' '.join(args[:3])+'; private log in '+str(out))
 return p.stdout
save();secret=secrets.token_hex(32);cursor=secrets.token_urlsafe(32)
config=out/'wrangler.json';url=None;tokens=None
try:
 bundle=out/'worker.mjs'
 build_script='import {build} from \"esbuild\";await build({entryPoints:[\"scripts/proof/csv-worker-entry.mjs\"],bundle:true,conditions:[\"development\"],platform:\"browser\",format:\"esm\",external:[\"node:async_hooks\"],outfile:'+json.dumps(str(bundle))+'});'
 subprocess.run(['node','--input-type=module','-e',build_script],cwd=ROOT,check=True)
 manifest['bundle_sha256']=hashlib.sha256(bundle.read_bytes()).hexdigest();save()
 print('Creating owned proof resources '+name,flush=True)
 result=cli('d1','create',name);match=re.search(r'"database_id"\s*:\s*"([a-f0-9-]+)"',result)
 if not match:match=re.search(r'([a-f0-9]{8}-[a-f0-9-]{27,})',result)
 if not match:raise RuntimeError('D1 identifier missing')
 manifest['database_id']=match.group(1);manifest['created'].append('d1');save()
 cli('r2','bucket','create',name);manifest['created'].append('r2');save()
 cli('queues','create',name);manifest['created'].append('queue');save()
 cli('queues','create',name+'-dlq');manifest['created'].append('dlq');save()
 value={'name':name,'account_id':ACCOUNT,'main':str(bundle),'no_bundle':True,'compatibility_date':'2026-08-26','compatibility_flags':['nodejs_als'],'workers_dev':True,'observability':{'enabled':False},'vars':{'ENVIRONMENT':'test','RELEASE':manifest['source_revision'],'PROOF_ID':name,'APP_BASE_URL':'https://invalid.invalid','CSV_IMPORT_QUEUE_NAME':name},'d1_databases':[{'binding':'DB','database_name':name,'database_id':manifest['database_id']}],'r2_buckets':[{'binding':'ATTACHMENTS','bucket_name':name}],'queues':{'producers':[{'binding':'CSV_IMPORT_QUEUE','queue':name}],'consumers':[{'queue':name,'max_batch_size':1,'max_batch_timeout':1,'max_retries':3,'retry_delay':5,'dead_letter_queue':name+'-dlq','max_concurrency':1}]}}
 config.write_text(json.dumps(value));result=cli('deploy','--config',str(config));manifest['created'].append('worker');save()
 found=re.search(r'https://'+re.escape(name)+r'\.[a-zA-Z0-9.-]+\.workers\.dev',result)
 if not found:raise RuntimeError('Owned Worker URL missing')
 url=found.group(0);value['vars']['APP_BASE_URL']=url;config.write_text(json.dumps(value))
 cli('secret','bulk','--config',str(config),stdin=json.dumps({'PROOF_SECRET':secret,'API_CURSOR_SIGNING_KEY':cursor}))
 result=cli('deploy','--config',str(config));revision=re.search(r'Current Version ID:\s*([a-f0-9-]+)',result)
 manifest.update(url=url,deployed_revision=revision.group(1) if revision else 'see private deploy log');save()
 def req(path,body=None,method=None,token=None,raw=False,expected=200):
  if path in ['/__proof/repair','/__proof/hold','/__proof/duplicate']:expected=204
  h={'x-owned-proof':secret,'origin':url,'user-agent':'Mozilla/5.0 (owned CSV acceptance)'}
  if token:h['cookie']='__Host-ezacto_session='+token
  if body is not None:
   if not raw:
    if isinstance(body,dict) and 'command_id' in body:h['idempotency-key']=body['command_id']
    body=json.dumps(body).encode();h['content-type']='application/json'
   else:h.update({'content-type':'application/octet-stream','x-csv-bytes':str(len(body)),'x-csv-sha256':hashlib.sha256(body).hexdigest()})
  r=urllib.request.Request(url+path,data=body,headers=h,method=method or ('POST' if body is not None else 'GET'))
  try:response=urllib.request.urlopen(r,timeout=180)
  except urllib.error.HTTPError as e:response=e
  payload=response.read()
  if response.status!=expected:raise RuntimeError(f'{path} expected {expected}, got {response.status}: '+payload.decode()[:300])
  return json.loads(payload) if payload else None
 step=0
 while not req('/__proof/schema',{'step':step})['done']:step+=1
 print('Owned schema prepared',flush=True)
 tokens=req('/__proof/seed',{},token=None)
 admin=tokens['admin'];req('/api/v1/csv-import-capabilities',token=admin)
 data=b'Email,Client,Project,Task,Description,Billable,Start Date,Start Time,End Date,End Time,Duration (h)\nowned@example.test,C,P,T,Owned proof one,Yes,2026-09-01,09:00:00,2026-09-01,10:00:00,01:00:00\nowned@example.test,C,P,T,Owned proof two,Yes,2026-09-02,09:00:00,2026-09-02,10:00:00,01:00:00\n'
 stage=req('/api/v1/csv-imports',data,token=admin,raw=True,expected=201)['data'];base='/api/v1/csv-imports/'+stage['id']
 req(base,token=tokens['other'],expected=404);req(base,token=tokens['staff'],expected=403);req(base,expected=401)
 req(base+'/mapping',{'version':stage['version'],'workspace_identity':name,'exporter_zone':'UTC','date_format':'iso','destination_interpretation':'source_wall_time','currency_policy':'destination_rates','mapping':{},'excluded_lines':[]},method='PATCH',token=admin)
 preview=req(base+'/preview',{},token=admin)['data'];assert req('/__proof/inspect')['time']['count']==0
 command={'command_id':str(uuid.uuid4()),'preview_id':preview['preview_id'],'version':preview['run']['version'],'expected_selected_rows':2,'expected_source_seconds':7200,'expected_destination_seconds':7200,'acknowledge_exclusions':False,'acknowledge_destination_difference':True,'acknowledge_new_people':True}
 req(base+'/apply',command,token=admin);before=req('/__proof/inspect');assert before['stages'][0]['publish_pending']==1
 req('/__proof/repair',{});print('Native API admission and preview passed; awaiting real Queue apply',flush=True);deadline=time.time()+180
 while True:
  result=req('/__proof/inspect')
  if result['stages'][0]['status']=='completed':break
  if time.time()>deadline:raise RuntimeError('Queue completion deadline; safe status '+json.dumps(result))
  time.sleep(2)
 print('Real Queue import completed',flush=True)
 altered=dict(command,version=command['version']+1)
 req(base+'/apply',altered,token=admin,expected=409)
 req(base+'/apply',command,token=admin);req('/__proof/duplicate',{'stage_id':stage['id']});time.sleep(5)
 result=req('/__proof/inspect');assert result['time']=={'count':2,'seconds':7200},result['time'];assert max(result['calls'])<=50,result['calls'];assert result['money']==before['money']
 req(base+'/input',method='DELETE',token=admin,expected=204);final=req('/__proof/inspect');assert not final['objects'];assert final['time']==result['time']
 # A second actual API import pauses after one durable row, then native
 # cancellation must survive queued redelivery and retain exactly that row.
 second=data.replace(b'2026-09-01',b'2026-10-01').replace(b'2026-09-02',b'2026-10-02')
 two=req('/api/v1/csv-imports',second,token=admin,raw=True,expected=201)['data'];base2='/api/v1/csv-imports/'+two['id']
 req(base2+'/mapping',{'version':two['version'],'workspace_identity':name,'exporter_zone':'UTC','date_format':'iso','destination_interpretation':'source_wall_time','currency_policy':'destination_rates','mapping':{},'excluded_lines':[]},method='PATCH',token=admin)
 prev2=req(base2+'/preview',{},token=admin)['data'];cmd2=dict(command,command_id=str(uuid.uuid4()),preview_id=prev2['preview_id'],version=prev2['run']['version'])
 req('/__proof/hold',{'stage_id':two['id']});req(base2+'/apply',cmd2,token=admin);deadline=time.time()+120
 while req('/__proof/inspect')['time']['count']<3:
  if time.time()>deadline:raise RuntimeError('Partial cancellation proof did not commit first row')
  time.sleep(2)
 req(base2+'/cancel',{'command_id':str(uuid.uuid4())},token=admin);req('/__proof/hold',{'stage_id':None});req('/__proof/duplicate',{'stage_id':two['id']});time.sleep(6)
 cancelled=req('/__proof/inspect');assert cancelled['time']=={'count':3,'seconds':10800},cancelled['time']
 assert [r for r in cancelled['stages'] if r['id']==two['id']][0]['status']=='cancelled'
 req(base2+'/input',method='DELETE',token=admin,expected=204);cancelled=req('/__proof/inspect');assert not cancelled['objects'];assert cancelled['money']==before['money']
 evidence={'manifest':manifest,'checks':{'ordinary_native_auth':True,'other_admin_denied':True,'staff_denied':True,'anonymous_denied':True,'preview_time_writes':0,'lost_publication_repaired':True,'replay_and_duplicate_safe':True,'time':final['time'],'money_before':before['money'],'money_after':final['money'],'queue_d1_calls':result['calls'],'private_objects_after_purge':len(cancelled['objects']),'partial_cancel_retains_exactly_one_row':True,'after_partial_cancel_time':cancelled['time'],'altered_command_denied':True}}
 (out/'evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print('Owned deployed proof passed; evidence '+str(out/'evidence.json'),flush=True)
finally:
 errors=[]
 if url and 'worker' in manifest['created']:
  try:req('/__proof/cleanup')
  except Exception as e:errors.append(str(e))
 if 'worker' in manifest['created']:
  try:cli('queues','consumer','remove',name,name)
  except Exception as e:errors.append(str(e))
 for kind in reversed(manifest['created']):
  try:
   if kind=='worker':cli('delete','--name',name,'--force','--config',str(config))
   elif kind=='dlq':cli('queues','delete',name+'-dlq')
   elif kind=='queue':cli('queues','delete',name)
   elif kind=='r2':cli('r2','bucket','delete',name)
   elif kind=='d1':cli('d1','delete',name,'--skip-confirmation')
  except Exception as e:errors.append(str(e))
 manifest['cleanup_errors']=errors;manifest['cleaned_at']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime());save()
 print('Owned resource cleanup '+('complete' if not errors else 'NEEDS FOLLOW-UP')+'; manifest '+str(out/'manifest.json'),flush=True)
 if errors:raise RuntimeError('; '.join(errors))
