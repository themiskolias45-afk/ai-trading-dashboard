const fs=require('fs'),http=require('http');
const env=fs.readFileSync('keys.env','utf8');
const g=k=>{const m=env.match(new RegExp('^\s*'+k+'\s*=\s*(.+)$','m'));return m?m[1].trim():null;};
const u=g('DASHBOARD_USERNAME'),p=g('DASHBOARD_PASSWORD');
if(!u||!p){console.log('no creds');process.exit(1)}
const post=(path,body,cookie)=>new Promise((res,rej)=>{
  const d=JSON.stringify(body);
  const r=http.request({host:'localhost',port:3001,path,method:body?'POST':'GET',timeout:20000,
    headers:Object.assign(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(d)}:{}, cookie?{Cookie:cookie}:{})},
    x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>res({b,h:x.headers,s:x.statusCode}))});
  r.on('error',rej); r.on('timeout',()=>{r.destroy();rej(new Error('timeout'))});
  if(body)r.write(d); r.end();});
(async()=>{
  const login=await post('/api/login',{username:u,password:p});
  const ck=(login.h['set-cookie']||[]).map(c=>c.split(';')[0]).join('; ');
  if(login.s!==200){console.log('login',login.s,login.b.slice(0,120));return}
  const plan=await post('/api/plan',null,ck);
  const j=JSON.parse(plan.b);
  console.log('regime:',j.regime);
  console.log('rules:');(j.rules||[]).forEach(x=>console.log('  -',x));
  console.log('rules is array:',Array.isArray(j.rules),'len',(j.rules||[]).length);
})().catch(e=>console.log('ERR',e.message));
