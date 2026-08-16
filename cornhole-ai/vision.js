const Vision = (() => {
  let video, overlay, octx, proc, pctx, running=false, auto=false;
  let cal={boards:[],board:[],hole:null,holeEdge:null,boardConfidence:0,holeConfidence:0};
  let sensitivity='high';
  let lastT=0, fps=0, lastVideoTime=-1, frameNo=0;
  let lastGray=null, lastTeamMap=null, stableMap=null, beforeMap=null;
  let active=false, quietFrames=0, activeFrames=0, cooldownFrames=0;
  let lastCentroid=null, lastTeam=null, onThrow=null, onMetrics=null;
  let votesA=0, votesB=0, lastMotionProc=null, maxBagMotion=0;
  let boardTracks=[];

  function displayBox(){
    const r=overlay.getBoundingClientRect(), vw=Math.max(1,video?.videoWidth||1), vh=Math.max(1,video?.videoHeight||1);
    const scale=Math.min(r.width/vw,r.height/vh), w=vw*scale, h=vh*scale;
    return {r,scale,w,h,ox:(r.width-w)/2,oy:(r.height-h)/2,vw,vh};
  }
  function fitCanvas(){
    if(!video||!video.videoWidth)return;
    const r=overlay.getBoundingClientRect(), dpr=window.devicePixelRatio||1;
    overlay.width=Math.max(1,Math.round(r.width*dpr));
    overlay.height=Math.max(1,Math.round(r.height*dpr));
    overlay.style.width=r.width+'px';
    overlay.style.height=r.height+'px';
    octx.setTransform(dpr,0,0,dpr,0,0);
  }
  function videoToDisp(p){const b=displayBox();return{x:b.ox+p.x*b.scale,y:b.oy+p.y*b.scale}}
  function procToVideo(p,W,H){return{x:p.x/W*video.videoWidth,y:p.y/H*video.videoHeight}}
  function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
  function polygonArea(poly){let a=0;for(let i=0,j=poly.length-1;i<poly.length;j=i++)a+=poly[j].x*poly[i].y-poly[i].x*poly[j].y;return Math.abs(a)/2}
  function pointInPoly(p,poly){
    let c=false;
    for(let i=0,j=poly.length-1;i<poly.length;j=i++){
      if(((poly[i].y>p.y)!=(poly[j].y>p.y)) && (p.x<(poly[j].x-poly[i].x)*(p.y-poly[i].y)/(poly[j].y-poly[i].y+1e-9)+poly[i].x)) c=!c;
    }
    return c;
  }
  function polyCenter(poly){return {x:poly.reduce((s,p)=>s+p.x,0)/poly.length,y:poly.reduce((s,p)=>s+p.y,0)/poly.length}}
  function cloneMap(m){return m?new Uint8Array(m):null}
  function rgbToHsv(r,g,b){
    r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;
    if(d){if(max===r)h=60*(((g-b)/d)%6);else if(max===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4)}
    if(h<0)h+=360;return{h,s:max?d/max:0,v:max};
  }
  function pixelTeam(r,g,b){
    const {h,s,v}=rgbToHsv(r,g,b); if(s<.28||v<.13)return 0;
    const blue=h>=180&&h<=260&&b>=r*1.06&&b>=g*1.01&&(b-Math.min(r,g)>15);
    const red=(h<=22||h>=338)&&r>=g*1.10&&r>=b*1.04&&(r-Math.min(g,b)>18);
    return blue?1:red?2:0;
  }
  function boardPixel(r,g,b){
    const {h,s,v}=rgbToHsv(r,g,b), lum=(r*.30+g*.60+b*.10)/255;
    if(v<.38||pixelTeam(r,g,b))return false;
    const grass=h>=65&&h<=175&&s>.18;
    if(grass)return false;
    return lum>.55&&s<.52;
  }
  function integralGray(d,W,H){
    const I=new Float64Array((W+1)*(H+1));
    for(let y=1;y<=H;y++){let row=0;for(let x=1;x<=W;x++){const j=((y-1)*W+(x-1))*4;row+=(d[j]*3+d[j+1]*6+d[j+2])/10;I[y*(W+1)+x]=I[(y-1)*(W+1)+x]+row}}
    return I;
  }
  function boxMean(I,W,H,cx,cy,r){
    const x0=Math.max(0,Math.floor(cx-r)),x1=Math.min(W-1,Math.ceil(cx+r)),y0=Math.max(0,Math.floor(cy-r)),y1=Math.min(H-1,Math.ceil(cy+r));
    const S=W+1,a=I[y0*S+x0],b=I[y0*S+x1+1],c=I[(y1+1)*S+x0],d=I[(y1+1)*S+x1+1],n=(x1-x0+1)*(y1-y0+1);return(d-b-c+a)/Math.max(1,n);
  }
  function detectHoleCandidate(d,W,H,poly,I){
    if(poly.length!==4)return null;
    const xs=poly.map(p=>p.x),ys=poly.map(p=>p.y),minX=Math.max(1,Math.floor(Math.min(...xs))),maxX=Math.min(W-2,Math.ceil(Math.max(...xs))),minY=Math.max(1,Math.floor(Math.min(...ys))),maxY=Math.min(H-2,Math.ceil(Math.max(...ys)));
    const topW=Math.max(4,dist(poly[0],poly[1])),botW=Math.max(4,dist(poly[3],poly[2]));
    const expectedR=Math.max(1.8,Math.min(15,(topW*.68+botW*.32)/8.0));
    let best=null;const step=Math.max(1,Math.round(expectedR*.45));
    for(let y=minY+1;y<=maxY-1;y+=step){
      for(let x=minX+1;x<=maxX-1;x+=step){
        if(!pointInPoly({x,y},poly))continue;
        const inner=boxMean(I,W,H,x,y,expectedR*.55),outer=boxMean(I,W,H,x,y,expectedR*1.45);
        const score=(outer-inner)+(125-inner)*.06;
        if(!best||score>best.score)best={x,y,r:expectedR,score,inner,outer};
      }
    }
    if(!best||best.score<8.0||best.inner>150)return null;
    return{center:{x:best.x,y:best.y},r:best.r,confidence:Math.min(.99,.44+Math.max(0,best.score-7)/34)};
  }
  function componentBoards(d,W,H){
    const N=W*H,mask=new Uint8Array(N),seen=new Uint8Array(N),I=integralGray(d,W,H);
    for(let i=0;i<N;i++){const j=i*4;if(boardPixel(d[j],d[j+1],d[j+2]))mask[i]=1}
    const q=new Int32Array(N),out=[];
    const minPixels=Math.max(12,Math.round(N*.00028)),maxPixels=Math.round(N*.22);
    for(let sy=1;sy<H-1;sy+=1){
      for(let sx=1;sx<W-1;sx+=1){
        const seed=sy*W+sx;if(!mask[seed]||seen[seed])continue;
        let head=0,tail=0,count=0,minX=W,maxX=0,minY=H,maxY=0,sumX=0,sumY=0;
        let tl=null,tr=null,br=null,bl=null,tlv=Infinity,trv=-Infinity,brv=-Infinity,blv=Infinity;
        q[tail++]=seed;seen[seed]=1;
        while(head<tail&&count<=maxPixels){
          const idx=q[head++],x=idx%W,y=(idx/W)|0;if(!mask[idx])continue;
          count++;sumX+=x;sumY+=y;if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;
          const s=x+y,dd=x-y;if(s<tlv){tlv=s;tl={x,y}}if(dd>trv){trv=dd;tr={x,y}}if(s>brv){brv=s;br={x,y}}if(dd<blv){blv=dd;bl={x,y}}
          const ns=[idx-1,idx+1,idx-W,idx+W];
          if(x===0)ns[0]=-1;if(x===W-1)ns[1]=-1;if(y===0)ns[2]=-1;if(y===H-1)ns[3]=-1;
          for(const ni of ns){if(ni>=0&&!seen[ni]&&mask[ni]){seen[ni]=1;q[tail++]=ni}}
        }
        if(count<minPixels||count>maxPixels||!tl||!tr||!br||!bl)continue;
        const bw=maxX-minX+1,bh=maxY-minY+1,bboxArea=bw*bh,fill=count/Math.max(1,bboxArea),frac=count/N;
        if(bw<5||bh<5||bboxArea>N*.25||fill<.16)continue;
        const aspect=bw/bh;if(aspect<.18||aspect>5.8)continue;
        const corners=[tl,tr,br,bl],area=polygonArea(corners);
        if(area<N*.00018)continue;
        const hole=detectHoleCandidate(d,W,H,corners,I);
        const cx=sumX/count,cy=sumY/count;
        const edgePenalty=(minX<2||maxX>W-3||minY<2||maxY>H-3)?.35:0;
        const sizeScore=Math.min(1,Math.sqrt(frac/.025));
        const fillScore=Math.min(1,fill/.62);
        const holeScore=hole?1:0;
        const shapeScore=(aspect>.28&&aspect<3.8)?1:.45;
        const score=sizeScore*.22+fillScore*.24+shapeScore*.18+holeScore*.52-edgePenalty;
        if(score<.42)continue;
        out.push({corners,hole,score,confidence:Math.min(.99,.40+score*.42),center:{x:cx,y:cy},bbox:{minX,maxX,minY,maxY}});
      }
    }
    out.sort((a,b)=>b.score-a.score);
    const picked=[];
    for(const c of out){
      if(picked.length>=2)break;
      let overlaps=false;
      for(const p of picked){
        const d0=dist(c.center,p.center),scale=Math.max(8,Math.sqrt(Math.max(polygonArea(c.corners),polygonArea(p.corners))));
        if(d0<scale*.58){overlaps=true;break}
      }
      if(!overlaps)picked.push(c);
    }
    return picked;
  }
  function avgCornerDistance(a,b){if(!a||!b)return Infinity;let s=0;for(let i=0;i<4;i++)s+=dist(a[i],b[i]);return s/4}
  function smoothCorners(a,b){return a.map((p,i)=>({x:p.x*.68+b[i].x*.32,y:p.y*.68+b[i].y*.32}))}
  function dispatchCal(){window.dispatchEvent(new CustomEvent('calibrationchange',{detail:getCalibration()}))}
  function syncLegacyFields(){
    const first=cal.boards?.[0];
    cal.board=first?.poly||[];cal.hole=first?.hole||null;cal.holeEdge=first?.holeEdge||null;
    cal.boardConfidence=first?.confidence||0;cal.holeConfidence=first?.holeConfidence||0;
  }
  function updateBoardTracks(candidates,W,H){
    const matched=new Set();
    for(const track of boardTracks){
      let best=-1,bestD=Infinity;
      for(let i=0;i<candidates.length;i++){
        if(matched.has(i))continue;
        const d0=avgCornerDistance(track.corners,candidates[i].corners);
        if(d0<bestD){bestD=d0;best=i}
      }
      if(best>=0&&bestD<Math.max(10,W*.11)){
        const c=candidates[best];
        matched.add(best);
        const oldCorners=track.corners.map(p=>({x:p.x,y:p.y}));
        const oldCenter=polyCenter(oldCorners),oldArea=Math.max(1,polygonArea(oldCorners));
        track.corners=smoothCorners(track.corners,c.corners);
        const newCenter=polyCenter(track.corners),newArea=Math.max(1,polygonArea(track.corners));
        const boardScale=Math.max(.72,Math.min(1.38,Math.sqrt(newArea/oldArea)));
        track.confidence=track.confidence*.72+c.confidence*.28;track.hits++;track.misses=0;
        if(c.hole){
          track.hole=track.hole?{x:track.hole.x*.64+c.hole.center.x*.36,y:track.hole.y*.64+c.hole.center.y*.36}:c.hole.center;
          track.holeR=track.holeR?track.holeR*.64+c.hole.r*.36:c.hole.r;
          track.holeConfidence=track.holeConfidence?track.holeConfidence*.72+c.hole.confidence*.28:c.hole.confidence;
          track.holeMisses=0;
        }else if(track.hole){
          track.hole={
            x:newCenter.x+(track.hole.x-oldCenter.x)*boardScale,
            y:newCenter.y+(track.hole.y-oldCenter.y)*boardScale
          };
          track.holeR=Math.max(1,track.holeR*boardScale);
          track.holeConfidence=(track.holeConfidence||.65)*.985;
          track.holeMisses=(track.holeMisses||0)+1;
          if(track.holeMisses>18){track.hole=null;track.holeR=0;track.holeConfidence=0;track.holeMisses=0}
        }
      }else track.misses++;
    }
    for(let i=0;i<candidates.length;i++)if(!matched.has(i)){
      const c=candidates[i];boardTracks.push({corners:c.corners,confidence:c.confidence,hits:1,misses:0,hole:c.hole?.center||null,holeR:c.hole?.r||0,holeConfidence:c.hole?.confidence||0,holeMisses:c.hole?0:1});
    }
    boardTracks=boardTracks.filter(t=>t.misses<42).sort((a,b)=>(b.hits-b.misses)-(a.hits-a.misses)||b.confidence-a.confidence).slice(0,2);
    const locked=boardTracks.filter(t=>t.hits>=2&&t.confidence>.42);
    cal.boards=locked.map(t=>({
      poly:t.corners.map(p=>procToVideo(p,W,H)),
      hole:t.hole?procToVideo(t.hole,W,H):null,
      holeEdge:t.hole&&t.holeR?procToVideo({x:t.hole.x+t.holeR,y:t.hole.y},W,H):null,
      confidence:t.confidence,holeConfidence:t.holeConfidence||0
    }));
    syncLegacyFields();saveCal();dispatchCal();
  }
  function autoDetect(d,W,H){
    const candidates=componentBoards(d,W,H);updateBoardTracks(candidates,W,H);
  }
  function boardsProc(W,H){
    return (cal.boards||[]).map(b=>{
      const poly=(b.poly||[]).map(p=>({x:p.x/video.videoWidth*W,y:p.y/video.videoHeight*H}));
      let hole=null;
      if(b.hole&&b.holeEdge){const h={x:b.hole.x/video.videoWidth*W,y:b.hole.y/video.videoHeight*H},e={x:b.holeEdge.x/video.videoWidth*W,y:b.holeEdge.y/video.videoHeight*H};hole={h,r:dist(h,e)}}
      return{poly,hole,confidence:b.confidence||0};
    }).filter(b=>b.poly.length===4);
  }
  function resetTracking(){
    active=false;quietFrames=0;activeFrames=0;cooldownFrames=0;votesA=0;votesB=0;lastMotionProc=null;maxBagMotion=0;
    lastGray=null;lastTeamMap=null;stableMap=null;beforeMap=null;lastVideoTime=-1;
  }
  function nearestBoard(point,boards){
    if(!point||!boards.length)return null;
    let best=null,bestScore=Infinity;
    for(const b of boards){
      if(pointInPoly(point,b.poly))return b;
      const c=polyCenter(b.poly),scale=Math.max(5,Math.sqrt(polygonArea(b.poly))),score=dist(point,c)/scale;
      if(score<bestScore){bestScore=score;best=b}
    }
    return bestScore<2.3?best:null;
  }
  function analyzeThrow(afterMap,W,H,boards){
    const voteTotal=votesA+votesB,team=votesA>=votesB?'A':'B',teamConfidence=voteTotal?Math.max(votesA,votesB)/voteTotal:.5,id=team==='A'?1:2;
    const base=beforeMap||stableMap||new Uint8Array(afterMap.length);
    let globalAdded=0,gx=0,gy=0;const boardAdds=boards.map(()=>({n:0,sx:0,sy:0}));
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const i=y*W+x;if(afterMap[i]!==id||base[i]===id)continue;
      globalAdded++;gx+=x;gy+=y;
      for(let bi=0;bi<boards.length;bi++)if(pointInPoly({x,y},boards[bi].poly)){boardAdds[bi].n++;boardAdds[bi].sx+=x;boardAdds[bi].sy+=y}
    }
    let targetIndex=-1,bestAdded=0;
    for(let i=0;i<boardAdds.length;i++)if(boardAdds[i].n>bestAdded){bestAdded=boardAdds[i].n;targetIndex=i}
    const globalCentroid=globalAdded?{x:gx/globalAdded,y:gy/globalAdded}:lastMotionProc;
    if(targetIndex<0&&globalCentroid){const b=nearestBoard(globalCentroid,boards);targetIndex=b?boards.indexOf(b):-1}
    const target=targetIndex>=0?boards[targetIndex]:null;
    let result='miss',landingProc=globalCentroid,nearHole=false,minAdded=6;
    if(target){
      const area=Math.max(1,polygonArea(target.poly));minAdded=Math.max(4,Math.round(area*(sensitivity==='high'?.0010:sensitivity==='low'?.0024:.0016)));
      const a=boardAdds[targetIndex];if(a?.n){landingProc={x:a.sx/a.n,y:a.sy/a.n}}
      nearHole=!!(target.hole&&landingProc&&dist(landingProc,target.hole.h)<=target.hole.r*1.7);
      if(target.hole&&lastMotionProc&&dist(lastMotionProc,target.hole.h)<=target.hole.r*1.55)nearHole=true;
      if(nearHole&&bestAdded<minAdded*1.8)result='hole';
      else if(bestAdded>=minAdded||landingProc&&pointInPoly(landingProc,target.poly))result='board';
    }
    const centroid=landingProc?procToVideo(landingProc,W,H):null;
    const settleConfidence=Math.min(.98,.55+Math.min(bestAdded/(Math.max(1,minAdded)*3),1)*.18+Math.min(activeFrames/10,1)*.14+Math.min(maxBagMotion/60,1)*.11);
    return{team,result,confidence:Math.min(.99,settleConfidence*.72+teamConfidence*.28),teamConfidence,centroid,addedPixels:bestAdded,minAdded,nearHole,boardIndex:targetIndex};
  }
  function draw(){
    fitCanvas();const r=overlay.getBoundingClientRect();octx.clearRect(0,0,r.width,r.height);octx.font='13px system-ui';
    const b=displayBox();
    octx.save();octx.lineWidth=3;octx.strokeStyle='#22d07f';octx.setLineDash([10,7]);octx.strokeRect(b.ox+2,b.oy+2,Math.max(0,b.w-4),Math.max(0,b.h-4));octx.setLineDash([]);octx.fillStyle='#22d07f';octx.fillText('FULL YARD VISION',b.ox+10,b.oy+20);octx.restore();
    (cal.boards||[]).forEach((board,idx)=>{
      if(board.poly?.length!==4)return;
      octx.lineWidth=4;octx.strokeStyle='#35cfff';octx.fillStyle='#35cfff';octx.beginPath();
      board.poly.forEach((p,i)=>{const q=videoToDisp(p);i?octx.lineTo(q.x,q.y):octx.moveTo(q.x,q.y)});octx.closePath();octx.stroke();
      const q=videoToDisp(board.poly[0]);octx.fillText(`BOARD ${idx+1}`,q.x+8,q.y-8);
      if(board.hole&&board.holeEdge){const h=videoToDisp(board.hole),e=videoToDisp(board.holeEdge),rr=Math.hypot(e.x-h.x,e.y-h.y);octx.strokeStyle='#ffd166';octx.lineWidth=4;octx.beginPath();octx.arc(h.x,h.y,rr,0,Math.PI*2);octx.stroke();octx.fillStyle='#ffd166';octx.fillText(`HOLE ${idx+1} TRACKED`,h.x+rr+5,h.y)}
    });
    if(lastCentroid){const c=videoToDisp(lastCentroid);octx.strokeStyle=lastTeam==='B'?'#ff4458':'#2d8cff';octx.lineWidth=4;octx.beginPath();octx.arc(c.x,c.y,18,0,Math.PI*2);octx.stroke();octx.fillStyle='#fff';octx.fillText(lastTeam==='B'?'RED BAG':'BLUE BAG',c.x+21,c.y)}
  }
  function processFrame(ts){
    if(!running)return;
    if(lastT){const inst=1000/Math.max(1,ts-lastT);fps=fps*.9+inst*.1}lastT=ts;
    if(video?.readyState>=2&&video.videoWidth){
      const vt=video.currentTime;
      if(vt!==lastVideoTime){
        lastVideoTime=vt;frameNo++;
        const W=288,H=Math.max(96,Math.round(288*video.videoHeight/video.videoWidth));proc.width=W;proc.height=H;pctx.drawImage(video,0,0,W,H);
        const d=pctx.getImageData(0,0,W,H).data;
        if(frameNo%6===0||!(cal.boards?.length))autoDetect(d,W,H);
        const gray=new Uint8Array(W*H),teamMap=new Uint8Array(W*H),boards=boardsProc(W,H);
        let changedColor=0,sx=0,sy=0,fa=0,fb=0;
        for(let y=0;y<H;y++)for(let x=0;x<W;x++){
          const i=y*W+x,j=i*4,r=d[j],g=d[j+1],bl=d[j+2];gray[i]=(r*3+g*6+bl)/10;const t=pixelTeam(r,g,bl);teamMap[i]=t;
          if(lastGray){const dv=Math.abs(gray[i]-lastGray[i]);if(dv>16){const mt=t||(lastTeamMap?lastTeamMap[i]:0);if(mt){changedColor++;sx+=x;sy+=y;if(mt===1)fa++;else fb++}}}
        }
        const motion=Math.min(1,changedColor/(sensitivity==='high'?42:sensitivity==='low'?82:58));
        const minMove=sensitivity==='high'?6:sensitivity==='low'?14:9,moving=changedColor>=minMove;
        if(cooldownFrames>0)cooldownFrames--;
        if(auto&&boards.length){
          if(moving&&cooldownFrames===0){
            if(!active){active=true;quietFrames=0;activeFrames=0;beforeMap=cloneMap(stableMap||lastTeamMap||teamMap);votesA=0;votesB=0;lastMotionProc=null;maxBagMotion=0}
            activeFrames++;quietFrames=0;votesA+=fa;votesB+=fb;maxBagMotion=Math.max(maxBagMotion,changedColor);
            const c={x:sx/changedColor,y:sy/changedColor};lastMotionProc=c;lastCentroid=procToVideo(c,W,H);lastTeam=votesA>=votesB?'A':'B';
          }else if(active){
            quietFrames++;
            if(quietFrames>=9){active=false;quietFrames=0;if(activeFrames>=2){const e=analyzeThrow(teamMap,W,H,boards);if(onThrow)onThrow(e)}stableMap=cloneMap(teamMap);beforeMap=null;cooldownFrames=7;activeFrames=0;votesA=0;votesB=0;maxBagMotion=0}
          }else if(cooldownFrames===0)stableMap=cloneMap(teamMap);
        }else{active=false;quietFrames=0;stableMap=cloneMap(teamMap)}
        lastGray=gray;lastTeamMap=teamMap;
        if(onMetrics)onMetrics({motion,fps,centroid:lastCentroid,team:lastTeam,active,changedColor,boardReady:boards.length>0,holeReady:boards.some(b=>!!b.hole),boardCount:boards.length,holeCount:boards.filter(b=>!!b.hole).length,boardConfidence:Math.max(0,...(cal.boards||[]).map(b=>b.confidence||0)),holeConfidence:Math.max(0,...(cal.boards||[]).map(b=>b.holeConfidence||0)),fullYard:true,holeTracking:true});
      }
      draw();
    }
    requestAnimationFrame(processFrame);
  }
  function init(v,c,throwCb,metricsCb){video=v;overlay=c;octx=c.getContext('2d');proc=document.createElement('canvas');pctx=proc.getContext('2d',{willReadFrequently:true});onThrow=throwCb;onMetrics=metricsCb;resetTracking();if(!running){running=true;requestAnimationFrame(processFrame)}}
  function setAuto(v){auto=!!v;resetTracking()}
  function setSensitivity(v){sensitivity=['high','normal','low'].includes(v)?v:'high';resetTracking()}
  function rescan(){cal={boards:[],board:[],hole:null,holeEdge:null,boardConfidence:0,holeConfidence:0};boardTracks=[];saveCal();resetTracking();dispatchCal()}
  function clear(){rescan()}
  function getCalibration(){return JSON.parse(JSON.stringify(cal))}
  function saveCal(){try{localStorage.setItem('cornhole-v7-1-yard-cal',JSON.stringify(cal))}catch{}}
  function loadCal(){
    try{
      const x=JSON.parse(localStorage.getItem('cornhole-v7-1-yard-cal'));
      if(x)cal=x;else{const old=JSON.parse(localStorage.getItem('cornhole-v7-yard-cal'));if(old?.board?.length===4)cal={boards:[{poly:old.board,hole:old.hole||null,holeEdge:old.holeEdge||null,confidence:old.boardConfidence||.65,holeConfidence:old.holeConfidence||.65}],...old}}
    }catch{}
    if(!Array.isArray(cal.boards))cal.boards=[];syncLegacyFields();return getCalibration();
  }
  function snapshot(){const c=document.createElement('canvas');c.width=320;c.height=Math.round(320*video.videoHeight/video.videoWidth);c.getContext('2d').drawImage(video,0,0,c.width,c.height);return c.toDataURL('image/jpeg',.72)}
  return{init,setAuto,setSensitivity,rescan,clear,getCalibration,loadCal,snapshot};
})();