import {mkdirSync,copyFileSync,writeFileSync,readFileSync} from 'node:fs';import {resolve} from 'node:path';
const target=resolve(process.argv[2]||'dist');mkdirSync(target,{recursive:true});for(const f of ['index.html','style.css','app.mjs','scoring.mjs'])copyFileSync('public/'+f,target+'/'+f);
const content={};for(const f of ['questions','roles','scoring','report'])content[f]=JSON.parse(readFileSync('config/'+f+'.json'));writeFileSync(target+'/content.json',JSON.stringify(content));writeFileSync(target+'/deployment.json',JSON.stringify({demoOnly:true}));console.log('演示构建完成：'+target);
