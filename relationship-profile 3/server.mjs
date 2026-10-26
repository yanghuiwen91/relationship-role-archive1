import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {calculate} from './public/scoring.mjs';
const ROOT=dirname(fileURLToPath(import.meta.url));
if(existsSync(resolve(ROOT,'.env')))process.loadEnvFile(resolve(ROOT,'.env'));
const port=Number(process.env.PORT||3100),host=process.env.HOST||'127.0.0.1',prod=process.env.NODE_ENV==='production';
const secret=process.env.CODE_PEPPER||'',admin=process.env.ADMIN_PASSWORD||'',configured=secret.length>=32&&admin.length>=24;
if(prod&&!configured)throw Error('生产模式需要 CODE_PEPPER ≥32 字符和 ADMIN_PASSWORD ≥24 字符');
const dbpath=process.env.DB_PATH||resolve(ROOT,'data/archive.sqlite');mkdirSync(dirname(dbpath),{recursive:true});
const db=new DatabaseSync(dbpath);db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS codes(id INTEGER PRIMARY KEY,hash TEXT UNIQUE NOT NULL,label TEXT,expires INTEGER NOT NULL,quota INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0,disabled INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,code_id INTEGER,admin INTEGER DEFAULT 0,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,code_id INTEGER NOT NULL,key TEXT NOT NULL,answers TEXT NOT NULL DEFAULT '[]',position INTEGER DEFAULT 0,revision INTEGER DEFAULT 0,status TEXT DEFAULT 'active',report TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(code_id,key));
CREATE UNIQUE INDEX IF NOT EXISTS one_active ON runs(code_id) WHERE status='active';
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,code_id INTEGER,run_id TEXT,kind TEXT,time INTEGER);
CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY,count INTEGER,reset INTEGER);`);
const content={questions:JSON.parse(readFileSync(resolve(ROOT,'config/questions.json'))),roles:JSON.parse(readFileSync(resolve(ROOT,'config/roles.json'))),scoring:JSON.parse(readFileSync(resolve(ROOT,'config/scoring.json'))),report:JSON.parse(readFileSync(resolve(ROOT,'config/report.json')))};
const now=()=>Date.now(),hash=s=>createHash('sha256').update(secret+s).digest('hex'),token=()=>randomBytes(24).toString('base64url');
const one=(sql,...v)=>db.prepare(sql).get(...v),all=(sql,...v)=>db.prepare(sql).all(...v),exec=(sql,...v)=>db.prepare(sql).run(...v);
function fail(message,status=400){throw Object.assign(Error(message),{status})}
function equal(a,b){const x=createHash('sha256').update(a).digest(),y=createHash('sha256').update(b).digest();return timingSafeEqual(x,y)}
function rate(req,scope,max){const key=hash(scope+req.socket.remoteAddress),r=one('SELECT * FROM limits WHERE key=?',key);if(r&&r.reset>now()&&r.count>=max)fail('尝试过于频繁，请15分钟后再试',429);if(!r||r.reset<=now())exec('INSERT OR REPLACE INTO limits VALUES(?,?,?)',key,1,now()+900000);else exec('UPDATE limits SET count=count+1 WHERE key=?',key)}
function session(req,adminOnly=false){const cookie=(req.headers.cookie||'').match(/(?:^|; )archive=([A-Za-z0-9_-]+)/);const s=cookie&&one('SELECT * FROM sessions WHERE hash=? AND expires>?',hash(cookie[1]),now());if(!s||adminOnly&&!s.admin)fail('请先验证身份',401);if(!s.admin){const c=one('SELECT * FROM codes WHERE id=?',s.code_id);if(!c||c.disabled)fail('访问码已停用',403)}return s}
function setSession(res,codeId,isAdmin){const t=token();exec('INSERT INTO sessions VALUES(?,?,?,?)',hash(t),codeId,isAdmin?1:0,now()+(isAdmin?14400000:2592000000));res.setHeader('Set-Cookie',`archive=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${isAdmin?14400:2592000}${prod?'; Secure':''}`)}
function runFor(s,id){const r=one('SELECT * FROM runs WHERE id=? AND code_id=?',id,s.code_id);if(!r)fail('档案不存在',404);return r}
function view(r){return{id:r.id,answers:JSON.parse(r.answers),position:r.position,revision:r.revision,status:r.status,report:r.report?JSON.parse(r.report):null,created:r.created}}
function status(s){const c=one('SELECT * FROM codes WHERE id=?',s.code_id);return{remaining:c.quota-c.used,expires:c.expires,expired:c.expires<=now(),runs:all('SELECT * FROM runs WHERE code_id=? ORDER BY created DESC',c.id).map(view)}}
async function body(req){let data='';for await(const c of req){data+=c;if(data.length>12000)fail('请求过大',413)}try{return JSON.parse(data||'{}')}catch{fail('请求格式错误')}}
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 const send=(v,code=200)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(v))};
 try{const path=new URL(req.url,'http://localhost').pathname;
 if(path.startsWith('/api/')){
 if(req.method!=='GET'&&req.method!=='POST')fail('不支持的请求',405);
 if(req.method==='POST'){const origin=req.headers.origin;if(origin&&origin!==`${prod?'https':'http'}://${req.headers.host}`)fail('请求来源不匹配',403);if(!String(req.headers['content-type']).startsWith('application/json'))fail('需要 JSON 请求',415)}
 if(path==='/api/config')return send({configured,demo:true});
 if(!configured)fail('正式访问码与后台尚未配置，请使用独立演示入口',503);
 const b=req.method==='POST'?await body(req):{};
 if(path==='/api/verify'&&req.method==='POST'){rate(req,'code',12);const code=String(b.code||'').toUpperCase().replace(/[\s-]/g,'');const c=one('SELECT * FROM codes WHERE hash=?',hash(code));if(!c)fail('访问码无效，请检查后重试');if(c.disabled)fail('访问码已停用',403);const has=one('SELECT id FROM runs WHERE code_id=?',c.id);if(c.expires<=now()&&!has)fail('访问码已过期',403);if(c.used>=c.quota&&!has)fail('可测试次数已用完',403);exec('DELETE FROM limits WHERE key=?',hash('code'+req.socket.remoteAddress));setSession(res,c.id,false);return send(status({code_id:c.id}))}
 if(path==='/api/admin/login'&&req.method==='POST'){rate(req,'admin',5);if(!equal(String(b.password||''),admin))fail('管理密码不正确',403);exec('DELETE FROM limits WHERE key=?',hash('admin'+req.socket.remoteAddress));setSession(res,null,true);return send({ok:true})}
 if(path==='/api/logout'&&req.method==='POST'){const s=session(req);exec('DELETE FROM sessions WHERE hash=?',s.hash);res.setHeader('Set-Cookie','archive=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send({ok:true})}
 if(path.startsWith('/api/admin/')){
 session(req,true);
 if(path==='/api/admin/codes'&&req.method==='GET')return send({codes:all('SELECT id,label,expires,quota,used,disabled,created FROM codes ORDER BY id DESC LIMIT 1000'),events:all('SELECT code_id,run_id,kind,time FROM events ORDER BY id DESC LIMIT 200')});
 if(path==='/api/admin/generate'&&req.method==='POST'){
 const count=Number(b.count),quota=Number(b.quota),days=Number(b.days);if(!Number.isInteger(count)||count<1||count>100||!Number.isInteger(quota)||quota<1||quota>100||!Number.isInteger(days)||days<1||days>3650)fail('数量1–100、次数1–100、有效天数1–3650，均需为整数');
 const codes=[];db.exec('BEGIN IMMEDIATE');try{for(let i=0;i<count;i++){const c=randomBytes(12).toString('hex').toUpperCase(),expires=now()+days*86400000;const r=exec('INSERT INTO codes(hash,label,expires,quota,created) VALUES(?,?,?,?,?)',hash(c),String(b.label||'').slice(0,60),expires,quota,now());codes.push({id:Number(r.lastInsertRowid),code:c.match(/.{4}/g).join('-'),expires,quota});}db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}return send({codes});}
 if(path==='/api/admin/disable'&&req.method==='POST'){exec('UPDATE codes SET disabled=? WHERE id=?',b.disabled?1:0,Number(b.id));exec('INSERT INTO events(code_id,kind,time) VALUES(?,?,?)',Number(b.id),b.disabled?'disabled':'enabled',now());return send({ok:true})}fail('接口不存在',404);
 }
 const s=session(req);if(s.admin)fail('请用访问码进入测试',403);
 if(path==='/api/session')return send(status(s));
 if(path==='/api/start'&&req.method==='POST'){
 if(!/^[A-Za-z0-9_-]{16,80}$/.test(b.key||''))fail('缺少有效的请求标识');
 db.exec('BEGIN IMMEDIATE');try{
 let r=one('SELECT * FROM runs WHERE code_id=? AND key=?',s.code_id,b.key)||one("SELECT * FROM runs WHERE code_id=? AND status='active'",s.code_id);
 if(!r){const c=one('SELECT * FROM codes WHERE id=?',s.code_id);if(c.expires<=now())fail('访问码已过期，仍可查看已有档案',403);if(c.used>=c.quota)fail('可测试次数已用完，仍可查看已有档案',403);const id=token();exec('UPDATE codes SET used=used+1 WHERE id=?',c.id);exec('INSERT INTO runs(id,code_id,key,created,updated) VALUES(?,?,?,?,?)',id,c.id,b.key,now(),now());exec('INSERT INTO events(code_id,run_id,kind,time) VALUES(?,?,?,?)',c.id,id,'started',now());r=one('SELECT * FROM runs WHERE id=?',id)}db.exec('COMMIT');return send(view(r));
 }catch(e){db.exec('ROLLBACK');throw e}}
 if(path==='/api/save'&&req.method==='POST'){
 const r=runFor(s,b.id);if(r.status!=='active')fail('这份档案已完成，请开始新的测试');if(b.revision!==r.revision)fail('进度已在其他页面更新，请刷新后继续',409);
 if(!Array.isArray(b.answers)||b.answers.length>24||b.answers.some(a=>a!==null&&(!Number.isInteger(a)||a<0||a>3))||!Number.isInteger(b.position)||b.position<0||b.position>23)fail('答案或进度无效');
 exec('UPDATE runs SET answers=?,position=?,revision=revision+1,updated=? WHERE id=?',JSON.stringify(b.answers),b.position,now(),r.id);return send(view(one('SELECT * FROM runs WHERE id=?',r.id)));}
 if(path==='/api/submit'&&req.method==='POST'){
 const r=runFor(s,b.id);if(r.status==='complete')return send(view(r));if(b.revision!==r.revision)fail('进度已更新，请刷新后继续',409);
 let report;try{report=calculate(JSON.parse(r.answers),content)}catch{fail('请完成全部24道题')}db.exec('BEGIN IMMEDIATE');try{exec("UPDATE runs SET status='complete',report=?,updated=? WHERE id=?",JSON.stringify(report),now(),r.id);exec('INSERT INTO events(code_id,run_id,kind,time) VALUES(?,?,?,?)',s.code_id,r.id,'completed',now());db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}return send(view(one('SELECT * FROM runs WHERE id=?',r.id)));}
 fail('接口不存在',404);
 }
 const assets={'/':'index.html','/admin':'index.html','/app.mjs':'app.mjs','/style.css':'style.css','/scoring.mjs':'scoring.mjs','/content.json':'content.json','/deployment.json':'deployment.json'};
 if(path==='/content.json')return send(content);const f=assets[path];if(!f)fail('页面不存在',404);const types={html:'text/html',css:'text/css',mjs:'text/javascript',json:'application/json'};res.writeHead(200,{'Content-Type':`${types[f.split('.').pop()]}; charset=utf-8`});res.end(readFileSync(resolve(ROOT,'public',f)));
 }catch(e){send({error:e.status?e.message:'请求暂时未能完成，请重试'},e.status||500)}
});server.listen(port,host,()=>console.log(`关系角色档案 http://${host}:${port} · ${configured?'正式服务已配置':'演示模式，正式后台未配置'}`));
