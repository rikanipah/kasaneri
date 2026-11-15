import {cpSync,mkdirSync,existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
export function copyNativeDependencies(appDirectory){
 const done=new Set();
 // lenient：该子树里缺失的依赖（如 WASI 运行时 @emnapi/*）不阻断打包——
 // Windows 下实际加载的是 win32-x64-msvc 原生产物，WASI 分支只是 napi-rs loader 的兜底。
 const copy=(name,parent,optional=false,lenient=false)=>{
  if(done.has(name))return;
  const paths=createRequire(parent).resolve.paths(name)||[];
  const root=paths.map(path=>join(path,name)).find(path=>existsSync(join(path,'package.json')));
  if(!root){if(optional||lenient)return;throw Error('缺少依赖 '+name);}
  done.add(name);
  const target=join(appDirectory,'node_modules',name);mkdirSync(target,{recursive:true});
  cpSync(root,target,{recursive:true});
  const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  for(const dependency of Object.keys(manifest.dependencies||{}))copy(dependency,join(root,'package.json'),false,lenient);
  for(const dependency of Object.keys(manifest.optionalDependencies||{}))copy(dependency,join(root,'package.json'),true,true);
 };
 copy('sharp',resolve('package.json'));
 // 1.6 ⑥：FSRS 参数优化组件（napi-rs）。连同它的三个平台包
 // （binding-win32-x64-msvc / binding-wasm32-wasi / binding-wasm32-wasip1）一起复制，
 // 运行时在 Electron 45（Node 24）里按平台自动选择原生产物。
 copy('@open-spaced-repetition/binding',resolve('package.json'),false,true);
 // 1.6 ⑧：内嵌终端 PTY（预编译多平台包，含 electron/node 各 ABI 的 prebuilds）。
 copy('@homebridge/node-pty-prebuilt-multiarch',resolve('package.json'),false,true);
 return [...done];
}
