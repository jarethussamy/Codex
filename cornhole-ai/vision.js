const Vision = (() => {
  let video, overlay, octx, proc, pctx, running=false, auto=false;
  let cal={board:[],hole:null,holeEdge:null,colorA:null,colorB:null};
  let mode=null, lastT=0, fps=0, lastVideoTime=-1;
  let lastGray=null, lastTeamMap=null, stableMap=null, beforeMap=null;
  let active=false, quietFrames=0, activeFrames=0, cooldownFrames=0;
  let lastCentroid=null, lastTeam=null, onThrow=null, onMetrics=null;
  let votesA=0,votesB=0,minHolePx=Infinity,lastMotionProc=null,maxBagMotion=0;
  let sensitivity='high';

  function displayBox(){
    const r=overlay.getBoundingClientRect(), vw=Math.max(1,video?.videoWidth||1), vh=Math.max(1,video?.videoHeight||1);
    const scale=Math.min(r.width/vw,r.height/vh), w=vw*scale,h=vh*scale;
    return {r,scale,w,h,ox:(r.width-w)/2,oy:(r.height-h)/2,vw,vh};
  }
  function fitCanvas(){
    if(!video || !video.videoWidth) return;
    const r=overlay.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
    overlay.width=Math.max(1,Math.round(r.width*dpr)); overlay.height=Math.max(1,Math.round(r.height*dpr));
    overlay.style.width=r.width+'px'; overlay.style.height=r.height+'px';
    octx.setTransform(dpr,0,0,dpr,0,0);
  }
  function dispToVideo(x,y){
    const b=displayBox();
    return {x:Math.max(0,Math.min(b.vw,(x-b.ox)/b.scale)),y:Math.max(0,Math.min(b.vh,(y-b.oy)/b.scale))};
  }
  function videoToDisp(p){const b=displayBox();return {x:b.ox+p.x*b.scale,y:b.oy+p.y*b.scale}}
  function pointInPoly(p,poly){
    let c=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){
      if(((poly[i].y>p.y)!=(poly[j].y>p.y))&&(p.x<(poly[j].x-poly[i].x)*(p.y-poly[i].y)/(poly[j].y-poly[i].y+1e-9)+poly[i].x))c=!c;
    }return c;
  }
  function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
  function colorDistance(a,b){return Math.hypot(a.r-b.r,a.g-b.g,a.b-b.b)}
  function colorMetric(r,g,b,c){
    const s=r+g+b+1,cs=c.r+c.g+c.b+1;
    const cr=r/s,cg=g/s,cb=b/s, rr=c.r/cs,rg=c.g/cs,rb=c.b/cs;
    const chroma=Math.hypot(cr-rr,cg-rg,cb-rb)*430;
    const lum=Math.abs((r+g+b)-(c.r+c.g+c.b))/3*.18;
    return chroma+lum;
  }
  function threshold(){return sensitivity==='high'?112:sensitivity==='low'?78:94}
  function pixelTeam(r,g,b){
    if(!cal.colorA||!cal.colorB)return 0;
    const da=colorMetric(r,g,b,cal.colorA),db=colorMetric(r,g,b,cal.colorB),m=Math.min(da,db),gap=Math.abs(da-db);
    if(m>threshold()||gap<7)return 0;
    return da<db?1:2;
  }
  function classifyColor(rgb){
    if(cal.colorA&&cal.colorB){
      const da=colorMetric(rgb.r,rgb.g,rgb.b,cal.colorA),db=colorMetric(rgb.r,rgb.g,rgb.b,cal.colorB),sum=Math.max(1,Math.min(da,db));
      return {team:da<=db?'A':'B',confidence:Math.max(.5,Math.min(.99,.58+Math.abs(da-db)/(sum+45)*.25))};
    }
    return {team:lastTeam||'A',confidence:.5};
  }
  function sampleRGB(x,y){
    const vw=video.videoWidth,vh=video.videoHeight,sx=Math.max(0,Math.min(vw-1,Math.round(x))),sy=Math.max(0,Math.min(vh-1,Math.round(y)));
    const c=document.createElement('canvas');c.width=vw;c.height=vh;const xctx=c.getContext('2d',{willReadFrequently:true});xctx.drawImage(video,0,0);
    const x0=Math.max(0,sx-6),y0=Math.max(0,sy-6),ww=Math.max(1,Math.min(13,vw-x0)),hh=Math.max(1,Math.min(13,vh-y0)),d=xctx.getImageData(x0,y0,ww,hh).data;
    let r=0,g=0,b=0,n=0;for(let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2];n++}return {r:r/n,g:g/n,b:b/n};
  }
  function boardProc(W,H){return cal.board.map(p=>({x:p.x/video.videoWidth*W,y:p.y/video.videoHeight*H}))}
  function holeProc(W,H){
    if(!cal.hole||!cal.holeEdge)return null;
    const h={x:cal.hole.x/video.videoWidth*W,y:cal.hole.y/video.videoHeight*H};
    const e={x:cal.holeEdge.x/video.videoWidth*W,y:cal.holeEdge.y/video.videoHeight*H};return {h,r:dist(h,e)};
  }
  function playBBox(poly,W,H){
    if(poly.length!==4)return {x0:0,y0:0,x1:W-1,y1:H-1};
    const xs=poly.map(p=>p.x),ys=poly.map(p=>p.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
    const px=(maxX-minX)*.35,py=(maxY-minY)*.35;
    return {x0:Math.max(0,minX-px),y0:Math.max(0,minY-py),x1:Math.min(W-1,maxX+px),y1:Math.min(H-1,maxY+py)};
  }
  function polygonArea(poly){let a=0;for(let i=0,j=poly.length-1;i<poly.length;j=i++)a+=poly[j].x*poly[i].y-poly[i].x*poly[j].y;return Math.abs(a)/2}
  function cloneMap(m){return m?new Uint8Array(m):null}
  function resetTracking(){
    active=false;quietFrames=0;activeFrames=0;cooldownFrames=0;votesA=0;votesB=0;minHolePx=Infinity;lastMotionProc=null;maxBagMotion=0;
    lastGray=null;lastTeamMap=null;stableMap=null;beforeMap=null;lastVideoTime=-1;
  }
  function analyzeThrow(afterMap,W,H,poly,hole){
    const voteTotal=votesA+votesB;
    let team=votesA>=votesB?'A':'B';
    let teamConfidence=voteTotal?Math.max(votesA,votesB)/voteTotal:.5;
    const id=team==='A'?1:2;
    const base=beforeMap||stableMap||new Uint8Array(afterMap.length);
    let added=0,sx=0,sy=0;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const i=y*W+x;if(afterMap[i]===id&&base[i]!==id&&pointInPoly({x,y},poly)){added++;sx+=x;sy+=y}
    }
    const area=Math.max(1,polygonArea(poly));
    const minAdded=Math.max(5,Math.round(area*(sensitivity==='high'?.0012:sensitivity==='low'?.0024:.0017)));
    const addedProc=added?{x:sx/added,y:sy/added}:null;
    const landingProc=addedProc||lastMotionProc;
    const nearHole=!!hole&&minHolePx<=hole.r*1.65;
    const landedOnBoard=!!addedProc&&added>=minAdded&&pointInPoly(addedProc,poly);
    let result='miss';
    if(nearHole&&added<minAdded*1.45)result='hole';
    else if(landedOnBoard)result='board';
    else if(landingProc&&pointInPoly(landingProc,poly)&&!nearHole&&maxBagMotion>0)result='board';
    const centroid=landingProc?{x:landingProc.x/W*video.videoWidth,y:landingProc.y/H*video.videoHeight}:null;
    const settleConfidence=Math.min(.98,.56+Math.min(added/(minAdded*3),1)*.18+Math.min(activeFrames/10,1)*.14+Math.min(maxBagMotion/45,1)*.10);
    return {team,result,confidence:Math.min(.99,settleConfidence*.72+teamConfidence*.28),teamConfidence,centroid,addedPixels:added,minAdded,nearHole};
  }
  function draw(){
    fitCanvas();const r=overlay.getBoundingClientRect();octx.clearRect(0,0,r.width,r.height);octx.font='13px system-ui';
    if(cal.board.length){
      octx.lineWidth=3;octx.strokeStyle='#22d07f';octx.fillStyle='#22d07f';octx.beginPath();
      cal.board.forEach((p,i)=>{const q=videoToDisp(p);i?octx.lineTo(q.x,q.y):octx.moveTo(q.x,q.y)});if(cal.board.length===4)octx.closePath();octx.stroke();
      cal.board.forEach((p,i)=>{const q=videoToDisp(p);octx.beginPath();octx.arc(q.x,q.y,6,0,Math.PI*2);octx.fill();octx.fillText(String(i+1),q.x+8,q.y-8)})
    }
    if(cal.hole){
      const h=videoToDisp(cal.hole);octx.fillStyle='#ffcf4a';octx.beginPath();octx.arc(h.x,h.y,6,0,Math.PI*2);octx.fill();
      if(cal.holeEdge){const e=videoToDisp(cal.holeEdge),rr=Math.hypot(e.x-h.x,e.y-h.y);octx.strokeStyle='#ffcf4a';octx.lineWidth=3;octx.beginPath();octx.arc(h.x,h.y,rr,0,Math.PI*2);octx.stroke()}
    }
    if(lastCentroid){const c=videoToDisp(lastCentroid);octx.strokeStyle=lastTeam==='B'?'#ff9d28':'#3fa7ff';octx.lineWidth=3;octx.beginPath();octx.arc(c.x,c.y,16,0,Math.PI*2);octx.stroke();octx.fillStyle='#fff';octx.fillText(lastTeam?`Tracking ${lastTeam}`:'bag',c.x+19,c.y)}
  }
  function processFrame(ts){
    if(!running)return;
    if(lastT){const inst=1000/Math.max(1,ts-lastT);fps=fps*.9+inst*.1}lastT=ts;
    if(video?.readyState>=2&&video.videoWidth){
      const vt=video.currentTime;
      if(vt!==lastVideoTime){
        lastVideoTime=vt;
        const W=240,H=Math.max(80,Math.round(240*video.videoHeight/video.videoWidth));proc.width=W;proc.height=H;pctx.drawImage(video,0,0,W,H);
        const d=pctx.getImageData(0,0,W,H).data,gray=new Uint8Array(W*H),teamMap=new Uint8Array(W*H),poly=boardProc(W,H),hole=holeProc(W,H),box=playBBox(poly,W,H);
        let changedColor=0,sx=0,sy=0,fa=0,fb=0;
        for(let y=0;y<H;y++)for(let x=0;x<W;x++){
          const i=y*W+x,j=i*4,r=d[j],g=d[j+1],b=d[j+2];gray[i]=(r*3+g*6+b)/10;const t=pixelTeam(r,g,b);teamMap[i]=t;
          if(lastGray&&x>=box.x0&&x<=box.x1&&y>=box.y0&&y<=box.y1){
            const dv=Math.abs(gray[i]-lastGray[i]);
            if(dv>18){const mt=t||(lastTeamMap?lastTeamMap[i]:0);if(mt){changedColor++;sx+=x;sy+=y;if(mt===1)fa++;else fb++}}
          }
        }
        const motion=Math.min(1,changedColor/(sensitivity==='high'?35:sensitivity==='low'?65:48));
        const minMove=sensitivity==='high'?5:sensitivity==='low'?11:8;
        const moving=changedColor>=minMove;
        if(cooldownFrames>0)cooldownFrames--;
        if(auto&&poly.length===4&&hole&&cal.colorA&&cal.colorB){
          if(moving&&cooldownFrames===0){
            if(!active){active=true;quietFrames=0;activeFrames=0;beforeMap=cloneMap(stableMap||lastTeamMap||teamMap);votesA=0;votesB=0;minHolePx=Infinity;lastMotionProc=null;maxBagMotion=0}
            activeFrames++;quietFrames=0;votesA+=fa;votesB+=fb;maxBagMotion=Math.max(maxBagMotion,changedColor);
            const c={x:sx/changedColor,y:sy/changedColor};lastMotionProc=c;lastCentroid={x:c.x/W*video.videoWidth,y:c.y/H*video.videoHeight};lastTeam=votesA>=votesB?'A':'B';
            if(hole)minHolePx=Math.min(minHolePx,dist(c,hole.h));
          }else if(active){
            quietFrames++;
            if(quietFrames>=9){
              active=false;quietFrames=0;
              if(activeFrames>=2){const e=analyzeThrow(teamMap,W,H,poly,hole);if(onThrow)onThrow(e)}
              stableMap=cloneMap(teamMap);beforeMap=null;cooldownFrames=7;activeFrames=0;votesA=0;votesB=0;minHolePx=Infinity;maxBagMotion=0;
            }
          }else if(cooldownFrames===0){stableMap=cloneMap(teamMap)}
        }else{active=false;quietFrames=0;stableMap=cloneMap(teamMap)}
        lastGray=gray;lastTeamMap=teamMap;
        if(onMetrics)onMetrics({motion,fps,centroid:lastCentroid,team:lastTeam,active,changedColor});
      }
      draw();
    }
    requestAnimationFrame(processFrame);
  }
  function init(v,c,throwCb,metricsCb){
    video=v;overlay=c;octx=c.getContext('2d');proc=document.createElement('canvas');pctx=proc.getContext('2d',{willReadFrequently:true});onThrow=throwCb;onMetrics=metricsCb;resetTracking();
    if(!overlay.dataset.bound){overlay.dataset.bound='1';overlay.addEventListener('pointerdown',e=>{
      const r=overlay.getBoundingClientRect(),p=dispToVideo(e.clientX-r.left,e.clientY-r.top);
      if(mode==='board'){if(cal.board.length>=4)cal.board=[];cal.board.push(p);if(cal.board.length===4)mode=null}
      else if(mode==='hole'){if(!cal.hole||cal.holeEdge){cal.hole=p;cal.holeEdge=null}else{cal.holeEdge=p;mode=null}}
      else if(mode==='A'||mode==='B'){const rgb=sampleRGB(p.x,p.y);if(mode==='A')cal.colorA=rgb;else cal.colorB=rgb;mode=null}
      saveCal();resetTracking();draw();window.dispatchEvent(new CustomEvent('calibrationchange',{detail:getCalibration()}));
    })}
    if(!running){running=true;requestAnimationFrame(processFrame)}
  }
  function setMode(m){mode=m}
  function setAuto(v){auto=!!v;resetTracking()}
  function setSensitivity(v){sensitivity=['high','normal','low'].includes(v)?v:'high';resetTracking()}
  function clear(){cal={board:[],hole:null,holeEdge:null,colorA:null,colorB:null};saveCal();resetTracking();draw();window.dispatchEvent(new CustomEvent('calibrationchange',{detail:getCalibration()}))}
  function getCalibration(){return JSON.parse(JSON.stringify(cal))}
  function saveCal(){try{localStorage.setItem('cornhole-v5-cal',JSON.stringify(cal))}catch{}}
  function loadCal(){try{const x=JSON.parse(localStorage.getItem('cornhole-v5-cal'));if(x)cal=x}catch{}return getCalibration()}
  function snapshot(){const c=document.createElement('canvas');c.width=320;c.height=Math.round(320*video.videoHeight/video.videoWidth);c.getContext('2d').drawImage(video,0,0,c.width,c.height);return c.toDataURL('image/jpeg',.72)}
  return {init,setMode,setAuto,setSensitivity,clear,getCalibration,loadCal,snapshot};
})();
