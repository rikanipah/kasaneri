import { t } from '../core/i18n';
import {dialog} from 'electron';
import {appendFileSync,existsSync,mkdirSync,renameSync,rmSync,statSync} from 'node:fs';
import {dirname,join} from 'node:path';

export function installApplicationLogging(stateDir:string){
  const log=join(stateDir,'app.log');
  let reportedCrash=false;

  function writeLog(scope:string,detail:unknown):void{
    try{
      mkdirSync(stateDir,{recursive:true});
      const text=detail instanceof Error?(detail.stack||detail.message):String(detail);
      appendFileSync(log,`[${new Date().toISOString()}] ${scope}: ${text}\n`,'utf8');
      if(statSync(log).size>2*1024*1024){
        try{rmSync(log+'.1',{force:true});}catch{}
        renameSync(log,log+'.1');
      }
    }catch{/* An unavailable log should not interrupt the application. */}
  }

  process.on('uncaughtException',error=>{
    writeLog('uncaughtException',error);
    if(reportedCrash)return;
    reportedCrash=true;
    try{
      const message=error instanceof Error?error.message:String(error);
      dialog.showErrorBox(t('Kasaneri 遇到问题'),
        t('程序内部出现异常，已写入日志：\n{0}\n\n{1}\n\n可以继续使用；如果反复出现，请把日志发给我。',log,message));
    }catch{}
  });
  process.on('unhandledRejection',reason=>writeLog('unhandledRejection',reason));

  try{
    const chromiumLog=join(dirname(process.execPath),'debug.log');
    if(existsSync(chromiumLog)&&statSync(chromiumLog).size>8*1024*1024)rmSync(chromiumLog,{force:true});
  }catch{/* Chromium may still own the file. */}
  return writeLog;
}
