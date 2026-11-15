import { t } from '../core/i18n';
import type {ImageBox} from '../core/image-occlusion';

type Point={x:number;y:number};
type Gesture={
  pointerId:number;
  start:Point;
  previous:ImageBox[];
  id:string;
  original?:ImageBox;
  resize:boolean;
};

const clamp=(value:number,max=1)=>Math.max(0,Math.min(max,value));
const round=(value:number)=>Math.round(value*100000)/100000;

export function positionBox(element:HTMLElement,box:ImageBox):void {
  Object.assign(element.style,{left:box.x*100+'%',top:box.y*100+'%',width:box.width*100+'%',height:box.height*100+'%'});
}

export function editImageOcclusion(url:string,filename:string,initial:ImageBox[]):Promise<ImageBox[]|null> {
  const dialog=document.querySelector<HTMLDialogElement>('#image-occlusion')!;
  const canvas=dialog.querySelector<HTMLElement>('.occlusion-canvas')!;
  const image=canvas.querySelector('img')!;
  const overlay=dialog.querySelector<HTMLElement>('.occlusion-regions')!;
  const list=dialog.querySelector<HTMLElement>('.occlusion-list')!;
  const save=dialog.querySelector<HTMLButtonElement>('[value="save"]')!;
  const remove=dialog.querySelector<HTMLButtonElement>('.occlusion-remove')!;
  const undo=dialog.querySelector<HTMLButtonElement>('.occlusion-undo')!;
  const listener=new AbortController();
  const {signal}=listener;
  let boxes=initial,selected:string|null=null,gesture:Gesture|null=null;
  const history:ImageBox[][]=[];

  const draw=()=>{
    overlay.replaceChildren(...boxes.map(box=>{
      const element=document.createElement('span');
      element.className='occlusion-region'+(selected===box.id?' is-selected':'');
      element.dataset.box=box.id;
      positionBox(element,box);
      if(selected===box.id){
        const handle=document.createElement('span');handle.className='occlusion-resize';element.append(handle);
      }
      return element;
    }));
  };
  const update=()=>{
    draw();
    list.replaceChildren(...boxes.map((box,index)=>{
      const button=document.createElement('button');
      button.type='button';button.textContent=t('区域 {0}',(index+1));
      button.setAttribute('aria-pressed',String(selected===box.id));
      button.onclick=()=>{selected=box.id;update();(list.children[index] as HTMLElement)?.focus();};
      return button;
    }));
    remove.disabled=!selected;
    undo.disabled=!history.length;
    save.disabled=!image.naturalWidth||(!boxes.length&&!initial.length);
    save.textContent=initial.length?t('保存遮挡'):t('生成检测卡');
  };
  const point=(event:PointerEvent):Point=>{
    const bounds=image.getBoundingClientRect();
    return {x:clamp((event.clientX-bounds.left)/bounds.width),y:clamp((event.clientY-bounds.top)/bounds.height)};
  };
  canvas.addEventListener('pointerdown',event=>{
    if(event.button!==0||gesture||!image.naturalWidth)return;
    event.preventDefault();
    const hit=event.shiftKey?null:(event.target as Element).closest<HTMLElement>('[data-box]');
    const original=boxes.find(box=>box.id===hit?.dataset.box);
    const id=original?.id??crypto.randomUUID();
    gesture={pointerId:event.pointerId,start:point(event),previous:boxes,id,original,
      resize:!!(event.target as Element).closest('.occlusion-resize')};
    selected=original?.id??null;
    canvas.setPointerCapture(event.pointerId);
    update();
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(!gesture||event.pointerId!==gesture.pointerId)return;
    const {id,original,start,resize,previous}=gesture,end=point(event);
    const dx=end.x-start.x,dy=end.y-start.y;
    if(original&&boxes===previous&&Math.abs(dx)*image.clientWidth<2&&Math.abs(dy)*image.clientHeight<2)return;
    let x=Math.min(start.x,end.x),y=Math.min(start.y,end.y),width=Math.abs(dx),height=Math.abs(dy);
    if(original){
      x=resize?original.x:clamp(original.x+dx,1-original.width);
      y=resize?original.y:clamp(original.y+dy,1-original.height);
      width=resize?Math.max(Math.min(0.01,1-x),clamp(original.width+dx,1-x)):original.width;
      height=resize?Math.max(Math.min(0.01,1-y),clamp(original.height+dy,1-y)):original.height;
    }else if(width*image.clientWidth<5||height*image.clientHeight<5){
      boxes=previous;selected=null;draw();return;
    }
    const box:ImageBox={id,x:round(x),y:round(y),width:round(round(x+width)-round(x)),height:round(round(y+height)-round(y))};
    boxes=original?previous.map(item=>item.id===id?box:item):[...previous,box];
    selected=id;draw();
  },{signal});
  const finish=(event:PointerEvent)=>{
    if(!gesture||event.pointerId!==gesture.pointerId)return;
    if(event.type!=='pointerup')boxes=gesture.previous;
    else if(boxes!==gesture.previous)history.push(gesture.previous);
    if(!boxes.some(box=>box.id===selected))selected=null;
    gesture=null;update();
  };
  canvas.addEventListener('pointerup',finish,{signal});
  canvas.addEventListener('pointercancel',finish,{signal});
  canvas.addEventListener('lostpointercapture',finish,{signal});
  remove.addEventListener('click',()=>{
    if(!selected||gesture)return;
    history.push(boxes);
    boxes=boxes.filter(box=>box.id!==selected);selected=null;update();
    undo.focus();
  },{signal});
  undo.addEventListener('click',()=>{
    if(gesture||!history.length)return;
    boxes=history.pop()!;
    if(!boxes.some(box=>box.id===selected))selected=null;
    update();
  },{signal});
  document.addEventListener('keydown',event=>{
    if(!dialog.open)return;
    if(event.key==='Delete'&&selected){event.preventDefault();remove.click();}
    if(event.key.toLowerCase()==='z'&&(event.ctrlKey||event.metaKey)){event.preventDefault();undo.click();}
  },{signal});
  image.addEventListener('load',update,{signal});
  image.addEventListener('error',update,{signal});
  image.alt=filename;image.src=url;
  update();
  dialog.returnValue='';
  dialog.showModal();
  return new Promise(resolve=>dialog.addEventListener('close',()=>{
    listener.abort();
    image.removeAttribute('src');
    resolve(dialog.returnValue==='save'?boxes:null);
  },{once:true}));
}
