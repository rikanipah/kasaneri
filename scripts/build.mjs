import { build } from 'esbuild';
import { createRequire, builtinModules } from 'node:module';
import { statSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';

mkdirSync('dist', {recursive:true});
const builtins=new Set([...builtinModules,...builtinModules.map(name=>'node:'+name)]);
function resolveLocal(specifier,importer){
 const candidate=resolve(dirname(importer),specifier);
 for(const path of [candidate,candidate.replace(/\.js$/,'.ts'),candidate+'.ts',candidate+'.js',join(candidate,'index.ts'),join(candidate,'index.js')]){
  if(statSync(path,{throwIfNoEntry:false})?.isFile())return path;
 }
 throw Error('Cannot resolve '+specifier+' from '+importer);
}
export async function bundle(entry,output,platform){
 const input=resolve(entry);
 const result=await build({
  stdin:{contents:readFileSync(input,'utf8'),sourcefile:input,loader:'ts'},
  platform,format:platform==='browser'?'iife':'cjs',bundle:true,write:false,
  target:platform==='browser'?'chrome130':'node22',legalComments:'eof',
  plugins:[{name:'host-file-access',setup(builder){
   builder.onResolve({filter:/.*/},args=>{
    // node:sqlite 是 Node 22.5+ 新内置模块，旧版 esbuild 的内置清单里没有，必须显式声明为 external，
    // 否则在 Node 20 的 CI 上会报 Cannot find module 'node:sqlite'。
    if(builtins.has(args.path)||args.path==='electron'||args.path==='sharp'||args.path==='node:sqlite')return {path:args.path,external:true};
    const parent=args.importer||input;
    const path=args.path.startsWith('.')?resolveLocal(args.path,parent):createRequire(parent).resolve(args.path);
    return {path,namespace:'host'};
   });
   builder.onLoad({filter:/.*/,namespace:'host'},args=>({
    contents:readFileSync(args.path,'utf8'),loader:extname(args.path)==='.json'?'json':extname(args.path)==='.ts'?'ts':'js'
   }));
  }}]
 });
 writeFileSync(output,result.outputFiles[0].contents);
}
await bundle('src/data/worker.ts','dist/worker.cjs','node');
await bundle('src/app/main.ts','dist/main.cjs','node');
await bundle('src/app/preload.ts','dist/preload.cjs','node');
await bundle('src/app/onboarding-preload.ts','dist/onboarding-preload.cjs','node');
await bundle('src/ui/app.ts','dist/renderer.js','browser');
cpSync('src/ui/index.html','dist/index.html');
cpSync('src/ui/onboarding.html','dist/onboarding.html');
cpSync('src/ui/styles.css','dist/styles.css');
  // 1.22：正文字体（Inter）随包分发
  cpSync('src/ui/fonts','dist/fonts',{recursive:true});
mkdirSync('dist/katex',{recursive:true});
cpSync('node_modules/katex/dist/katex.min.css','dist/katex/katex.min.css');
cpSync('node_modules/katex/dist/fonts','dist/katex/fonts',{recursive:true});
// 1.6 ⑧：xterm 的样式单独复制（JS 会打进 renderer.js，CSS 由 index.html 引用）。
mkdirSync('dist/xterm',{recursive:true});
cpSync('node_modules/@xterm/xterm/css/xterm.css','dist/xterm/xterm.css');
console.log('Built desktop main, database worker, preload and editor.');
