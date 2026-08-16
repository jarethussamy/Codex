const Vision = (() => {
  let video, overlay, octx, proc, pctx, running=false, auto=false;
  let cal={board:[],hole:null,holeEdge:null,boardConfidence:0,holeConfidence:0};
  let autoCalibrate=true, sensitivity='high';
  let lastT=0, fps=0, lastVideoTime=-1, frameNo=0;
  let lastGray=null, lastTeamMap=null, stableMap=null, beforeMap=null;
  let active=false, quietFrames=0, activeFrames=0, cooldownFrames=0;
  let lastCentroid=null, lastTeam=null, onThrow=null, onMetrics=null;
  let votesA=0, votesB=0, minHolePx=Infinity, lastMotionProc=null, maxBagMotion=0;
  let boardCandidate=null, boardStableFrames=0, holeCandidate=null, holeStableFrames=0, boardMisses=0;

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
  function pointInPoly(p,poly){
    let c=false;
    for(let i=0,j=poly.length-1;i<poly.length;j=i++){
      if(((poly[i].y>p.y)!=(poly[j].y>p.y)) &&
         (p.x<(poly[j].x-poly[i].x)*(p.y-poly[i].y)/(poly[j].y-poly[i].y+1e-9)+poly[i].x)) c=!c;
    }
    return c;
  }
  function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
  function polygonArea(poly){let a=0;for(let i=0,j=poly.length-1;i<poly.length;j=i++)a+=poly[j].x*poly[i].y-poly[i].x*poly[j].y;return Math.abs(a)/2}
  function cloneMap(m){return m?new Uint8Array(m):null}
  function procToVideo(p,W,H){return{x:p.x/W*video.videoWidth,y:p.y/H*video.videoHeight}}
  function boardProc(W,H){return (cal.board||[]).map(p=>({x:p.x/video.videoWidth*W,y:p.y/video.videoHeight*H}))}
  function holeProc(W,H){
    if(!cal.hole||!cal.holeEdge)return null;
    const h={x:cal.hole.x/video.videoWidth*W,y:cal.hole.y/video.videoHeight*H};
    const e={x:cal.holeEdge.x/video.videoWidth*W,y:cal.holeEdge.y/video.videoHeight*H};
    return {h,r:dist(h,e)};
  }
  function playBBox(poly,W,H){
    if(poly.length!==4)return {x0:0,y0:0,x1:W-1,y1:H-1};
    const xs=poly.map(p=>p.x), ys=poly.map(p=>p.y), minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
    const px=(maxX-minX)*.62, py=(maxY-minY)*.46;
    return {x0:Math.max(0,minX-px),y0:Math.max(0,minY-py),x1:Math.min(W-1,maxX+px),y1:Math.min(H-1,maxY+py)};
  }
  function rgbToHsv(r,g,b){
    r/=255; g/=255; b/=255;
    const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
    let h=0;
    if(d){ if(max===r)h=60*(((g-b)/d)%6); else if(max===g)h=60*((b-r)/d+2); else h=60*((r-g)/d+4); }
    if(h<0)h+=360;
    return {h,s:max?d/max:0,v:max};
  }
  function pixelTeam(r,g,b){
    const {h,s,v}=rgbToHsv(r,g,b);
    if(s<.30||v<.14)return 0;
    const blue=h>=185&&h<=255&&b>=r*1.08&&b>=g*1.02&&(b-Math.min(r,g)>18);
    const red=(h<=18||h>=344)&&r>=g*1.12&&r>=b*1.06&&(r-Math.min(g,b)>22);
    return blue?1:red?2:0;
  }
  function boardColorMatch(r,g,b,sr,sg,sb){
    const lum=(r+g+b)/3, sl=(sr+sg+sb)/3;
    if(Math.abs(lum-sl)>64)return false;
    const sum=r+g+b+1, ss=sr+sg+sb+1;
    const chroma=Math.hypot(r/sum-sr/ss,g/sum-sg/ss,b/sum-sb/ss);
    return chroma<.178;
  }
  function regionFromSeed(d,W,H,sx,sy){
    const si=(sy*W+sx)*4, sr=d[si], sg=d[si+1], sb=d[si+2], sl=(sr+sg+sb)/3;
    if(sl<36||sl>245||pixelTeam(sr,sg,sb))return null;
    const seen=new Uint8Array(W*H), q=new Int32Array(W*H);
    let head=0, tail=0; q[tail++]=sy*W+sx; seen[sy*W+sx]=1;
    let count=0,minX=W,maxX=0,minY=H,maxY=0,sumX=0,sumY=0;
    let tl=null,tr=null,br=null,bl=null,tlv=Infinity,trv=-Infinity,brv=-Infinity,blv=Infinity;
    while(head<tail && count<W*H*.75){
      const idx=q[head++], x=idx%W, y=(idx/W)|0, j=idx*4, r=d[j], g=d[j+1], b=d[j+2];
      if(!boardColorMatch(r,g,b,sr,sg,sb))continue;
      count++; sumX+=x; sumY+=y; if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y;
      const s=x+y, dd=x-y;
      if(s<tlv){tlv=s; tl={x,y}} if(dd>trv){trv=dd; tr={x,y}} if(s>brv){brv=s; br={x,y}} if(dd<blv){blv=dd; bl={x,y}}
      const n1=idx-1,n2=idx+1,n3=idx-W,n4=idx+W;
      if(x>0&&!seen[n1]){seen[n1]=1;q[tail++]=n1}
      if(x<W-1&&!seen[n2]){seen[n2]=1;q[tail++]=n2}
      if(y>0&&!seen[n3]){seen[n3]=1;q[tail++]=n3}
      if(y<H-1&&!seen[n4]){seen[n4]=1;q[tail++]=n4}
    }
    if(count<220)return null;
    const bw=maxX-minX+1,bh=maxY-minY+1,frac=count/(W*H),bboxFrac=bw*bh/(W*H),cx=sumX/count,cy=sumY/count;
    if(frac<.008||frac>.62||bw<W*.07||bh<H*.08||bboxFrac>.82)return null;
    const centerPenalty=Math.hypot((cx-W*.55)/(W*.65),(cy-H*.58)/(H*.62));
    const fill=count/Math.max(1,bw*bh),aspect=bh/Math.max(1,bw),aspectScore=aspect>.22&&aspect<4.8?1:.28;
    const tallScore=Math.min(1,bh/(H*.45));
    const score=frac*6.0+fill*.85+Math.max(0,1-centerPenalty)*.52+tallScore*.42+aspectScore*.26;
    const corners=[tl,tr,br,bl];
    if(corners.some(x=>!x))return null;
    return {score,corners,count,bbox:{minX,maxX,minY,maxY},fill};
  }
  function detectBoardCandidate(d,W,H){
    const seeds=[];
    for(const fy of [.18,.28,.38,.48,.58,.68,.78,.88]){
      for(const fx of [.12,.22,.34,.46,.58,.70,.82]) seeds.push([Math.round(W*fx),Math.round(H*fy)]);
    }
    let best=null;
    for(const [x,y] of seeds){
      const r=regionFromSeed(d,W,H,x,y);
      if(r&&(!best||r.score>best.score))best=r;
    }
    if(!best||best.score<.38)return null;
    const p=best.corners, area=polygonArea(p);
    if(area<W*H*.006)return null;
    return {corners:p,confidence:Math.min(.98,.42+best.score*.24)};
  }
  function avgCornerDistance(a,b){if(!a||!b)return Infinity;let s=0;for(let i=0;i<4;i++)s+=dist(a[i],b[i]);return s/4}
  function smoothCorners(a,b){return a.map((p,i)=>({x:p.x*.7+b[i].x*.3,y:p.y*.7+b[i].y*.3}))}
  function dispatchCal(){window.dispatchEvent(new CustomEvent('calibrationchange',{detail:getCalibration()}))}
  function lockBoard(candidate,W,H){
    if(!candidate){
      if(cal.board.length===4){ boardMisses++; if(boardMisses>18){ cal.board=[]; cal.hole=null; cal.holeEdge=null; cal.boardConfidence=0; cal.holeConfidence=0; autoCalibrate=true; saveCal(); dispatchCal(); } }
      boardStableFrames=Math.max(0,boardStableFrames-1);
      return false;
    }
    boardMisses=0;
    if(boardCandidate&&avgCornerDistance(boardCandidate.corners,candidate.corners)<Math.max(10,W*.085)){
      boardCandidate={corners:smoothCorners(boardCandidate.corners,candidate.corners),confidence:(boardCandidate.confidence+candidate.confidence)/2};
      boardStableFrames++;
    } else { boardCandidate=candidate; boardStableFrames=1; }
    if(boardStableFrames>=3){
      cal.board=boardCandidate.corners.map(p=>procToVideo(p,W,H));
      cal.boardConfidence=boardCandidate.confidence;
      saveCal(); dispatchCal();
      return true;
    }
    return false;
  }
  function integralGray(d,W,H){
    const I=new Float64Array((W+1)*(H+1));
    for(let y=1;y<=H;y++){
      let row=0;
      for(let x=1;x<=W;x++){
        const j=((y-1)*W+(x-1))*4;
        row+=(d[j]*3+d[j+1]*6+d[j+2])/10;
        I[y*(W+1)+x]=I[(y-1)*(W+1)+x]+row;
      }
    }
    return I;
  }
  function boxMean(I,W,H,cx,cy,r){
    const x0=Math.max(0,Math.floor(cx-r)), x1=Math.min(W-1,Math.ceil(cx+r)), y0=Math.max(0,Math.floor(cy-r)), y1=Math.min(H-1,Math.ceil(cy+r));
    const S=W+1, a=I[y0*S+x0], b=I[y0*S+x1+1], c=I[(y1+1)*S+x0], d=I[(y1+1)*S+x1+1], n=(x1-x0+1)*(y1-y0+1);
    return (d-b-c+a)/Math.max(1,n);
  }
  function detectHoleCandidate(d,W,H,poly){
    if(poly.length!==4)return null;
    const xs=poly.map(p=>p.x), ys=poly.map(p=>p.y), minX=Math.max(0,Math.floor(Math.min(...xs))), maxX=Math.min(W-1,Math.ceil(Math.max(...xs))), minY=Math.max(0,Math.floor(Math.min(...ys))), maxY=Math.min(H-1,Math.ceil(Math.max(...ys)));
    const topW=Math.max(10,dist(poly[0],poly[1])), botW=Math.max(10,dist(poly[3],poly[2])), expectedR=Math.max(2.6,Math.min(16,(topW*.72+botW*.28)/8.4));
    const I=integralGray(d,W,H); let best=null; const yLimit=minY+(maxY-minY)*.72;
    for(let y=minY+2;y<=yLimit;y+=2){
      for(let x=minX+2;x<=maxX-2;x+=2){
        if(!pointInPoly({x,y},poly))continue;
        const inner=boxMean(I,W,H,x,y,expectedR*.58), outer=boxMean(I,W,H,x,y,expectedR*1.55), score=(outer-inner)+(118-inner)*.055;
        if(!best||score>best.score)best={x,y,r:expectedR,score,inner,outer};
      }
    }
    if(!best||best.score<10.8||best.inner>132)return null;
    return {center:{x:best.x,y:best.y},r:best.r,confidence:Math.min(.98,.45+(best.score-9.5)/38)};
  }
  function lockHole(candidate,W,H){
    if(!candidate){ holeStableFrames=Math.max(0,holeStableFrames-1); return false; }
    if(holeCandidate&&dist(holeCandidate.center,candidate.center)<Math.max(5,W*.035)){
      holeCandidate={center:{x:holeCandidate.center.x*.72+candidate.center.x*.28,y:holeCandidate.center.y*.72+candidate.center.y*.28},r:holeCandidate.r*.72+candidate.r*.28,confidence:(holeCandidate.confidence+candidate.confidence)/2};
      holeStableFrames++;
    } else { holeCandidate=candidate; holeStableFrames=1; }
    if(holeStableFrames>=2){
      cal.hole=procToVideo(holeCandidate.center,W,H);
      cal.holeEdge=procToVideo({x:holeCandidate.center.x+holeCandidate.r,y:holeCandidate.center.y},W,H);
      cal.holeConfidence=holeCandidate.confidence;
      saveCal(); dispatchCal();
      return true;
    }
    return false;
  }
  function autoDetect(d,W,H){
    if(!autoCalibrate && cal.board.length===4 && cal.hole && cal.holeEdge) return;
    const b=detectBoardCandidate(d,W,H);
    const lockedBoard=lockBoard(b,W,H);
    const useBoard=lockedBoard || cal.board.length===4;
    if(useBoard){
      const p=boardProc(W,H), h=detectHoleCandidate(d,W,H,p);
      lockHole(h,W,H);
    }
    if(cal.board.length===4 && cal.hole && cal.holeEdge) autoCalibrate=false;
  }
  function resetTracking(){
    active=false; quietFrames=0; activeFrames=0; cooldownFrames=0; votesA=0; votesB=0; minHolePx=Infinity; lastMotionProc=null; maxBagMotion=0;
    lastGray=null; lastTeamMap=null; stableMap=null; beforeMap=null; lastVideoTime=-1;
  }
  function analyzeThrow(afterMap,W,H,poly,hole){
    const voteTotal=votesA+votesB, team=votesA>=votesB?'A':'B', teamConfidence=voteTotal?Math.max(votesA,votesB)/voteTotal:.5, id=team==='A'?1:2;
    const base=beforeMap||stableMap||new Uint8Array(afterMap.length);
    let added=0,sx=0,sy=0;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const i=y*W+x;
      if(afterMap[i]===id && base[i]!==id && pointInPoly({x,y},poly)){ added++; sx+=x; sy+=y; }
    }
    const area=Math.max(1,polygonArea(poly)), minAdded=Math.max(5,Math.round(area*(sensitivity==='high'?.0011:sensitivity==='low'?.0025:.0017)));
    const addedProc=added?{x:sx/added,y:sy/added}:null, landingProc=addedProc||lastMotionProc, nearHole=!!hole&&minHolePx<=hole.r*1.82, landedOnBoard=!!addedProc&&added>=minAdded&&pointInPoly(addedProc,poly);
    let result='miss';
    if(nearHole&&added<minAdded*1.55)result='hole';
    else if(landedOnBoard)result='board';
    else if(landingProc&&pointInPoly(landingProc,poly)&&!nearHole&&maxBagMotion>0)result='board';
    const centroid=landingProc?procToVideo(landingProc,W,H):null;
    const settleConfidence=Math.min(.98,.56+Math.min(added/(minAdded*3),1)*.18+Math.min(activeFrames/10,1)*.14+Math.min(maxBagMotion/45,1)*.10);
    return {team,result,confidence:Math.min(.99,settleConfidence*.72+teamConfidence*.28),teamConfidence,centroid,addedPixels:added,minAdded,nearHole};
  }
  function draw(){
    fitCanvas(); const r=overlay.getBoundingClientRect(); octx.clearRect(0,0,r.width,r.height); octx.font='13px system-ui';
    if(cal.board.length===4){
      octx.lineWidth=4; octx.strokeStyle='#22d07f'; octx.fillStyle='#22d07f'; octx.beginPath();
      cal.board.forEach((p,i)=>{const q=videoToDisp(p); i?octx.lineTo(q.x,q.y):octx.moveTo(q.x,q.y)}); octx.closePath(); octx.stroke();
      const q=videoToDisp(cal.board[0]); octx.fillText('BOARD TRACKED',q.x+8,q.y-8);
    }
    if(cal.hole&&cal.holeEdge){
      const h=videoToDisp(cal.hole), e=videoToDisp(cal.holeEdge), rr=Math.hypot(e.x-h.x,e.y-h.y);
      octx.strokeStyle='#ffd166'; octx.lineWidth=4; octx.beginPath(); octx.arc(h.x,h.y,rr,0,Math.PI*2); octx.stroke();
      octx.fillStyle='#ffd166'; octx.fillText('HOLE',h.x+rr+6,h.y);
    }
    if(lastCentroid){
      const c=videoToDisp(lastCentroid); octx.strokeStyle=lastTeam==='B'?'#ff4458':'#2d8cff'; octx.lineWidth=4; octx.beginPath(); octx.arc(c.x,c.y,18,0,Math.PI*2); octx.stroke();
      octx.fillStyle='#fff'; octx.fillText(lastTeam==='B'?'RED':'BLUE',c.x+21,c.y);
    }
  }
  function processFrame(ts){
    if(!running)return;
    if(lastT){const inst=1000/Math.max(1,ts-lastT);fps=fps*.9+inst*.1} lastT=ts;
    if(video?.readyState>=2&&video.videoWidth){
      const vt=video.currentTime;
      if(vt!==lastVideoTime){
        lastVideoTime=vt; frameNo++;
        const W=260,H=Math.max(90,Math.round(260*video.videoHeight/video.videoWidth));
        proc.width=W; proc.height=H; pctx.drawImage(video,0,0,W,H);
        const d=pctx.getImageData(0,0,W,H).data;
        if(frameNo%8===0 || autoCalibrate) autoDetect(d,W,H);
        const gray=new Uint8Array(W*H), teamMap=new Uint8Array(W*H), poly=boardProc(W,H), hole=holeProc(W,H), box=playBBox(poly,W,H);
        let changedColor=0,sx=0,sy=0,fa=0,fb=0;
        for(let y=0;y<H;y++)for(let x=0;x<W;x++){
          const i=y*W+x,j=i*4,r=d[j],g=d[j+1],b=d[j+2];
          gray[i]=(r*3+g*6+b)/10;
          const t=pixelTeam(r,g,b); teamMap[i]=t;
          if(lastGray&&x>=box.x0&&x<=box.x1&&y>=box.y0&&y<=box.y1){
            const dv=Math.abs(gray[i]-lastGray[i]);
            if(dv>18){
              const mt=t||(lastTeamMap?lastTeamMap[i]:0);
              if(mt){ changedColor++; sx+=x; sy+=y; if(mt===1)fa++; else fb++; }
            }
          }
        }
        const motion=Math.min(1,changedColor/(sensitivity==='high'?34:sensitivity==='low'?64:48));
        const minMove=sensitivity==='high'?5:sensitivity==='low'?11:8;
        const moving=changedColor>=minMove;
        if(cooldownFrames>0)cooldownFrames--;
        if(auto&&poly.length===4&&hole){
          if(moving&&cooldownFrames===0){
            if(!active){ active=true; quietFrames=0; activeFrames=0; beforeMap=cloneMap(stableMap||lastTeamMap||teamMap); votesA=0; votesB=0; minHolePx=Infinity; lastMotionProc=null; maxBagMotion=0; }
            activeFrames++; quietFrames=0; votesA+=fa; votesB+=fb; maxBagMotion=Math.max(maxBagMotion,changedColor);
            const c={x:sx/changedColor,y:sy/changedColor}; lastMotionProc=c; lastCentroid=procToVideo(c,W,H); lastTeam=votesA>=votesB?'A':'B';
            if(hole)minHolePx=Math.min(minHolePx,dist(c,hole.h));
          } else if(active){
            quietFrames++;
            if(quietFrames>=9){
              active=false; quietFrames=0;
              if(activeFrames>=2){ const e=analyzeThrow(teamMap,W,H,poly,hole); if(onThrow)onThrow(e); }
              stableMap=cloneMap(teamMap); beforeMap=null; cooldownFrames=7; activeFrames=0; votesA=0; votesB=0; minHolePx=Infinity; maxBagMotion=0;
            }
          } else if(cooldownFrames===0){ stableMap=cloneMap(teamMap); }
        } else { active=false; quietFrames=0; stableMap=cloneMap(teamMap); }
        lastGray=gray; lastTeamMap=teamMap;
        if(onMetrics)onMetrics({motion,fps,centroid:lastCentroid,team:lastTeam,active,changedColor,boardReady:cal.board.length===4,holeReady:!!(cal.hole&&cal.holeEdge),boardConfidence:cal.boardConfidence||0,holeConfidence:cal.holeConfidence||0,autoCalibrate});
      }
      draw();
    }
    requestAnimationFrame(processFrame);
  }
  function init(v,c,throwCb,metricsCb){
    video=v; overlay=c; octx=c.getContext('2d'); proc=document.createElement('canvas'); pctx=proc.getContext('2d',{willReadFrequently:true}); onThrow=throwCb; onMetrics=metricsCb; resetTracking();
    if(!running){ running=true; requestAnimationFrame(processFrame); }
  }
  function setAuto(v){ auto=!!v; resetTracking(); }
  function setSensitivity(v){ sensitivity=['high','normal','low'].includes(v)?v:'high'; resetTracking(); }
  function rescan(){ cal={board:[],hole:null,holeEdge:null,boardConfidence:0,holeConfidence:0}; boardCandidate=null; boardStableFrames=0; holeCandidate=null; holeStableFrames=0; boardMisses=0; autoCalibrate=true; saveCal(); resetTracking(); dispatchCal(); }
  function clear(){ rescan(); }
  function getCalibration(){ return JSON.parse(JSON.stringify(cal)); }
  function saveCal(){ try{localStorage.setItem('cornhole-v7-yard-cal',JSON.stringify(cal))}catch{} }
  function loadCal(){ try{const x=JSON.parse(localStorage.getItem('cornhole-v7-yard-cal')); if(x)cal=x}catch{} autoCalibrate=!(cal.board?.length===4&&cal.hole&&cal.holeEdge); return getCalibration(); }
  function snapshot(){ const c=document.createElement('canvas'); c.width=320; c.height=Math.round(320*video.videoHeight/video.videoWidth); c.getContext('2d').drawImage(video,0,0,c.width,c.height); return c.toDataURL('image/jpeg',.72); }
  return {init,setAuto,setSensitivity,rescan,clear,getCalibration,loadCal,snapshot};
})();
