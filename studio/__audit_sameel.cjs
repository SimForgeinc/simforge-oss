
const fs=require("fs"),path=require("path"),babel=require("@babel/core");
const traverse=babel.traverse;
const files=JSON.parse(fs.readFileSync("/tmp/audit-callsites-files.json","utf8"));
const out=[];
function parse(f,src){return babel.parseSync(src,{filename:f,babelrc:false,configFile:false,browserslistConfigFile:false,sourceType:"module",parserOpts:{plugins:["typescript","jsx"],errorRecovery:true}})}
function collect(n,toks){ if(!n)return;
 if(n.type==="StringLiteral"){for(const t of n.value.split(/\s+/))if(t)toks.push(t);return}
 if(n.type==="TemplateLiteral"){for(const q of n.quasis)for(const t of q.value.cooked.split(/\s+/))if(t)toks.push(t);for(const e of n.expressions)collect(e,toks);return}
 if(n.type==="ConditionalExpression"){collect(n.consequent,toks);collect(n.alternate,toks);return}
 if(n.type==="LogicalExpression"){collect(n.left,toks);collect(n.right,toks);return}
 if(n.type==="CallExpression"){for(const a of n.arguments)collect(a,toks);return}
 if(n.type==="JSXExpressionContainer"){collect(n.expression,toks);return}
 if(n.type==="ArrayExpression"){for(const e of n.elements)collect(e,toks);return}
}
// find stylex style-key names used in stylex.props(...) on the same element
function styleKeys(n,keys){ if(!n)return;
 if(n.type==="MemberExpression"&&n.property&&n.property.name)keys.push((n.object.name||"")+"."+n.property.name);
 if(n.type==="CallExpression"){for(const a of n.arguments)styleKeys(a,keys)}
 if(n.type==="ConditionalExpression"){styleKeys(n.consequent,keys);styleKeys(n.alternate,keys)}
 if(n.type==="LogicalExpression"){styleKeys(n.left,keys);styleKeys(n.right,keys)}
 if(n.type==="ArrayExpression"){for(const e of n.elements)styleKeys(e,keys)}
}
for(const f of files){
 let src;try{src=fs.readFileSync(f,"utf8")}catch{continue}
 if(!/stylex\.props/.test(src))continue;
 let ast;try{ast=parse(f,src)}catch{continue}
 traverse(ast,{JSXOpeningElement(p){
   let cls=null,sx=null;
   for(const a of p.node.attributes){
     if(a.type==="JSXAttribute"&&a.name&&a.name.name==="className")cls=a;
     if(a.type==="JSXSpreadAttribute"){
       const e=a.argument;
       if(e&&e.type==="CallExpression"&&e.callee.type==="MemberExpression"&&e.callee.object.name==="stylex"&&e.callee.property.name==="props")sx=e;
       if(e&&e.type==="CallExpression"&&e.callee.type==="Identifier"&&e.callee.name==="mergeStyleProps")sx=e;
     }
   }
   if(!cls||!sx)return;
   const toks=[];collect(cls.value,toks);
   const keys=[];styleKeys(sx,keys);
   if(toks.length)out.push({file:f,line:p.node.loc.start.line,toks,keys});
 }});
}
fs.writeFileSync("/tmp/audit-sameel.json",JSON.stringify(out));
console.log("elements with BOTH stylex.props and className:",out.length);
