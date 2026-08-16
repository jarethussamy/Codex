/* Yard Vision V9 — stable full-yard CV core with active-board overlay.
   V9 reliability features (duplicate guard, overlap-safe throw identity,
   automatic round completion and board switching) live in app.js. */
const Vision = (() => {
  let video, overlay, octx, proc, pctx;
  let running = false, auto = false, sensitivity = 'high';
  let onThrow = null, onMetrics = null;
  let cal = { boards: [] };
  let tracks = [], nextTrackId = 1;
  let lastGray = null, lastTeamMap = null, stableMap = null, beforeMap = null;
  let lastVideoTime = -1, lastT = 0, fps = 0, frameNo = 0;
  let active = false, quietFrames = 0, activeFrames = 0, cooldownFrames = 0;
  let votesA = 0, votesB = 0, lastMotionProc = null, maxBagMotion = 0;
  let lastCentroid = null, lastTeam = null, minHoleRatio = Infinity, motionBoardIndex = -1;

  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const dist = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
  const cloneMap = m => m ? new Uint8Array(m) : null;

  function polygonArea(poly){let a=0;for(let i=0,j=poly.length-1;i<poly.length;j=i++)a+=poly[j].x*poly[i].y-poly[i].x*poly[j].y;return Math.abs(a)/2}
  function polyCenter(poly){return {x:poly.reduce((s,p)=>s+p.x,0)/poly.length,y:poly.reduce((s,p)=>s+p.y,0)/poly.length}}
  function pointInPoly(p,poly){let c=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){if(((poly[i].y>p.y)!=(poly[j].y>p.y))&&(p.x<(poly[j].x-poly[i].x)*(p.y-poly[i].y)/(poly[j].y-poly[i].y+1e-9)+poly[i].x))c=!c}return c}

  function displayBox(){
    const r=overlay.getBoundingClientRect(),vw=Math.max(1,video?.videoWidth||1),vh=Math.max(1,video?.videoHeight||1);
    const scale=Math.min(r.width/vw,r.height/vh),w=vw*scale,h=vh*scale;
    return {r,scale,w,h,ox:(r.width-w)/2,oy:(r.height-h)/2};
  }
  function fitCanvas(){
    if(!video?.videoWidth)return;
    const r=overlay.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
    overlay.width=Math.max(1,Math.round(r.width*dpr));overlay.height=Math.max(1,Math.round(r.height*dpr));
    overlay.style.width=r.width+'px';overlay.style.height=r.height+'px';octx.setTransform(dpr,0,0,dpr,0,0);
  }
  function procToVideo(p,W,H){return{x:p.x/W*video.videoWidth,y:p.y/H*video.videoHeight}}
  function videoToDisp(p){const b=displayBox();return{x:b.ox+p.x*b.scale,y:b.oy+p.y*b.scale}}

  function rgbToHsv(r,g,b){
    r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;
    if(d){if(max===r)h=60*(((g-b)/d)%6);else if(max===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4)}
    if(h<0)h+=360;return{h,s:max?d/max:0,v:max};
  }
  function pixelTeam(r,g,b){
    const {h,s,v}=rgbToHsv(r,g,b);if(s<.26||v<.12)return 0;
    const blue=h>=178&&h<=265&&b>=r*1.05&&b>=g*.99&&(b-Math.min(r,g)>14);
    const red=(h<=25||h>=335)&&r>=g*1.08&&r>=b*1.03&&(r-Math.min(g,b)>16);
    return blue?1:red?2:0;
  }
  function boardPixel(r,g,b){
    if(pixelTeam(r,g,b))return false;
    const {h,s,v}=rgbToHsv(r,g,b),lum=(r*.30+g*.59+b*.11)/255;
    const grass=h>=60&&h<=175&&s>.22&&g>r*.92&&g>b*.92;
    if(grass||v<.24)return false;
    const neutral=lum>.42&&s<.58;
    const wood=(h>=18&&h<=58&&s<.72&&v>.32);
    const pale=(lum>.62&&s<.78);
    return neutral||wood||pale;
  }

  function integralGray(d,W,H){
    const I=new Float64Array((W+1)*(H+1));
    for(let y=1;y<=H;y++){let row=0;for(let x=1;x<=W;x++){const j=((y-1)*W+(x-1))*4;row+=(d[j]*3+d[j+1]*6+d[j+2])/10;I[y*(W+1)+x]=I[(y-1)*(W+1)+x]+row}}
    return I;
  }
  function boxMean(I,W,H,cx,cy,r){
    const x0=clamp(Math.floor(cx-r),0,W-1),x1=clamp(Math.ceil(cx+r),0,W-1),y0=clamp(Math.floor(cy-r),0,H-1),y1=clamp(Math.ceil(cy+r),0,H-1),S=W+1;
    const a=I[y0*S+x0],b=I[y0*S+x1+1],c=I[(y1+1)*S+x0],dd=I[(y1+1)*S+x1+1];
    return(dd-b-c+a)/Math.max(1,(x1-x0+1)*(y1-y0+1));
  }
  function detectHole(d,W,H,poly,I){
    if(poly.length!==4)return null;
    const xs=poly.map(p=>p.x),ys=poly.map(p=>p.y),minX=clamp(Math.floor(Math.min(...xs)),1,W-2),maxX=clamp(Math.ceil(Math.max(...xs)),1,W-2),minY=clamp(Math.floor(Math.min(...ys)),1,H-2),maxY=clamp(Math.ceil(Math.max(...ys)),1,H-2);
    const topW=Math.max(4,dist(poly[0],poly[1])),botW=Math.max(4,dist(poly[3],poly[2]));
    const expectedR=clamp((topW*.65+botW*.35)/8.0,1.6,18);
    const step=Math.max(1,Math.round(expectedR*.45));let best=null;
    for(let y=minY;y<=maxY;y+=step)for(let x=minX;x<=maxX;x+=step){
      if(!pointInPoly({x,y},poly))continue;
      const inner=boxMean(I,W,H,x,y,expectedR*.55),outer=boxMean(I,W,H,x,y,expectedR*1.55);
      const score=(outer-inner)+(132-inner)*.055;
      if(!best||score>best.score)best={center:{x,y},r:expectedR,score,inner};
    }
    if(!best||best.score<7.0||best.inner>158)return null;
    return {...best,confidence:clamp(.42+(best.score-6)/32,.42,.99)};
  }

  function detectBoards(d,W,H){
    const N=W*H,mask=new Uint8Array(N),seen=new Uint8Array(N),q=new Int32Array(N),I=integralGray(d,W,H),out=[];
    for(let i=0;i<N;i++){const j=i*4;if(boardPixel(d[j],d[j+1],d[j+2]))mask[i]=1}
    const minPixels=Math.max(8,Math.round(N*.00018)),maxPixels=Math.round(N*.26);
    for(let sy=1;sy<H-1;sy++)for(let sx=1;sx<W-1;sx++){
      const seed=sy*W+sx;if(!mask[seed]||seen[seed])continue;
      let head=0,tail=0,count=0,minX=W,maxX=0,minY=H,maxY=0,sumX=0,sumY=0;
      let tl=null,tr=null,br=null,bl=null,tlv=Infinity,trv=-Infinity,brv=-Infinity,blv=Infinity;
      q[tail++]=seed;seen[seed]=1;
      while(head<tail&&count<=maxPixels){
        const idx=q[head++],x=idx%W,y=(idx/W)|0;if(!mask[idx])continue;
        count++;sumX+=x;sumY+=y;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
        const s=x+y,dd=x-y;if(s<tlv){tlv=s;tl={x,y}}if(dd>trv){trv=dd;tr={x,y}}if(s>brv){brv=s;br={x,y}}if(dd<blv){blv=dd;bl={x,y}}
        const n=[idx-1,idx+1,idx-W,idx+W];if(x===0)n[0]=-1;if(x===W-1)n[1]=-1;if(y===0)n[2]=-1;if(y===H-1)n[3]=-1;
        for(const ni of n)if(ni>=0&&!seen[ni]&&mask[ni]){seen[ni]=1;q[tail++]=ni}
      }
      if(count<minPixels||count>maxPixels||!tl||!tr||!br||!bl)continue;
      const bw=maxX-minX+1,bh=maxY-minY+1,bbox=bw*bh,fill=count/Math.max(1,bbox),frac=count/N,aspect=bw/Math.max(1,bh),corners=[tl,tr,br,bl],area=polygonArea(corners);
      if(bw<4||bh<4||bbox>N*.28||fill<.12||aspect<.13||aspect>7||area<N*.00012)continue;
      const hole=detectHole(d,W,H,corners,I),edgePenalty=(minX<=1||maxX>=W-2||minY<=1||maxY>=H-2)?.35:0;
      const sizeScore=clamp(Math.sqrt(frac/.02),0,1),fillScore=clamp(fill/.55,0,1),shapeScore=(aspect>.22&&aspect<4.8)?1:.45,holeScore=hole?1:0;
      const score=sizeScore*.23+fillScore*.20+shapeScore*.18+holeScore*.58-edgePenalty;
      if(score<.44)continue;
      out.push({corners,hole,score,confidence:clamp(.38+score*.44,.38,.99),center:{x:sumX/count,y:sumY/count}});
    }
    out.sort((a,b)=>b.score-a.score);const picked=[];
    for(const c of out){
      if(picked.length>=2)break;
      if(picked.some(p=>dist(c.center,p.center)<Math.max(6,Math.sqrt(Math.max(polygonArea(c.corners),polygonArea(p.corners)))*.55)))continue;
      picked.push(c);
    }
    return picked;
  }

  function avgCornerDistance(a,b){let s=0;for(let i=0;i<4;i++)s+=dist(a[i],b[i]);return s/4}
  function smoothCorners(a,b){return a.map((p,i)=>({x:p.x*.70+b[i].x*.30,y:p.y*.70+b[i].y*.30}))}
  function saveCal(){try{localStorage.setItem('cornhole-v9-yard-cal',JSON.stringify(cal))}catch{}}
  function dispatchCal(){window.dispatchEvent(new CustomEvent('calibrationchange',{detail:getCalibration()}))}
  function syncCal(W,H){
    const locked=tracks.filter(t=>t.hits>=2&&t.misses<24&&t.confidence>.38).slice(0,2);
    cal.boards=locked.map(t=>({
      poly:t.corners.map(p=>procToVideo(p,W,H)),
      hole:t.hole?procToVideo(t.hole,W,H):null,
      holeEdge:t.hole&&t.holeR?procToVideo({x:t.hole.x+t.holeR,y:t.hole.y},W,H):null,
      confidence:t.confidence,holeConfidence:t.holeConfidence||0
    }));
    const first=cal.boards[0];cal.board=first?.poly||[];cal.hole=first?.hole||null;cal.holeEdge=first?.holeEdge||null;cal.boardConfidence=first?.confidence||0;cal.holeConfidence=first?.holeConfidence||0;
    saveCal();dispatchCal();
  }
  function updateTracks(candidates,W,H){
    const used=new Set();
    for(const t of tracks){
      let best=-1,bestD=Infinity;
      for(let i=0;i<candidates.length;i++){if(used.has(i))continue;const d0=avgCornerDistance(t.corners,candidates[i].corners);if(d0<bestD){bestD=d0;best=i}}
      if(best>=0&&bestD<Math.max(9,W*.10)){
        const c=candidates[best];used.add(best);const oldC=polyCenter(t.corners),oldArea=Math.max(1,polygonArea(t.corners));
        t.corners=smoothCorners(t.corners,c.corners);const newC=polyCenter(t.corners),newArea=Math.max(1,polygonArea(t.corners)),scale=clamp(Math.sqrt(newArea/oldArea),.72,1.38);
        t.confidence=t.confidence*.74+c.confidence*.26;t.hits++;t.misses=0;
        if(c.hole){
          t.hole=t.hole?{x:t.hole.x*.62+c.hole.center.x*.38,y:t.hole.y*.62+c.hole.center.y*.38}:c.hole.center;
          t.holeR=t.holeR?t.holeR*.62+c.hole.r*.38:c.hole.r;t.holeConfidence=t.holeConfidence?t.holeConfidence*.7+c.hole.confidence*.3:c.hole.confidence;t.holeMisses=0;
        }else if(t.hole){
          t.hole={x:newC.x+(t.hole.x-oldC.x)*scale,y:newC.y+(t.hole.y-oldC.y)*scale};t.holeR=Math.max(1,t.holeR*scale);t.holeConfidence=(t.holeConfidence||.6)*.985;t.holeMisses=(t.holeMisses||0)+1;
          if(t.holeMisses>22){t.hole=null;t.holeR=0;t.holeConfidence=0;t.holeMisses=0}
        }
      }else t.misses++;
    }
    for(let i=0;i<candidates.length;i++)if(!used.has(i)){const c=candidates[i];tracks.push({id:nextTrackId++,corners:c.corners,confidence:c.confidence,hits:1,misses:0,hole:c.hole?.center||null,holeR:c.hole?.r||0,holeConfidence:c.hole?.confidence||0,holeMisses:c.hole?0:1})}
    tracks=tracks.filter(t=>t.misses<30).sort((a,b)=>(a.id||0)-(b.id||0)).slice(0,3);syncCal(W,H);
  }

  function boardsProc(W,H){
    return (cal.boards||[]).map(b=>{
      const poly=(b.poly||[]).map(p=>({x:p.x/video.videoWidth*W,y:p.y/video.videoHeight*H}));let hole=null;
      if(b.hole&&b.holeEdge){const h={x:b.hole.x/video.videoWidth*W,y:b.hole.y/video.videoHeight*H},e={x:b.holeEdge.x/video.videoWidth*W,y:b.holeEdge.y/video.videoHeight*H};hole={h,r:dist(h,e)}}
      return{poly,hole,confidence:b.confidence||0};
    }).filter(b=>b.poly.length===4);
  }

  function resetThrow(){active=false;quietFrames=0;activeFrames=0;cooldownFrames=0;votesA=0;votesB=0;lastMotionProc=null;maxBagMotion=0;minHoleRatio=Infinity;motionBoardIndex=-1;beforeMap=null}
  function resetTracking(){resetThrow();lastGray=null;lastTeamMap=null;stableMap=null;lastVideoTime=-1}

  function updateHolePass(c,boards){
    for(let i=0;i<boards.length;i++)if(boards[i].hole){const ratio=dist(c,boards[i].hole.h)/Math.max(1,boards[i].hole.r);if(ratio<minHoleRatio){minHoleRatio=ratio;motionBoardIndex=i}}
  }
  function analyzeThrow(afterMap,W,H,boards){
    const total=votesA+votesB,team=votesA>=votesB?'A':'B',teamConfidence=total?Math.max(votesA,votesB)/total:.5,id=team==='A'?1:2,base=beforeMap||stableMap||new Uint8Array(afterMap.length);
    const adds=boards.map(()=>({n:0,sx:0,sy:0}));let globalN=0,gx=0,gy=0;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=y*W+x;if(afterMap[i]!==id||base[i]===id)continue;globalN++;gx+=x;gy+=y;for(let bi=0;bi<boards.length;bi++)if(pointInPoly({x,y},boards[bi].poly)){adds[bi].n++;adds[bi].sx+=x;adds[bi].sy+=y}}
    let bi=-1,best=0;for(let i=0;i<adds.length;i++)if(adds[i].n>best){best=adds[i].n;bi=i}
    if(bi<0&&motionBoardIndex>=0)bi=motionBoardIndex;
    const target=bi>=0?boards[bi]:null;let result='miss',landing=globalN?{x:gx/globalN,y:gy/globalN}:lastMotionProc,minAdded=5,nearHole=minHoleRatio<=1.75;
    if(target){
      const a=adds[bi],area=Math.max(1,polygonArea(target.poly));minAdded=Math.max(4,Math.round(area*(sensitivity==='high'?.0010:sensitivity==='low'?.0024:.0016)));
      if(a?.n)landing={x:a.sx/a.n,y:a.sy/a.n};
      if(target.hole&&landing&&dist(landing,target.hole.h)<=target.hole.r*1.65)nearHole=true;
      if(nearHole&&best<minAdded*1.7)result='hole';else if(best>=minAdded||(landing&&pointInPoly(landing,target.poly)))result='board';
    }
    const centroid=landing?procToVideo(landing,W,H):null,settle=clamp(.54+Math.min(best/(minAdded*3),1)*.18+Math.min(activeFrames/10,1)*.14+Math.min(maxBagMotion/60,1)*.10,.54,.98);
    return{team,result,confidence:clamp(settle*.72+teamConfidence*.28,.5,.99),teamConfidence,centroid,nearHole,boardIndex:bi,addedPixels:best,minAdded};
  }

  function draw(){
    fitCanvas();const r=overlay.getBoundingClientRect(),b=displayBox();octx.clearRect(0,0,r.width,r.height);octx.font='13px system-ui';
    octx.save();octx.strokeStyle='#22d07f';octx.lineWidth=2;octx.setLineDash([10,7]);octx.strokeRect(b.ox+2,b.oy+2,Math.max(0,b.w-4),Math.max(0,b.h-4));octx.setLineDash([]);octx.fillStyle='#22d07f';octx.fillText('FULL YARD VISION V9',b.ox+9,b.oy+19);octx.restore();
    const requested=Number.isInteger(window.__yardActiveBoard)?window.__yardActiveBoard:0;
    (cal.boards||[]).forEach((board,idx)=>{
      if(board.poly?.length!==4)return;
      const isActive=(cal.boards.length<2||idx===requested);
      octx.strokeStyle=isActive?'#22d07f':'#35cfff';octx.fillStyle=isActive?'#22d07f':'#35cfff';octx.lineWidth=isActive?5:3;
      octx.beginPath();board.poly.forEach((p,i)=>{const q=videoToDisp(p);i?octx.lineTo(q.x,q.y):octx.moveTo(q.x,q.y)});octx.closePath();octx.stroke();
      const q=videoToDisp(board.poly[0]);octx.fillText(isActive?`ACTIVE BOARD ${idx+1}`:`BOARD ${idx+1}`,q.x+7,q.y-7);
      if(board.hole&&board.holeEdge){const h=videoToDisp(board.hole),e=videoToDisp(board.holeEdge),rr=Math.hypot(e.x-h.x,e.y-h.y);octx.strokeStyle='#ffd166';octx.lineWidth=4;octx.beginPath();octx.arc(h.x,h.y,rr,0,Math.PI*2);octx.stroke();octx.fillStyle='#ffd166';octx.fillText(`HOLE ${idx+1}`,h.x+rr+5,h.y)}
    });
    if(lastCentroid){const c=videoToDisp(lastCentroid);octx.strokeStyle=lastTeam==='B'?'#ff4458':'#2d8cff';octx.lineWidth=4;octx.beginPath();octx.arc(c.x,c.y,17,0,Math.PI*2);octx.stroke();octx.fillStyle='#fff';octx.fillText(lastTeam==='B'?'RED BAG':'BLUE BAG',c.x+20,c.y)}
  }

  function processFrame(ts){
    if(!running)return;if(lastT){const inst=1000/Math.max(1,ts-lastT);fps=fps*.9+inst*.1}lastT=ts;
    if(video?.readyState>=2&&video.videoWidth){
      const vt=video.currentTime;if(vt!==lastVideoTime){lastVideoTime=vt;frameNo++;
        const W=320,H=Math.max(100,Math.round(320*video.videoHeight/video.videoWidth));proc.width=W;proc.height=H;pctx.drawImage(video,0,0,W,H);const d=pctx.getImageData(0,0,W,H).data;
        if(frameNo%6===0||!tracks.length)updateTracks(detectBoards(d,W,H),W,H);
        const boards=boardsProc(W,H),gray=new Uint8Array(W*H),teamMap=new Uint8Array(W*H);let changed=0,sx=0,sy=0,fa=0,fb=0;
        for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=y*W+x,j=i*4,r=d[j],g=d[j+1],bl=d[j+2];gray[i]=(r*3+g*6+bl)/10;const t=pixelTeam(r,g,bl);teamMap[i]=t;if(lastGray&&Math.abs(gray[i]-lastGray[i])>16){const mt=t||(lastTeamMap?lastTeamMap[i]:0);if(mt){changed++;sx+=x;sy+=y;if(mt===1)fa++;else fb++}}}
        const motion=clamp(changed/(sensitivity==='high'?40:sensitivity==='low'?84:58),0,1),minMove=sensitivity==='high'?5:sensitivity==='low'?14:9,moving=changed>=minMove;if(cooldownFrames>0)cooldownFrames--;
        if(auto&&boards.length){
          if(moving&&cooldownFrames===0){
            if(!active){active=true;quietFrames=0;activeFrames=0;beforeMap=cloneMap(stableMap||lastTeamMap||teamMap);votesA=0;votesB=0;lastMotionProc=null;maxBagMotion=0;minHoleRatio=Infinity;motionBoardIndex=-1}
            activeFrames++;quietFrames=0;votesA+=fa;votesB+=fb;maxBagMotion=Math.max(maxBagMotion,changed);const c={x:sx/changed,y:sy/changed};lastMotionProc=c;lastCentroid=procToVideo(c,W,H);lastTeam=votesA>=votesB?'A':'B';updateHolePass(c,boards);
          }else if(active){
            quietFrames++;if(quietFrames>=9){active=false;quietFrames=0;if(activeFrames>=2&&onThrow)onThrow(analyzeThrow(teamMap,W,H,boards));stableMap=cloneMap(teamMap);beforeMap=null;cooldownFrames=7;activeFrames=0;votesA=0;votesB=0;maxBagMotion=0;minHoleRatio=Infinity;motionBoardIndex=-1}
          }else if(cooldownFrames===0)stableMap=cloneMap(teamMap);
        }else{active=false;quietFrames=0;stableMap=cloneMap(teamMap)}
        lastGray=gray;lastTeamMap=teamMap;
        if(onMetrics)onMetrics({motion,fps,active,changedColor:changed,boardReady:boards.length>0,holeReady:boards.some(b=>!!b.hole),boardCount:boards.length,holeCount:boards.filter(b=>!!b.hole).length,boardConfidence:Math.max(0,...(cal.boards||[]).map(b=>b.confidence||0)),holeConfidence:Math.max(0,...(cal.boards||[]).map(b=>b.holeConfidence||0)),fullYard:true,activeBoardIndex:Number.isInteger(window.__yardActiveBoard)?window.__yardActiveBoard:0});
      }draw();
    }requestAnimationFrame(processFrame);
  }

  function init(v,c,throwCb,metricsCb){video=v;overlay=c;octx=c.getContext('2d');proc=document.createElement('canvas');pctx=proc.getContext('2d',{willReadFrequently:true});onThrow=throwCb;onMetrics=metricsCb;resetTracking();if(!running){running=true;requestAnimationFrame(processFrame)}}
  function setAuto(v){auto=!!v;resetTracking()}
  function setSensitivity(v){sensitivity=['high','normal','low'].includes(v)?v:'high';resetTracking()}
  function rescan(){cal={boards:[]};tracks=[];nextTrackId=1;saveCal();resetTracking();dispatchCal()}
  function getCalibration(){return JSON.parse(JSON.stringify(cal))}
  function loadCal(){
    try{
      const x=JSON.parse(localStorage.getItem('cornhole-v9-yard-cal')||localStorage.getItem('cornhole-v7-2-yard-cal'));
      if(x?.boards)cal=x
    }catch{}
    const first=cal.boards?.[0];cal.board=first?.poly||[];cal.hole=first?.hole||null;cal.holeEdge=first?.holeEdge||null;cal.boardConfidence=first?.confidence||0;cal.holeConfidence=first?.holeConfidence||0;return getCalibration()
  }
  function snapshot(){const c=document.createElement('canvas');c.width=320;c.height=Math.max(1,Math.round(320*video.videoHeight/video.videoWidth));c.getContext('2d').drawImage(video,0,0,c.width,c.height);return c.toDataURL('image/jpeg',.72)}
  return{init,setAuto,setSensitivity,rescan,getCalibration,loadCal,snapshot};
})();
