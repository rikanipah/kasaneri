import { english } from './messages-en';

export const DEFAULT_LOCALE='zh-CN';
export type Locale=typeof DEFAULT_LOCALE|'en';

export function parseLocale(value:unknown):Locale|undefined{
  return value===DEFAULT_LOCALE||value==='en'?value:undefined;
}

// Imported UI modules also define labels outside their render functions.
let locale=parseLocale(typeof location==='undefined'?undefined:new URLSearchParams(location.search).get('locale'))??DEFAULT_LOCALE;

export function getLocale():Locale{return locale;}
export function setLocale(value:Locale):void{locale=value;}

/** The Simplified Chinese source message is also the fallback. Values are plain text. */
export function t(message:string,...values:unknown[]):string{
  const pattern=locale==='en'?Object.hasOwn(english,message)?english[message]!:message:message;
  return values.length?pattern.replace(/\{(\d+)\}/gu,(token,index:string)=>{
    const position=Number(index);
    return position<values.length?String(values[position]):token;
  }):pattern;
}
