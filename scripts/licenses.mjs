import {mkdirSync,cpSync,readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';

export function copyLicenses(destination){
 mkdirSync(destination,{recursive:true});
 const packages=readdirSync('node_modules',{withFileTypes:true}).filter(entry=>entry.isDirectory()&&!entry.name.startsWith('.')).flatMap(entry=>
  entry.name.startsWith('@')?readdirSync(join('node_modules',entry.name),{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>join('node_modules',entry.name,e.name)):[join('node_modules',entry.name)]);
 const components=[];
 for(const directory of packages){
  if(!existsSync(join(directory,'package.json')))continue;
  const manifest=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));
  const files=readdirSync(directory).filter(name=>/^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
  const target=join(destination,manifest.name.replaceAll('/','__'));mkdirSync(target,{recursive:true});
  for(const file of files)cpSync(join(directory,file),join(target,file),{recursive:true});
  components.push({name:manifest.name,version:manifest.version,license:manifest.license||'See component license'});
 }
 const foliole=join(destination,'foliole');mkdirSync(foliole,{recursive:true});
 for(const file of ['LICENSE','NOTICE'])cpSync(join('src/vendor/foliole',file),join(foliole,file));
 components.push({name:'foliole-queue-components',version:'3a8bc69d54921faf8f0ad6e915dcfa091ace47a7',license:'Apache-2.0',source:'https://github.com/campfirium/foliole'});
 const lucide=join(destination,'lucide');mkdirSync(lucide,{recursive:true});
 for(const file of ['LICENSE','NOTICE'])cpSync(join('src/vendor/lucide',file),join(lucide,file));
 components.push({name:'lucide-icons',license:'ISC / MIT',source:'https://github.com/lucide-icons/lucide'});
 writeFileSync(join(destination,'components.json'),JSON.stringify(components,null,2));
}
