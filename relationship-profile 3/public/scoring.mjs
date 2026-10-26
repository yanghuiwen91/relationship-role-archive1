export function calculate(answers,content){
 const {questions,scoring,roles}=content;
 if(!Array.isArray(answers)||answers.length!==24||answers.some(a=>!Number.isInteger(a)||a<0||a>3))throw Error('请完成全部24道题');
 const max=Array(8).fill(0),min=Array(8).fill(0),raw=Array(8).fill(0);
 questions.forEach((q,i)=>{for(let d=0;d<8;d++){max[d]+=Math.max(...q.options.map(o=>o.weights[d]||0));min[d]+=Math.min(...q.options.map(o=>o.weights[d]||0));raw[d]+=q.options[answers[i]].weights[d]||0;}});
 const scores=raw.map((r,d)=>(r-min[d])/(max[d]-min[d])*100);
 const ranking=scoring.prototypes.map((p,id)=>({id,distance:Math.sqrt(p.reduce((s,v,d)=>s+(v-scores[d])**2,0)/8)})).sort((a,b)=>a.distance-b.distance||scores[b.id]-scores[a.id]||a.id-b.id);
 const primary=roles[ranking[0].id],secondary=roles[ranking[1].id];
 const evidence=questions.map((q,i)=>({id:q.id,category:q.category,question:q.text,answer:q.options[answers[i]].text,strength:(q.options[answers[i]].weights[primary.id]||0)*2+(q.options[answers[i]].weights[secondary.id]||0)})).sort((a,b)=>b.strength-a.strength||a.id-b.id).slice(0,3);
 const behavior=['日常陪伴','对方低落','分歧修复'].map(category=>{const list=questions.map((q,i)=>({...q,index:i})).filter(q=>q.category===category);const q=list.sort((a,b)=>(b.options[answers[b.index]].weights[primary.id]||0)-(a.options[answers[a.index]].weights[primary.id]||0)||a.id-b.id)[0];return{category,question:q.text,answer:q.options[answers[q.index]].text};});
 const pairs=content.report.combinations;
 const key=[primary.id,secondary.id].sort((a,b)=>a-b).join('-');
 const combination=pairs[key]||`你常先通过“${primary.giving}”靠近，也会用“${secondary.giving}”补充支持。前者让你在意“${primary.need}”，后者让“${secondary.need}”也变得重要。如果两种需要暂时冲突，可以分别说出，再商量这一次先照顾哪一种；尤其留意：${primary.cost}，同时${secondary.cost}。`;
 return{version:scoring.version,primary:primary.id,secondary:secondary.id,scores:scores.map(n=>Math.round(n*10)/10),close:ranking[1].distance-ranking[0].distance<=scoring.closeDistance,evidence,behavior,combination};
}
