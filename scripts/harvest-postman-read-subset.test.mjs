import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { checkScripts, requestPlan, runCollection } from './harvest-postman-read-subset.mjs'

const paths=['clients','clients/:client_id','projects','projects/:project_id','tasks','tasks/:task_id','expenses','expenses/:expense_id','time_entries','time_entries/:time_entry_id','users','users/:user_id','users/me','users/:user_id/project_assignments','users/me/project_assignments']
const collection = () => ({item:paths.map(path=>({name:path,request:{method:'GET',url:{raw:'https://api.harvestapp.com/v2/'+path},header:[]}}))})
const config = () => ({origin:'http://localhost:3000',expectedSourceRevision:'1'.repeat(40),token:'fake-read-only-fixture',ids:{client_id:1,project_id:1,task_id:1,expense_id:1,time_entry_id:1,user_id:1}})

test('rejects nonblank scripts, writes and unapproved origins before transport',()=>{
 assert.throws(()=>checkScripts({event:[{script:{exec:['pm.sendRequest("https://external.example")']}}]}))
 assert.throws(()=>requestPlan({request:{method:'POST',url:{raw:'https://api.harvestapp.com/v2/clients'}}},config()))
 assert.throws(()=>requestPlan({request:{method:'GET',url:{raw:'https://other.example/v2/clients'}}},config()))
 assert.throws(()=>requestPlan(collection().item[0],{...config(),origin:'http://example.com'}))
})

test('zero, short and duplicate selections fail without issuing any request',async()=>{
 let requests=0; const transport=async()=>{requests++;throw Error('unexpected transport')}
 for(const input of [{item:[]},{item:collection().item.slice(1)},{item:Array(15).fill(collection().item[0])}])await assert.rejects(runCollection(input,config(),transport))
 assert.equal(requests,0)
})

test('non200 responses and mismatched independently probed revision fail',async()=>{
 let requests=0
 await assert.rejects(runCollection(collection(),config(),async()=>++requests===1?Response.json({release:config().expectedSourceRevision}):new Response('unavailable',{status:503})),/Selected request failed/)
 assert.equal(requests,2)
 await assert.rejects(runCollection(collection(),config(),async()=>Response.json({release:'2'.repeat(40)})),/Health revision mismatch/)
})

test('redirects are refused instead of forwarding credentials or visiting a target',async()=>{
 let redirected=0
 const server=createServer((request,response)=>{if(request.url==='/healthz'){response.writeHead(302,{location:'/redirect-target'});response.end()}else{redirected++;response.end('{}')}})
 server.listen(0,'127.0.0.1');await once(server,'listening')
 const port=server.address().port
 try{await assert.rejects(runCollection(collection(),{...config(),origin:`http://127.0.0.1:${port}`}));assert.equal(redirected,0)}finally{await new Promise(resolve=>server.close(resolve))}
})
