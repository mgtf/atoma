import { writeFileSync } from 'node:fs';

/** Real JSONL subprocess; no provider or paid call. */
export function writeCodexStub(path: string, options: { report: unknown; log: string; edit?: boolean; command?: string; fail?: boolean; read?: boolean; rpcError?: { method: string; code: number; message: string } }): void {
  const editCommand = `printf '%s\\n' 'export const add = (a, b) => a + b;' > src/adder.mjs\nprintf '%s\\n' 'import {add} from "../src/adder.mjs"; if(add(1,2)!==3) process.exit(1);' > tests/adder.test.mjs`;
  writeFileSync(path, `
import {createInterface} from 'node:readline';
import {writeFileSync,readFileSync,appendFileSync} from 'node:fs';
const config = ${JSON.stringify(options)};
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
if (process.env.OPENAI_API_KEY || process.env.GH_TOKEN || process.env.ATOMA_MENDER_DISPATCH_TOKEN) process.exit(21);
const done = () => {
  const auth = JSON.parse(readFileSync(process.env.CODEX_HOME + '/auth.json','utf8'));
  auth.tokens.refresh_token = 'rotated';
  writeFileSync(process.env.CODEX_HOME + '/auth.json', JSON.stringify(auth));
  send({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{inputTokens:100,cachedInputTokens:60,outputTokens:20}}}});
  send({method:'item/completed',params:{item:{type:'agentMessage',text:JSON.stringify(config.report)}}});
  send({method:'turn/completed',params:{turn:{status:config.fail?'failed':'completed'}}});
};
const rl = createInterface({input:process.stdin});
rl.on('line', line => {
  const m = JSON.parse(line); appendFileSync(config.log, line + '\\n');
  if (config.rpcError && config.rpcError.method === m.method) {
    send({ id: m.id, error: { code: config.rpcError.code, message: config.rpcError.message } }); return;
  }
  if(m.method==='initialize') send({id:m.id,result:{userAgent:'stub'}});
  if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread-test'},model:'gpt-5.6-sol'}});
  if(m.method==='turn/start') {
    send({id:m.id,result:{turn:{id:'turn-test',status:'inProgress'}}});
    if(config.read) send({id:10,method:'item/tool/call',params:{tool:'read_evidence',arguments:{path:'src/example.ts',query:'',offset:0,limit:20}}});
    else if(config.edit || config.command) send({id:12,method:'item/tool/call',params:{tool:'worktree_command',arguments:{command:config.command || ${JSON.stringify(editCommand)}}}});
    else done();
  }
  if(m.id===10 && m.result) {
    send({id:11,method:'item/tool/call',params:{tool:'read_evidence',arguments:{path:'../.env',query:'',offset:0,limit:20}}});
  }
  if(m.id===11 && m.result) done();
  if(m.id===12 && m.result) done();
});
`);
}
