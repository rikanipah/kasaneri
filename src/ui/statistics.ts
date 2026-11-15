import { t, getLocale } from '../core/i18n';
import type {PrerequisiteChange,PrerequisiteState} from '../core/model';
import {tagLabel} from '../core/tags';
import {prerequisiteSection} from './prerequisites';

const el=(tag:string,text='',className='')=>{const node=document.createElement(tag);node.textContent=text;node.className=className;return node;};
const date=(value:any)=>value?new Date(value).toLocaleString(getLocale()):'—';
const number=(value:any)=>typeof value==='number'&&Number.isFinite(value)?Number(value.toFixed(3)).toString():'—';
export class StatisticsDialog {
 private dialog=document.createElement('dialog');private sequence=0;
 private content=document.createElement('div');private footer=document.createElement('div');
 constructor(private request:(action:string,payload?:any)=>Promise<any>,private prerequisiteChanged:(change:PrerequisiteChange)=>void){
  this.dialog.id='statistics';
  this.content.className='statistics-body';
  this.footer.className='dialog-actions';
  // 1.36：底部固定「关闭」（Anki 统计窗口的布局），不用再跑到右上角找 ×
  const close=el('button',t('关闭'));close.onclick=()=>{this.sequence++;this.dialog.close();};
  this.footer.append(close);
  this.dialog.append(this.content,this.footer);document.body.append(this.dialog);
 }
 private begin(title:string){this.content.replaceChildren();const header=el('div','','statistics-heading'),heading=el('h3',title);header.append(heading);this.content.append(header);if(!this.dialog.open)this.dialog.showModal();}
 /** 1.206：统计大类——顶部左侧切复习统计/待办统计。 */
 private tabs(folderId:string|undefined,days:number,active:'review'|'reading'){
  const bar=el('div','','statistics-tabs');
  for(const [key,label] of [['review',t('复习统计')],['reading',t('待办统计')]] as const){
   const button=el('button',label) as HTMLButtonElement;button.type='button';button.className=key===active?'is-active':'';
   button.onclick=()=>{if(key===active)return;if(key==='review')void this.openOverview(folderId,days);else void this.openReading(folderId,days);};
   bar.append(button);
  }
  this.content.append(bar);
 }
 private metric(host:HTMLElement,label:string,value:any){const item=el('div','','statistics-metric');item.append(el('small',label),el('strong',String(value??'—')));host.append(item);}
 /**
  * 1.33：重写图表，参考 Anki 统计的读图方式：
  *  · 左侧留足刻度区（不再让柱子和数字互相遮挡）；
  *  · y 轴用"整数友好"刻度（1/2/5×10^n），最多 5 格；
  *  · 每根柱子有更深的描边与悬停高亮，颜色按系列区分；
  *  · 悬停显示跟随鼠标的提示框（日期/类别 + 数值），同一时刻只有一个提示框。
  */
 private chart(title:string,points:Array<{x:number;y:number;label:string}>,mode:'line'|'bars',maxY?:number,threshold?:number,color='var(--text-accent)'){
  const section=el('section','','statistics-chart');section.append(el('h4',title));
  if(!points.length){const empty=el('p',t('暂无数据'),'preference-hint');section.append(empty);return section;}
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
  const width=800,height=240,left=58,right=780,top=12,bottom=206;
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('role','img');svg.setAttribute('aria-label',title);
  const shape=(tag:string,attrs:Record<string,string|number>,text?:string)=>{const node=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))node.setAttribute(k,String(v));if(text)node.textContent=text;svg.append(node);return node;};
  const rawMax=maxY||Math.max(1,...points.map(p=>p.y));
  // 整数友好刻度：把最大值向上取整到 1/2/5×10^n
  const magnitude=Math.pow(10,Math.floor(Math.log10(Math.max(1,rawMax)))),normalized=rawMax/magnitude;
  const step=(normalized<=1?1:normalized<=2?2:normalized<=5?5:10)*magnitude;
  const max=Math.max(step,Math.ceil(rawMax/step)*step);
  const xMax=Math.max(1,...points.map(p=>p.x)),band=(right-left)/Math.max(1,points.length);
  const x=(index:number)=>left+band*(index+0.5),y=(v:number)=>bottom-(v/max)*(bottom-top);
  for(let i=0;i<=4;i++){
    const value=max*i/4;shape('line',{x1:left,x2:right,y1:y(value),y2:y(value),stroke:'var(--border)','stroke-width':1});
    shape('text',{x:left-8,y:y(value)+4,'text-anchor':'end',fill:'var(--text-muted)','font-size':11},number(value));
  }
  if(threshold!==undefined)shape('line',{x1:left,x2:right,y1:y(threshold),y2:y(threshold),stroke:'#d5b56b','stroke-dasharray':'5 4'});
  if(mode==='line')shape('path',{d:points.map((point,index)=>(index?'L':'M')+x(index)+','+y(point.y)).join(' '),stroke:color,'stroke-width':2,fill:'none'});
  const barWidth=Math.max(2,Math.min(26,band*0.62));
  points.forEach((point,index)=>{
    const element=mode==='bars'
      ?shape('rect',{x:x(index)-barWidth/2,y:y(point.y),width:barWidth,height:Math.max(0,bottom-y(point.y)),rx:2,fill:color,'fill-opacity':0.7})
      :shape('circle',{cx:x(index),cy:y(point.y),r:3.2,fill:color});
    element.setAttribute('data-index',String(index));
    element.setAttribute('class','statistics-point');
    element.addEventListener('mouseenter',()=>{element.setAttribute('fill-opacity','0.92');});
    element.addEventListener('mouseleave',()=>{if(mode==='bars')element.setAttribute('fill-opacity','0.7');});
  });
  // 悬停提示：一片透明覆盖层负责命中，避免细柱子难点中
  const overlay=shape('rect',{x:left,y:top,width:right-left,height:bottom-top,fill:'transparent'});
  const tooltip=el('div','','statistics-tooltip');tooltip.hidden=true;section.append(tooltip);
  overlay.addEventListener('mousemove',event=>{
    const rect=svg.getBoundingClientRect(),scale=width/rect.width;
    const svgX=(event.clientX-rect.left)*scale;
    const index=Math.max(0,Math.min(points.length-1,Math.floor((svgX-left)/band)));
    const point=points[index]!;
    tooltip.hidden=false;tooltip.textContent=point.label+'：'+number(point.y);
    const localX=event.clientX-section.getBoundingClientRect().left,localY=event.clientY-section.getBoundingClientRect().top;
    tooltip.style.left=Math.min(Math.max(8,localX+12),section.clientWidth-140)+'px';
    tooltip.style.top=Math.max(8,localY-34)+'px';
  });
  overlay.addEventListener('mouseleave',()=>{tooltip.hidden=true;});
  if(points.length){
    shape('text',{x:left,y:228,fill:'var(--text-muted)','font-size':11},points[0]!.label);
    if(points.length>1)shape('text',{x:right,y:228,'text-anchor':'end',fill:'var(--text-muted)','font-size':11},points.at(-1)!.label);
  }
  section.append(svg);void xMax;return section;
 }
 /** 1.35：仿 Anki「预测」图——绿色柱（当日到期）+ 灰色累计面积 + 右轴累计刻度，悬停显示"N 天内 / 累计"。 */
 private cumulativeChart(title:string,points:Array<{x:number;y:number;label:string}>){
  const section=el('section','','statistics-chart');section.append(el('h4',title));
  if(!points.length){section.append(el('p',t('暂无数据'),'preference-hint'));return section;}
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
  const width=800,height=260,left=58,right=736,top=14,bottom=214;
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('role','img');svg.setAttribute('aria-label',title);
  const shape=(tag:string,attrs:Record<string,string|number>,text?:string)=>{const node=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))node.setAttribute(k,String(v));if(text)node.textContent=text;svg.append(node);return node;};
  const cumulative:number[]=[];let running=0;
  for(const point of points){running+=point.y;cumulative.push(running);}
  const maxBar=Math.max(1,...points.map(point=>point.y)),maxCum=Math.max(1,running);
  const band=(right-left)/Math.max(1,points.length);
  const x=(index:number)=>left+band*(index+0.5),yBar=(value:number)=>bottom-(value/maxBar)*(bottom-top),yCum=(value:number)=>bottom-(value/maxCum)*(bottom-top);
  for(let i=0;i<=4;i++){
    const value=maxBar*i/4;shape('line',{x1:left,x2:right,y1:yBar(value),y2:yBar(value),stroke:'var(--border)'});
    shape('text',{x:left-8,y:yBar(value)+4,'text-anchor':'end',fill:'var(--text-muted)','font-size':11},String(Math.round(value)));
    const cum=maxCum*i/4;shape('text',{x:right+8,y:yCum(cum)+4,fill:'#8f8f8f','font-size':11},String(Math.round(cum)));
  }
  // 累计面积（灰）+ 累计折线
  // 1.37：趋势线改用灰蓝（与绿色柱子区分），面积同色更淡；刻度取整避免 1042.5 这类读数。
  const area='M'+x(0)+','+bottom+' '+points.map((_,index)=>'L'+x(index)+','+yCum(cumulative[index]!)).join(' ')+' L'+x(points.length-1)+','+bottom+' Z';
  // 1.39：阴影和折线都再提亮一档（用户反馈偏深），同时保留 Anki 的灰黑观感
  shape('path',{d:area,fill:'#e6e6e6','fill-opacity':0.07,stroke:'none'});
  shape('path',{d:points.map((_,index)=>(index?'L':'M')+x(index)+','+yCum(cumulative[index]!)).join(' '),stroke:'#f5f5f5','stroke-width':1.2,'stroke-opacity':0.95,fill:'none','stroke-linejoin':'round'});
  // 当日到期柱（Anki 绿）
  const barWidth=Math.max(2,Math.min(22,band*0.62));
  const barElements:SVGRectElement[]=[];
  points.forEach((point,index)=>{
    const bar=shape('rect',{x:x(index)-barWidth/2,y:yBar(point.y),width:barWidth,height:Math.max(0,bottom-yBar(point.y)),rx:1.5,fill:'#7bc47f','fill-opacity':0.62});
    barElements.push(bar as SVGRectElement);
  });
  // 1.38：悬停位置的淡灰竖条（明确指出当前读的是哪一天，Anki 也是这么标的）
  const marker=shape('rect',{x:left,y:top,width:band,height:bottom-top,fill:'#ffffff','fill-opacity':0.13,stroke:'none'}) as SVGRectElement;
  marker.setAttribute('visibility','hidden');
  const overlay=shape('rect',{x:left,y:top,width:right-left,height:bottom-top,fill:'transparent'});
  const tooltip=el('div','','statistics-tooltip');tooltip.hidden=true;section.append(tooltip);
  overlay.addEventListener('mousemove',event=>{
    const rect=svg.getBoundingClientRect(),scale=width/rect.width,svgX=(event.clientX-rect.left)*scale;
    const index=Math.max(0,Math.min(points.length-1,Math.floor((svgX-left)/band)));
    // 竖条对齐到当前这一格，并把当前柱提亮
    marker.setAttribute('x',String(left+band*index));
    marker.setAttribute('width',String(band));
    marker.setAttribute('visibility','visible');
    barElements.forEach((bar,position)=>bar.setAttribute('fill-opacity',position===index?'0.95':'0.62'));
    tooltip.hidden=false;tooltip.replaceChildren();
    tooltip.append(el('div',t('{0} 天内：{1} 张卡片到期',(index+1),number(points[index]!.y))),el('div',t('累计：{0}',number(cumulative[index]!))));
    const sectionRect=section.getBoundingClientRect();
    tooltip.style.left=Math.min(Math.max(8,event.clientX-sectionRect.left+12),Math.max(8,section.clientWidth-150))+'px';
    tooltip.style.top=Math.max(8,event.clientY-sectionRect.top-46)+'px';
  });
  overlay.addEventListener('mouseleave',()=>{
    tooltip.hidden=true;marker.setAttribute('visibility','hidden');
    barElements.forEach(bar=>bar.setAttribute('fill-opacity','0.62'));
  });
  shape('text',{x:left,y:238,fill:'var(--text-muted)','font-size':11},t('今天'));
  shape('text',{x:right,y:238,'text-anchor':'end',fill:'var(--text-muted)','font-size':11},points.at(-1)!.label);
  section.append(svg);
  // 1.37：图例说明——绿柱=当天到期，灰蓝折线+阴影=累计到期（右轴）
  section.append(el('p',t('说明：绿色柱＝当天到期需要复习的张数（左轴）；灰色折线与其阴影＝从今天起逐日累计的到期总量（右轴）；勾选「积压」时今天的柱子包含已逾期未复习的卡片。'),'preference-hint'));
  return section;
 }
 async openCard(id:string,horizon=180,offset=0){
  const sequence=++this.sequence,data=await this.request('cardInfo',{id,horizon,offset});if(sequence!==this.sequence)return;
  this.begin(t('卡片信息 · {0}',data.title));this.content.append(el('p',data.path,'preference-hint'));
  if(data.prerequisites)this.content.append(prerequisiteSection(id,data.prerequisites,{
    search:query=>this.request('searchPrerequisites',{id,query}),
    change:async input=>{
      const result:PrerequisiteState=await this.request('setPrerequisite',input);
      this.prerequisiteChanged(input);
      return result;
    },
  }));
  const metrics=el('div','','statistics-metrics'),state=data.state;
  const seconds=(value:any)=>value===null||value===undefined?'—':(Number(value)>=3600?t('{0} 小时',number(Number(value)/3600)):t('{0} 分',number(Number(value)/60)));
  // 1.14：字段对齐 Anki 卡片信息（复习次数/首次复习/最近复习/间隔/总用时/平均用时/难度…）
  for(const [label,value] of [
    [t('卡片编号'),data.id],[t('当前状态'),data.reviewEnabled?t('FSRS 复习'):data.pushEnabled?t('待办中'):t('已搁置')],
    [t('FSRS 模型'),data.settings.fsrsVersion],[t('已学次数'),state?.reps??0],[t('复习次数'),data.reviewCount??0],
    [t('遗忘次数'),state?.lapses??0],[t('稳定性（天）'),number(state?.stability)],
    [t('难度（1–10）'),number(state?.difficulty)],[t('当前可回忆率'),data.retrievability===null?'—':number(data.retrievability*100)+'%'],
    [t('目标记忆率'),number(data.settings.desiredRetention*100)+'%'],
    [t('当前间隔（天）'),data.intervalDays===null?'—':number(data.intervalDays)],
    [t('距今距上次复习（天）'),data.elapsedDays===null?'—':number(data.elapsedDays)],
    [t('下次复习'),date(data.dueAt)],[t('上次复习'),date(state?.lastReviewAt)],
    [t('首次复习'),date(data.firstReviewAt)],[t('最近复习'),date(data.latestReviewAt)],
    [t('总用时'),seconds(data.totalSeconds)],[t('平均用时'),seconds(data.averageSeconds)],
    [t('创建时间'),date(data.createdAt)],[t('修改时间'),date(data.updatedAt)],
    [t('标签'),data.tags.map((tag:string)=>tag==='leech'&&data.leechCount?tag+'('+data.leechCount+')':tagLabel(tag)).join('，')||t('无')]])this.metric(metrics,label as string,value);
  this.content.append(metrics);
  // ===== 1.107：对齐 Anki「卡片信息」——上方复习记录表，下方遗忘曲线 =====
  const typeLabel=(type:any)=>type===0?t('新卡'):type===1?t('学习'):type===2?t('复习'):type===3?t('重新学习'):'—';
  const typeClass=(type:any)=>type===3?'is-relearn':type===1?'is-learn':type===2?'is-review':'is-new';
  const difficultyPercent=(value:any)=>value===null||value===undefined?'—':number((Number(value)-1)/9*100)+'%';
  const intervalText=(days:any)=>{
    if(days===null||days===undefined)return '—';
    const value=Number(days);
    return value>=1?t('{0} 天',number(value)):t('{0} 分',number(value*24*60));
  };

  this.content.append(el('h4',t('复习记录')));
  const scroll=el('div','','statistics-history'),table=document.createElement('table'),head=document.createElement('thead'),tr=document.createElement('tr');
  for(const name of [t('日期'),t('类型'),t('评分'),t('间隔'),'D',t('用时'),t('状态')])tr.append(el('th',name));
  head.append(tr);table.append(head);const tbody=document.createElement('tbody');
  for(const row of data.history){
    const tr=document.createElement('tr');
    tr.append(el('td',date(row.at)));
    const typeCell=el('td',''),badge=document.createElement('span');
    // 1.210：排程事件（待办暂停 / 返回复习 / 搁置 / 留存判定）没有评分，类型列直接写事件名
    if(row.kind==='event'){badge.className='card-type is-event';badge.textContent=row.label||t('排程变更');}
    else{badge.className='card-type '+typeClass(row.type);badge.textContent=typeLabel(row.type);}
    typeCell.append(badge);tr.append(typeCell);
    tr.append(el('td',row.kind==='event'?'—':(['','1','2','3','4'][row.rating]||'—')));
    tr.append(el('td',intervalText(row.intervalDays)));
    tr.append(el('td',difficultyPercent(row.difficulty)));
    tr.append(el('td',row.seconds===null?'—':t('{0} 秒',number(row.seconds))));
    tr.append(el('td',row.undone?t('已撤销'):''));
    tbody.append(tr);
  }
  table.append(tbody);scroll.append(table);this.content.append(scroll);

  // 时间范围：首周 / 首月 / 首年（Anki 的三个单选项）
  let curveDays=30;
  const ranges=el('div','','chart-range');this.content.append(ranges);
  const chartHost=el('div','','');this.content.append(chartHost);
  this.content.append(el('p',t('按每次复习时的稳定性推算遗忘曲线；绿色=复习时仍高于目标记忆率，蓝色=已低于目标。'),'preference-hint'));

  const drawCurve=()=>{
    ranges.replaceChildren();
    for(const pair of [[t('首周'),7],[t('首月'),30],[t('首年'),365]] as const){
      const button=document.createElement('button');button.type='button';button.textContent=pair[0];
      button.className=curveDays===pair[1]?'is-active':'';button.onclick=()=>{curveDays=pair[1];drawCurve();};ranges.append(button);
    }
    chartHost.replaceChildren();
    const now=Date.now(),rangeStart=now-curveDays*86400000;
    const rows=[...data.history].filter((row:any)=>!row.undone).sort((a:any,b:any)=>a.at-b.at);
    const segments:Array<{points:Array<{x:number;y:number}>;good:boolean}>=[];
    for(let index=0;index<rows.length;index+=1){
      const row=rows[index] as any,stability=Number(row.stability||0);
      if(!stability)continue;
      const from=Number(row.at);
      const to=Number(rows[index+1]?rows[index+1].at:Math.min(now,from+Math.max(1,Number(row.intervalDays||1))*86400000));
      if(to<=rangeStart||from>=now)continue;
      const points:Array<{x:number;y:number}>=[];
      for(let step=0;step<=24;step+=1){
        const at=from+(to-from)*step/24,days=(at-from)/86400000;
        const probability=Math.pow(1+(19/81)*days/stability,-0.5);
        points.push({x:at,y:Math.max(0,Math.min(1,probability))*100});
      }
      const last=points[points.length-1]!;
      segments.push({points,good:last.y>=data.settings.desiredRetention*100});
    }
    if(!segments.length){chartHost.append(el('p',t('这张卡还没有可绘制的复习区间（需要至少一次带稳定性的复习）。'),'preference-hint'));return;}
    const W=900,H=300,PAD=46;
    const allY=segments.reduce((list:number[],segment)=>list.concat(segment.points.map((point:any)=>point.y)),[] as number[]);
    const minY=Math.min(75,Math.floor(Math.min.apply(null,allY)));
    const sx=(time:number)=>PAD+(time-rangeStart)/(now-rangeStart)*(W-PAD*1.2);
    const sy=(value:number)=>H-PAD-(value-minY)/(100-minY)*(H-PAD*1.8);
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox','0 0 '+W+' '+H);svg.setAttribute('class','forgetting-curve');svg.setAttribute('role','img');
    svg.setAttribute('aria-label',t('遗忘曲线'));
    const makePath=(color:string,width:number,dash?:string)=>{
      const element=document.createElementNS(ns,'path');
      element.setAttribute('fill','none');element.setAttribute('stroke',color);
      element.setAttribute('stroke-width',String(width));if(dash)element.setAttribute('stroke-dasharray',dash);
      return element;
    };
    const target=makePath('var(--text-faint)',1,'5 5');
    target.setAttribute('d','M'+PAD+','+sy(data.settings.desiredRetention*100)+' L'+(W-PAD*0.2)+','+sy(data.settings.desiredRetention*100));
    svg.append(target);
    for(const segment of segments){
      const line=makePath(segment.good?'#4f9f74':'#5b8ec9',1.8);
      line.setAttribute('d',segment.points.map((point,index)=>(index?'L':'M')+sx(point.x).toFixed(1)+','+sy(point.y).toFixed(1)).join(' '));
      svg.append(line);
    }
    for(const value of [80,85,90,95,100]){
      if(value<minY)continue;
      const text=document.createElementNS(ns,'text');
      text.setAttribute('x','4');text.setAttribute('y',String(sy(value)+4));
      text.setAttribute('fill','var(--text-faint)');text.setAttribute('font-size','11');text.textContent=String(value);
      svg.append(text);
    }
    chartHost.append(svg);
  };
  drawCurve();

  // 未来预测（保留原有能力）
  this.content.append(el('h4',t('未来预测')));
  const toolbar=el('div','','statistics-toolbar'),label=el('label',t('预测时间范围：')),select=document.createElement('select');
  for(const days of [30,90,180,365,1825,3650])select.append(new Option(t('{0} 天',days),String(days)));select.value=String(horizon);select.onchange=()=>void this.openCard(id,Number(select.value),0);label.append(select);toolbar.append(label);this.content.append(toolbar);
  this.content.append(this.chart(t('记忆曲线预测'),data.curve.map((p:any)=>({x:p.days,y:p.probability*100,label:t('{0} 天后',number(p.days))})),'line',100,data.settings.desiredRetention*100));
  this.content.append(el('p',data.curve.length?t('按当前牌组参数预测，假设期间不再复习；虚线为目标记忆率。'):t('尚无已学习的记忆状态，完成复习后显示预测。'),'preference-hint'));
  const pager=el('div','','statistics-toolbar'),previous=el('button',t('上一页')),next=el('button',t('下一页'));
  (previous as HTMLButtonElement).disabled=offset===0;(next as HTMLButtonElement).disabled=offset+100>=data.total;
  previous.onclick=()=>void this.openCard(id,horizon,Math.max(0,offset-100));next.onclick=()=>void this.openCard(id,horizon,offset+100);
  pager.append(el('span',t('共 {0} 条 · {1} 页',data.total,(Math.floor(offset/100)+1))),previous,next);
  this.content.append(pager);

 }
 async openOverview(folderId?:string,days=30){
  const sequence=++this.sequence,data=await this.request('statistics',{folderId,days});if(sequence!==this.sequence)return;this.begin(t('统计 · {0}',data.title));this.tabs(folderId,days,'review');
  const metrics=el('div','','statistics-metrics');for(const [key,label] of [['total',t('卡片总数')],['tests',t('检测卡')],['newCards',t('FSRS 新卡')],['learned',t('已学复习卡')],['pushing',t('待办中')],['suspended',t('暂停复习')],['leeches',t('难记卡片')]])this.metric(metrics,label,data.summary[key]);
  const answers=data.ratings.reduce((sum:number,row:any)=>sum+row.count,0),forgot=data.ratings.find((row:any)=>row.rating===1)?.count||0;this.metric(metrics,t('期间回答次数'),answers);this.metric(metrics,t('期间答对率'),answers?number((answers-forgot)/answers*100)+'%':'—');
  // 1.31：对齐 Anki 的"学习天数 / 平均每日"口径
  this.metric(metrics,t('学习天数'),(data.studiedDays??0)+' / '+days);
  this.metric(metrics,t('平均（含未学习天）'),t('{0} 次/天',number(answers/days)));
  this.metric(metrics,t('平均（只计学习天）'),data.studiedDays?t('{0} 次/天',number(answers/data.studiedDays)):'—');
  this.content.append(metrics);
  // ===== 1.35：每张图各自的日期区间（Anki 的预测图也是每图独立选 1 个月/3 个月/1 年/全部）=====
  const dayKey=(offset:number)=>{const time=new Date(Date.now()+offset*86400000);
    return [time.getFullYear(),String(time.getMonth()+1).padStart(2,'0'),String(time.getDate()).padStart(2,'0')].join('-');};
  const RANGES=[{label:t('1 个月'),span:30},{label:t('3 个月'),span:90},{label:t('1 年'),span:365},{label:t('全部'),span:3650}];
  /** 每个图表自带一行区间按钮（未选中为灰色，选中高亮）+ 图下方的合计说明。 */
  const rangeChart=(title:string,valueOf:(index:number)=>number,color:string,totalLabel:string)=>{
    const wrapper=el('div','','');
    const controls=el('div','','chart-range');
    const host=el('div','','');
    const draw=(span:number)=>{
      const rows=Array.from({length:span},(_,index)=>({x:index,y:valueOf(index),label:dayKey(index)}));
      const total=rows.reduce((sum,row)=>sum+row.y,0);
      host.replaceChildren();
      host.append(this.chart(t('{0}（{1} 天）',title,span),rows,'bars',undefined,undefined,color));
      host.append(el('p',t('{0}：{1} · 平均 {2} 次/天',totalLabel,total,number(total/span)),'preference-hint'));
    };
    for(const range of RANGES){
      const button=el('button',range.label) as HTMLButtonElement;button.className='range-button';
      button.onclick=()=>{for(const other of controls.querySelectorAll('button'))other.classList.remove('is-active');
        button.classList.add('is-active');draw(range.span);};
      if(range.span===30)button.classList.add('is-active');
      controls.append(button);
    }
    wrapper.append(controls,host);draw(30);
    return wrapper;
  };
  const forecast=(data.forecast||[]) as Array<{day:string;count:number}>;
  const added=(data.added||[]) as Array<{day:string;count:number}>;
  const daily=(data.daily||[]) as Array<{day:string;answers:number}>;
  const forecastValue=(index:number)=>Number(forecast.find(row=>row.day===dayKey(index))?.count||0);
  const answersValue=(index:number)=>Number(daily.find(row=>row.day===dayKey(index))?.answers||0);
  const addedValue=(index:number)=>Number(added.find(row=>row.day===dayKey(index))?.count||0);
  const totalForecast=forecast.reduce((sum,row)=>sum+Number(row.count||0),0);
  const tomorrow=forecastValue(1),dueToday=forecastValue(0);
  const forecastMetrics=el('div','','statistics-metrics');
  this.metric(forecastMetrics,t('总计到期'),t('{0} 次复习',totalForecast));
  this.metric(forecastMetrics,t('平均（全部）'),t('{0} 次/天',number(totalForecast/3650)));
  this.metric(forecastMetrics,t('今天（含逾期）'),dueToday);
  this.metric(forecastMetrics,t('明天到期'),tomorrow);
  this.metric(forecastMetrics,t('每日工作量'),dueToday+tomorrow);
  this.content.append(el('h4',t('到期预测')),forecastMetrics);
  // Anki 的预测图：绿色柱（到期数）+ 灰色累计面积（累计到期）+ 右轴累计刻度 + 悬停双读数。
  {
    const wrapper=el('div','',''),controls=el('div','','chart-range'),host=el('div','','');
    const backlogLabel=el('label','');const backlog=(el('input') as HTMLInputElement);backlog.type='checkbox';backlog.checked=true;
    const backlogText=el('span',t('积压'));backlogLabel.append(backlog,backlogText);
    const draw=(span:number)=>{
      const rows=Array.from({length:span},(_,index)=>({x:index,y:backlog.checked||index>0?forecastValue(index):0,label:dayKey(index)}));
      host.replaceChildren(this.cumulativeChart(t('将来到期的复习数目（{0} 天）',span),rows));
    };
    for(const range of RANGES){
      const button=el('button',range.label) as HTMLButtonElement;button.className='range-button';
      button.onclick=()=>{for(const other of controls.querySelectorAll('button'))other.classList.remove('is-active');
        button.classList.add('is-active');draw(range.span);};
      if(range.span===30)button.classList.add('is-active');
      controls.append(button);
    }
    backlog.onchange=()=>{const active=controls.querySelector('button.is-active') as HTMLButtonElement|null;
      draw(RANGES.find(range=>range.label===active?.textContent)?.span||30);};
    controls.append(backlogLabel);wrapper.append(host);this.content.append(controls,wrapper);draw(30);
  }
  this.content.append(rangeChart(t('每日回答次数'),answersValue,'#b496ef',t('本区间回答')));
  this.content.append(rangeChart(t('每日新增卡片'),addedValue,'#7fb2ff',t('本区间新增')));
  // 1.33：不同图表用不同颜色（颜色取自当前主题的可用色板，避免全部一个紫色）
  const palette=['#b496ef','#7fb2ff','#6fd3c7','#e0a86e','#ef8fb6','#9ad36f'];
  let colorIndex=0;
  const bars=(title:string,rows:Array<{label:string;count:number}>)=>this.content.append(this.chart(title,rows.map((row,index)=>({x:index,y:Number(row.count),label:row.label})),'bars',undefined,undefined,palette[colorIndex++%palette.length]));
  const buttons=data.buttons||{again:0,hard:0,good:0,easy:0};
  bars(t('回答按钮'),[{label:t('重来'),count:buttons.again},{label:t('困难'),count:buttons.hard},{label:t('良好'),count:buttons.good},{label:t('简单'),count:buttons.easy}]);
  bars(t('复习间隔分布'),data.intervalBuckets||[]);
  bars(t('记忆稳定期分布（天）'),data.stabilityBuckets||[]);
  bars(t('卡片难度分布（1–10）'),data.difficultyBuckets||[]);
  bars(t('逐小时回答次数'),data.hourly||[]);
  const ratings=el('p',data.ratings.map((r:any)=>['',t('重来'),t('困难'),t('良好'),t('简单')][r.rating]+' '+r.count).join(' · '),'preference-hint');this.content.append(ratings);
  this.content.append(el('p',t('分布类图表按当前卡片状态统计（不是历史快照）；Anki 的日历热力图/日程表依赖它的牌组日历概念，这里不做。'),'preference-hint'));
 }

 /** 1.206：轻量待办统计——只做日常能看懂的量，不做时间/热力图。 */
 async openReading(folderId?:string,days=30){
  const sequence=++this.sequence,data=await this.request('readingStatistics',{folderId,days});if(sequence!==this.sequence)return;
  this.begin(t('统计 · {0}',data.title));this.tabs(folderId,days,'reading');
  const metrics=el('div','','statistics-metrics'),summary=data.summary||{};
  for(const [key,label] of [['total',t('主题与提取')],['topics',t('主题')],['materials',t('提取')],['pushing',t('待办中')],['stopped',t('已停用待办')],['completed',t('已完成')],['dueToday',t('今天到期（含逾期）')]])this.metric(metrics,label,summary[key]);
  const actions=Number(data.actions?.reduce?.((sum:number,row:any)=>sum+Number(row.count||0),0)||0);
  this.metric(metrics,t('期间阅读动作'),actions);
  this.metric(metrics,t('读完 / 稍后 / 完成'),(data.read??0)+' / '+(data.later??0)+' / '+(data.done??0));
  this.metric(metrics,t('阅读天数'),(data.studiedDays??0)+' / '+days);
  this.metric(metrics,t('平均（只计阅读天）'),data.studiedDays?t('{0} 次/天',number(actions/data.studiedDays)):'—');
  this.content.append(metrics);
  const dayKey=(offset:number)=>{const time=new Date(Date.now()+offset*86400000);return [time.getFullYear(),String(time.getMonth()+1).padStart(2,'0'),String(time.getDate()).padStart(2,'0')].join('-');};
  const forecast=(data.forecast||[]) as Array<{day:string;count:number}>;
  const value=(offset:number)=>Number(forecast.find(row=>row.day===dayKey(offset))?.count||0);
  const total=(forecast||[]).reduce((sum:number,row:any)=>sum+Number(row.count||0),0);
  const forecastMetrics=el('div','','statistics-metrics');
  this.metric(forecastMetrics,t('未来到期待办'),total);
  this.metric(forecastMetrics,t('今天（含逾期）'),value(0));
  this.metric(forecastMetrics,t('明天到期'),value(1));
  this.content.append(el('h4',t('到期预测')),forecastMetrics);
  const rows=Array.from({length:30},(_,index)=>({x:index,y:value(index),label:dayKey(index)}));
  this.content.append(this.chart(t('将来要到期的待办（30 天）'),rows,'bars',undefined,undefined,'#6fd3c7'));
  const daily=(data.daily||[]) as Array<{day:string;actions:number;reads:number}>;
  const actionValue=(offset:number)=>Number(daily.find(row=>row.day===dayKey(offset))?.actions||0);
  const actionRows=Array.from({length:days},(_,index)=>({x:index,y:actionValue(index-(days-1)),label:dayKey(index-(days-1))}));
  this.content.append(this.chart(t('每日阅读动作（{0} 天）',days),actionRows,'bars',undefined,undefined,'#7fb2ff'));
  this.content.append(el('p',t('待办统计只统计主题/提取的阅读动作与到期数；检测卡属于复习统计。'),'preference-hint'));
 }
}