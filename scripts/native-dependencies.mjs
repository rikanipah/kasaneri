import {cpSync,mkdirSync,existsSync,readFileSync,rmSync} from 'node:fs';
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
 // FSRS 参数优化组件（napi-rs）。连同它的三个平台包
 // （binding-win32-x64-msvc / binding-wasm32-wasi / binding-wasm32-wasip1）一起复制，
 // 运行时在 Electron 45（Node 24）里按平台自动选择原生产物。
 copy('@open-spaced-repetition/binding',resolve('package.json'),false,true);
 // 内嵌终端 PTY（预编译多平台包，含 electron/node 各 ABI 的 prebuilds）。
 copy('@homebridge/node-pty-prebuilt-multiarch',resolve('package.json'),false,true);
 return [...done];
}

/**
 * 交叉打包会把另一平台的原生产物也带进来（Windows 上装的是 win32 变体，
 * 交叉打 Linux 包时又下载了 linux 变体）。发布包里只保留目标平台需要的部分，
 * 免得安装包体积变大、也避免混入另一平台的可执行文件。
 * 保留 WASI 兜底产物：napi-rs 在缺少对应平台包时会退到它。
 */
export function pruneForeignPlatforms(appDirectory,platform){
 const foreign=platform==='win32'
  ?['@img/sharp-linux-x64','@img/sharp-libvips-linux-x64','@open-spaced-repetition/binding-linux-x64-gnu']
  :['@img/sharp-win32-x64','@open-spaced-repetition/binding-win32-x64-msvc'];
 for(const name of foreign)rmSync(join(appDirectory,'node_modules',name),{recursive:true,force:true});
}
