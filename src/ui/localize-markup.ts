import { getLocale, t } from '../core/i18n';

export function localizeMarkup(root:ParentNode=document):void{
  document.documentElement.lang=getLocale();
  for(const element of root.querySelectorAll('[data-i18n]')){
    element.textContent=t(element.textContent??'');
  }
  for(const element of root.querySelectorAll('[data-i18n-attrs]')){
    const names=element.getAttribute('data-i18n-attrs')?.split(' ')??[];
    for(const name of names){
      const value=element.getAttribute(name);
      if(value!==null)element.setAttribute(name,t(value));
    }
  }
}
