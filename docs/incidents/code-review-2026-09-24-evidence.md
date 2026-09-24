# Reproductions — revue de code du 24 septembre 2026


Ces reproductions documentent la révision `923bbab`, avant correction.
Les tests de non-régression et les résultats après correction sont recensés
dans la [section de fermeture de la revue](../code-review-2026-09-24.md#7-corrections-du-24-septembre).
Les scripts historiques ne sont pas le protocole de validation du code corrigé.
Référence : `923bbabb7ed01b2dc82f0dbe41018808c3dfed28`.

Ces expériences ont été exécutées localement sous Node `v24.20.0`, avec les
dépendances déjà installées. Elles appellent les fonctions de production et
le SDK MCP installé ; les acteurs, les données projet et les données de preview
sont des fixtures. Aucun appel LLM, accès GitHub, conteneur ou store utilisateur.
Les serveurs HTTP écoutent uniquement sur une adresse loopback et un port éphémère.

Les sorties ci-dessous décrivent les défauts observés ; ce ne sont pas des
résultats attendus pour une future suite de non-régression. Les scripts sont
indépendants et s'exécutent depuis la racine du dépôt, après sélection de la
version Node de `.nvmrc`. Ils ne modifient aucun fichier du dépôt.

## 1. Landing interrompu et admission MCP concurrente

```bash
node --import tsx --input-type=module <<'JS'
import { runDepthTask } from './src/run/depth.ts';
import { dispatchWithAggregation, markLanded } from './src/atoms/dispatch.ts';
import { McpHttpHost } from './src/mcp/http.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer, request } from 'node:http';
const controller = new AbortController();
let recovered;
try {
  await runDepthTask({mode:'short',task:{id:'t',description:'test'},floor:[],ctx:{signal:controller.signal,logger:{warn(){}},attempt:1},restart:async()=>{throw Error('unexpected')},onTopology(){},onAcceptance(){},createExecutor:()=>({actor:{},handle:async(task,ctx)=>{
    const outcome=await dispatchWithAggregation([{description:'completed'},{description:'interrupted'}],{aggregation:{mode:'sequential'}},ctx,async(_,i)=>{if(i===0)return {summary:'work kept',output:'ok'};controller.abort(new Error('deadline'));throw controller.signal.reason});
    recovered=markLanded({summary:'work kept',output:'ok'},outcome.unfinished);
    return recovered;
  }})});
  console.log('deadline: returned');
} catch(e) {console.log('deadline:',JSON.stringify({dispatchRecovered:recovered,error:e.message}));}
let built=0;
let host;
const server=createServer((req,res)=>void host.handle(req,res));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
host=new McpHttpHost({resolveCaller:()=>({kind:'operator'}),buildServer:()=>{built++;return new McpServer({name:'review-fixture',version:'0'})},allowedHosts:[`127.0.0.1:${port}`],maxSessions:1,maxSessionsPerCaller:1});
const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'review-fixture',version:'0'}}});
const requests=Array.from({length:3},()=>{
  let resolve;const done=new Promise(r=>resolve=r);
  const req=request({host:'127.0.0.1',port,path:'/mcp',method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','content-length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});
  req.write(body.slice(0,10)); return {req,done};
});
await new Promise(r=>setTimeout(r,200));
console.log('sessions-before-body:',JSON.stringify({built,health:host.health()}));
for(const {req} of requests)req.end(body.slice(10));
console.log('sessions-after-body:',JSON.stringify({statuses:await Promise.all(requests.map(x=>x.done)),health:host.health()}));
await host.close();server.closeAllConnections();await new Promise(r=>server.close(r));
JS
```

Sortie observée :

```text
deadline: {"dispatchRecovered":{"summary":"INCOMPLETE — the run deadline landed this plan with 1 phase(s) never run: interrupted. Delivered so far: work kept","output":"ok","unfinishedPhases":["interrupted"]},"error":"deadline"}
sessions-before-body: {"built":3,"health":{"sessions":0,"opened":0,"refused":0,"evicted":0,"overflowed":0,"replayEvictions":0}}
sessions-after-body: {"statuses":[200,200,200],"health":{"sessions":3,"opened":3,"refused":0,"evicted":0,"overflowed":0,"replayEvictions":0}}
```

## 2. Expiration de tâche et claim après résultat partiel

Le callback d'expiration réellement créé par le SDK est déclenché directement,
sans attendre 25 minutes. La seconde expérience utilise le service HTTP, le
manager et le registre de claims réels, avec des lecteurs de store simulés
représentant une génération `in-flight` encore `ready` après un run `partial`.
Elle prouve l'émission et la validité du claim, pas une exécution en conteneur.

```bash
node --import tsx --input-type=module <<'JS'
import { SessionTaskStore, projectRunTaskHandler } from './src/mcp/tasks.ts';
import { DEFAULT_PROJECT_RUN_TIMEOUT_MS } from './src/projects/coordinator.ts';
import { PreviewHttpService } from './src/preview/httpService.ts';
import { PreviewManager } from './src/preview/manager.ts';
import { PreviewClaimRegistry } from './src/preview/claims.ts';
import { randomUUID } from 'node:crypto';
const original=globalThis.setTimeout;
let expiry;
const timers=[];
globalThis.setTimeout=(fn,ms,...args)=>{if(ms===1500000)expiry=fn;const timer=original(fn,ms,...args);timers.push(timer);return timer};
const store=new SessionTaskStore();
const host={store,follow(){},cleanups:[]};
const service={startProjectRunFromInput:async()=>({projectRunId:'run-1',status:'running'}),projectRunStatus:()=>({status:'running'}),cancelProjectRun:async()=>{}};
const handler=projectRunTaskHandler(host,{viewer:()=>({}),service,pollMs:100000000});
const extra={taskStore:{createTask:p=>store.createTask(p,1,{method:'tools/call'}),getTask:id=>store.getTask(id),updateTaskStatus:(...a)=>store.updateTaskStatus(...a)}};
const {task}=await handler.createTask({projectId:'project',goal:'goal'},extra);
expiry();
console.log('task-expiry:',JSON.stringify({ttlMinutes:task.ttl/60000,runBudgetMinutes:DEFAULT_PROJECT_RUN_TIMEOUT_MS/60000,taskAfterExpiry:await store.getTask(task.taskId),run:service.projectRunStatus()}));
for(const stop of host.cleanups)stop();store.close();for(const timer of timers)clearTimeout(timer);globalThis.setTimeout=original;
const orgId=randomUUID(),projectId=randomUUID(),projectRunId=randomUUID();
const claims=new PreviewClaimRegistry();
const instance={state:'ready',generation:1,source:'in-flight',snapshotAt:new Date().toISOString(),readyAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),errorCode:null};
const previewStore={getDescriptor:()=>null,getInstance:()=>instance,listApprovedHosts:()=>[]};
const manager=new PreviewManager({store:previewStore,claims,config:{domain:'previews.example.net',publicScheme:'https',publicPort:null}});
const previews=new PreviewHttpService({manager,store:previewStore,projects:{getProjectRun:()=>({projectId,status:'partial'})}});
const viewer={orgId,principalId:randomUUID(),role:'org:member'};
const prior=previews.status(viewer,projectId,projectRunId);
const opened=await previews.open(viewer,projectId,projectRunId,{generation:1});
const url=new URL(opened.body.url);
console.log('preview-after-partial:',JSON.stringify({getAvailability:prior.availability,postStatus:opened.status,postAvailability:opened.body.summary.availability,claimRedeemable:!!claims.redeem(url.hash.slice(1),url.host)}));
JS
```

Sortie observée :

```text
task-expiry: {"ttlMinutes":25,"runBudgetMinutes":60,"taskAfterExpiry":null,"run":{"status":"running"}}
preview-after-partial: {"getAvailability":"unavailable","postStatus":200,"postAvailability":"available","claimRedeemable":true}
```

## 3. Session active balayée comme inactive

L'horloge injectable du host avance de 31 minutes pendant un vrai appel HTTP
qui attend une promesse. Le balayeur de production est invoqué directement
(JavaScript permet ici d'atteindre cette méthode privée TypeScript).

```bash
node --import tsx --input-type=module <<'JS'
import { McpHttpHost } from './src/mcp/http.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from 'node:http';
let now=0,host,finish,entered;
const enteredPromise=new Promise(r=>entered=r);
const done=new Promise(r=>finish=r);
const server=createServer((req,res)=>void host.handle(req,res));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port,url=`http://127.0.0.1:${port}/mcp`;
host=new McpHttpHost({now:()=>now,resolveCaller:()=>({kind:'operator'}),allowedHosts:[`127.0.0.1:${port}`],buildServer:()=>{const s=new McpServer({name:'fixture',version:'0'});s.registerTool('slow',{inputSchema:{}},async()=>{entered();await done;return {content:[{type:'text',text:'finished'}]}});return s}});
const headers={'content-type':'application/json',accept:'application/json, text/event-stream'};
const init=await fetch(url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'0'}}})});
const session=init.headers.get('mcp-session-id');await init.text();headers['mcp-session-id']=session;
const pending=fetch(url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'slow',arguments:{}}})}).then(async r=>({status:r.status,text:await r.text()})).catch(e=>({error:e.message}));
await enteredPromise;
now=31*60000;
await host.sweep(30*60000);
console.log('active-request-idle-sweep:',JSON.stringify({health:host.health(),response:await pending}));
finish();await host.close();server.closeAllConnections();await new Promise(r=>server.close(r));
JS
```

Sortie observée :

```text
active-request-idle-sweep: {"health":{"sessions":0,"opened":1,"refused":0,"evicted":0,"overflowed":0,"replayEvictions":0},"response":{"status":200,"text":""}}
```
