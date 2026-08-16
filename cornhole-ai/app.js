/* Cornhole AI Ref V9 — Accuracy + Zero-Touch Play */
const App=(()=>{
  const $=id=>document.getElementById(id);
  const isAndroid=/Android/i.test(navigator.userAgent);
  let stream=null,facing='environment',auto=false,selectedDeviceId='',previewLoop=0,imageCapture=null,canvasPreview=false;
  let frameCount=0,frameWatchTimer=0,installPrompt=null,audioCtx=null;
  let activeBoardIndex=0,autoRoundEnabled=true,roundEnding=false,lastAcceptedAt=0;
  let recentLandings=[],collectionCandidate=false,collectionHighFrames=0,collectionQuietFrames=0,collectionStartedAt=0;
  let lastMetrics={motion:0,changedColor:0,boardCount:0,holeCount:0};
  let duplicateBlocked=0,overlapAccepted=0;
  let game={A:0,B:0,raw:{A:0,B:0},throws:0,round:1,history:[],lastDecision:null,firstTeam:'A'};
  let cal=Vision.loadCal();

  const teamName=t=>t==='A'?'Team Blue':'Team Red';
  const teamCaps=t=>t==='A'?'TEAM BLUE':'TEAM RED';
  const boardCount=()=>Array.isArray(cal.boards)?cal.boards.length:(cal.board?.length===4?1:0);
  const holeCount=()=>Array.isArray(cal.boards)?cal.boards.filter(b=>b.hole&&b.holeEdge).length:(cal.hole&&cal.holeEdge?1:0);
  const expectedTeam=()=>game.throws%2===0?game.firstTeam:(game.firstTeam==='A'?'B':'A');
  const clone=v=>JSON.parse(JSON.stringify(v));

  function setActiveBoard(index,announce=false){
    const bc=Math.max(1,boardCount());
    activeBoardIndex=bc>1?Math.max(0,Math.min(bc-1,Number(index)||0)):0;
    window.__yardActiveBoard=activeBoardIndex;
    if($('activeBoardLabel'))$('activeBoardLabel').textContent=`🎯 Board ${activeBoardIndex+1} active`;
    if($('activeBoardSelect'))$('activeBoardSelect').value=String(activeBoardIndex);
    if(announce)say(`Board ${activeBoardIndex+1} is active`);
    render();
  }
  window.__yardActiveBoard=0;

  function ensureAudio(){try{const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return null;if(!audioCtx)audioCtx=new AC();if(audioCtx.state==='suspended')audioCtx.resume();return audioCtx}catch{return null}}
  function cowbellHit(offset=0,accent=1){
    const ctx=ensureAudio();if(!ctx)return;const t=ctx.currentTime+offset,g=ctx.createGain(),bp=ctx.createBiquadFilter();
    bp.type='bandpass';bp.frequency.setValueAtTime(1200,t);bp.Q.setValueAtTime(1.05,t);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.24*accent,t+.008);g.gain.exponentialRampToValueAtTime(.0001,t+.27);g.connect(bp);bp.connect(ctx.destination);
    [560,820].forEach((f,i)=>{const o=ctx.createOscillator();o.type='square';o.frequency.setValueAtTime(f,t);o.frequency.exponentialRampToValueAtTime(f*(i?.97:.94),t+.21);o.connect(g);o.start(t);o.stop(t+.28)});
  }
  function playCowbell(points){if(points<=0)return;ensureAudio();const hits=points>=3?3:1;for(let i=0;i<hits;i++)cowbellHit(i*.16,i===0?1:.86)}

  function setDiag(id,state,text){const el=$(id);if(!el)return;el.className='diagItem '+state;el.querySelector('.diagValue').textContent=text}
  function say(t){if($('call'))$('call').textContent=t;if('speechSynthesis'in window){speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(t);u.rate=1.03;speechSynthesis.speak(u)}}
  function log(t){const d=document.createElement('div');d.textContent=new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})+' · '+t;$('log')?.prepend(d)}
  function dispatch(name,detail){window.dispatchEvent(new CustomEvent(name,{detail}))}

  function stateSnapshot(){
    return {
      A:game.A,B:game.B,raw:{...game.raw},throws:game.throws,round:game.round,lastDecision:game.lastDecision,
      firstTeam:game.firstTeam,w:$('winner')?.textContent||'',call:$('call')?.textContent||'',
      activeBoardIndex,recentLandings:clone(recentLandings),lastAcceptedAt
    };
  }
  function snapState(){game.history.push(JSON.stringify(stateSnapshot()))}

  function liveScores(){
    return{
      A:game.A+Math.max(0,game.raw.A-game.raw.B),
      B:game.B+Math.max(0,game.raw.B-game.raw.A)
    };
  }
  function render(){
    const live=liveScores();
    if($('sa'))$('sa').textContent=live.A;if($('sb'))$('sb').textContent=live.B;
    if($('ra'))$('ra').textContent=game.raw.A;if($('rb'))$('rb').textContent=game.raw.B;
    if($('tc'))$('tc').textContent=game.throws;if($('rn'))$('rn').textContent=game.round;
    if($('nextThrow'))$('nextThrow').textContent=`NEXT: ${teamCaps(expectedTeam())}`;
    if($('firstTeam')&&$('firstTeam').value!==game.firstTeam)$('firstTeam').value=game.firstTeam;

    const bc=boardCount(),hc=holeCount(),boardReady=bc>0,holeReady=hc>0;
    $('s1')?.classList.toggle('done',boardReady);$('s2')?.classList.toggle('done',holeReady);
    if($('boardStatus'))$('boardStatus').textContent=boardReady?`${bc} board${bc===1?'':'s'} tracked · Board ${activeBoardIndex+1} active`:'Scanning whole yard…';
    if($('holeStatus'))$('holeStatus').textContent=holeReady?`${hc} hole${hc===1?'':'s'} tracked`:boardReady?'Following board; scanning for hole…':'Waiting for board…';
    const mediaReady=!!stream||!!$('cam')?.getAttribute('src');
    if($('autoBtn')){$('autoBtn').disabled=!(boardReady&&holeReady&&mediaReady);$('autoBtn').textContent=auto?'⏸ Disable Auto Ref':'▶ Enable Auto Ref'}
    if($('sys'))$('sys').textContent=auto?'AUTO REF LIVE':stream?(frameCount?'CAMERA LIVE':'CAMERA STARTING'):(window.isSecureContext?'READY':'HTTPS REQUIRED');
    if($('activeBoardLabel'))$('activeBoardLabel').textContent=`🎯 Board ${activeBoardIndex+1} active`;
    if($('guardLabel'))$('guardLabel').textContent=`🛡️ Duplicate guard${duplicateBlocked?` · ${duplicateBlocked} blocked`:''}`;
    if($('overlapLabel'))$('overlapLabel').textContent=`🧠 Overlap tracking${overlapAccepted?` · ${overlapAccepted} preserved`:''}`;
    if($('autoRoundBtn'))$('autoRoundBtn').textContent=autoRoundEnabled?'🔄 Auto Round ON':'🔄 Auto Round OFF';
  }

  function landingDistance(a,b){
    if(!a?.centroid||!b?.centroid)return Infinity;
    return Math.hypot(a.centroid.x-b.centroid.x,a.centroid.y-b.centroid.y);
  }
  function duplicateCheck(e,team){
    const now=Date.now();
    if(lastAcceptedAt&&now-lastAcceptedAt<650)return{duplicate:true,reason:'throw cooldown'};
    const candidate={team,result:e.result,boardIndex:e.boardIndex,centroid:e.centroid,t:now};
    const vw=$('cam')?.videoWidth||1280,near=Math.max(42,vw*.045);
    const prior=[...recentLandings].reverse().find(x=>x.team===team&&x.result===e.result&&(x.boardIndex===e.boardIndex||e.boardIndex<0||x.boardIndex<0)&&now-x.t<1400&&landingDistance(x,candidate)<near);
    if(prior)return{duplicate:true,reason:'same bag re-settled'};
    const overlap=[...recentLandings].reverse().find(x=>x.team===team&&x.boardIndex===e.boardIndex&&e.result==='board'&&now-x.t>=1400&&landingDistance(x,candidate)<near);
    return{duplicate:false,overlap:!!overlap,candidate};
  }

  function rememberLanding(e,team,overlap){
    const rec={team,result:e.result,boardIndex:e.boardIndex,centroid:e.centroid?{...e.centroid}:null,t:Date.now(),overlap:!!overlap};
    recentLandings.push(rec);if(recentLandings.length>12)recentLandings.shift();
    if(overlap){overlapAccepted++;log(`Overlap-safe tracking: new ${teamName(team)} bag accepted near an existing bag`)}
  }

  function addThrow(team,result,source='MANUAL',confidence=1,snapshot=null,centroid=null,boardIndex=-1){
    if($('winner')?.textContent||roundEnding)return;
    snapState();
    const p=result==='hole'?3:result==='board'?1:0;
    game.raw[team]+=p;game.throws++;lastAcceptedAt=Date.now();
    collectionCandidate=false;collectionHighFrames=0;collectionQuietFrames=0;
    const name=teamName(team);
    game.lastDecision={team,result,source,confidence,snapshot,centroid,points:p,boardIndex};
    if($('thumb'))$('thumb').src=snapshot||'';
    if($('reviewText'))$('reviewText').textContent=`${source}: ${name} → ${result.toUpperCase()} (${p} raw), confidence ${Math.round(confidence*100)}%`;
    if(p>0)playCowbell(p);
    setTimeout(()=>say(result==='hole'?`${name}, three points`:result==='board'?`${name}, one point`:`${name}, miss`),p>0?220:0);
    log(`${source}: ${name} ${result.toUpperCase()} → ${p} raw (${Math.round(confidence*100)}%) · board ${boardIndex>=0?boardIndex+1:'?'}`);
    dispatch('yardscore',{team,result,points:p,confidence,boardIndex,throws:game.throws,round:game.round});
    if(game.throws>=8)finishRound('8 bags');
    render();
  }

  function scoreRoundText(a,b){
    if(a>b)return{team:'A',pts:a-b,text:`Team Blue scores ${a-b}`};
    if(b>a)return{team:'B',pts:b-a,text:`Team Red scores ${b-a}`};
    return{team:null,pts:0,text:'Round is a wash'};
  }
  function finishRound(reason='manual'){
    if(roundEnding||game.throws===0)return;
    roundEnding=true;
    if(reason!=='8 bags')snapState();
    const completedRound=game.round,a=game.raw.A,b=game.raw.B,sc=scoreRoundText(a,b);
    if(sc.team==='A'){game.A+=sc.pts;game.firstTeam='A';log(`Round ${completedRound}: Team Blue +${sc.pts}; cancellation ${a}-${b}`)}
    else if(sc.team==='B'){game.B+=sc.pts;game.firstTeam='B';log(`Round ${completedRound}: Team Red +${sc.pts}; cancellation ${b}-${a}`)}
    else log(`Round ${completedRound}: wash ${a}-${b}`);

    game.raw={A:0,B:0};game.throws=0;game.round++;
    recentLandings=[];lastAcceptedAt=0;collectionCandidate=false;collectionHighFrames=0;collectionQuietFrames=0;
    const bc=boardCount(),previousBoard=activeBoardIndex;
    if(bc>1)setActiveBoard(previousBoard===0?1:0);else setActiveBoard(0);
    const w=game.A>=21?'A':game.B>=21?'B':null;
    if(w){
      const other=w==='A'?'B':'A';
      if($('winner'))$('winner').textContent=`🏆 ${teamCaps(w)} WINS ${game[w]}–${game[other]}`;
      playCowbell(3);setTimeout(()=>say(`${teamCaps(w)} wins. Final score ${game[w]} to ${game[other]}`),350);
    }else{
      const switchText=bc>1?`. Switching to board ${activeBoardIndex+1}`:'';
      setTimeout(()=>say(`${sc.text}${switchText}`),180);
    }
    log(`Round ${completedRound} ended automatically: ${reason}. Active end is now board ${activeBoardIndex+1}.`);
    dispatch('yardroundchange',{completedRound,nextRound:game.round,reason,scoringTeam:sc.team,points:sc.pts,rawA:a,rawB:b,activeBoardIndex});
    roundEnding=false;render();
  }

  function onAIThrow(e){
    if(roundEnding)return;
    const bc=boardCount();
    if(bc>1&&e.boardIndex>=0&&e.boardIndex!==activeBoardIndex){
      log(`Ignored bag activity on inactive board ${e.boardIndex+1}; Board ${activeBoardIndex+1} is active`);
      dispatch('yardguard',{type:'inactive-board',boardIndex:e.boardIndex,activeBoardIndex});
      return;
    }
    if(collectionCandidate&&game.throws>=5){
      duplicateBlocked++;log('Collection motion ignored as a throw');
      dispatch('yardguard',{type:'collection-motion'});render();return;
    }
    let pic='';try{pic=Vision.snapshot()}catch{}
    const expected=expectedTeam(),team=e.teamConfidence>=.60?e.team:expected,src=e.teamConfidence>=.60?'YARD VISION AI':'YARD VISION AI · ORDER FALLBACK';
    const guard=duplicateCheck(e,team);
    if(guard.duplicate){
      duplicateBlocked++;log(`Duplicate prevented: ${guard.reason}`);
      dispatch('yardguard',{type:'duplicate',reason:guard.reason,team,result:e.result,boardIndex:e.boardIndex});render();return;
    }
    rememberLanding(e,team,guard.overlap);
    addThrow(team,e.result,src,e.confidence,pic,e.centroid,e.boardIndex);
  }

  function collectionDetector(m){
    if(!autoRoundEnabled||!auto||roundEnding||game.throws<5||game.throws>=8){collectionHighFrames=0;collectionQuietFrames=0;if(!roundEnding)collectionCandidate=false;return}
    const now=Date.now(),age=lastAcceptedAt?now-lastAcceptedAt:0;
    const large=(m.changedColor||0)>=140&&!m.active;
    if(age>2600&&large)collectionHighFrames++;else if(!large)collectionHighFrames=Math.max(0,collectionHighFrames-1);
    if(!collectionCandidate&&collectionHighFrames>=4){
      collectionCandidate=true;collectionStartedAt=now;collectionQuietFrames=0;
      log('V9 detected likely bag collection; pausing throw scoring');
      dispatch('yardcollection',{state:'detected'});
    }
    if(collectionCandidate){
      const quiet=(m.changedColor||0)<14&&!m.active;
      collectionQuietFrames=quiet?collectionQuietFrames+1:0;
      if(collectionQuietFrames>=8&&now-lastAcceptedAt>3200){
        dispatch('yardcollection',{state:'confirmed'});
        finishRound('bags collected');
      }else if(now-collectionStartedAt>9000){
        collectionCandidate=false;collectionHighFrames=0;collectionQuietFrames=0;
        log('Collection detector reset — play continues');
      }
    }
  }

  function onMetrics(m){
    lastMetrics=m;
    if($('motionPct'))$('motionPct').textContent=Math.round(m.motion*100)+'%';
    if($('motionBar'))$('motionBar').style.width=Math.round(m.motion*100)+'%';
    if($('fps'))$('fps').textContent=Math.round(m.fps)+' fps';
    if($('visionState')){
      if(collectionCandidate)$('visionState').textContent='Players collecting bags…';
      else if(auto)$('visionState').textContent=m.active?'Bag moving…':(m.boardReady&&m.holeReady?`Watching Board ${activeBoardIndex+1}`:'Scanning yard…');
      else $('visionState').textContent=frameCount?(m.boardReady?`${m.boardCount||1} board / ${m.holeCount||0} hole tracked`:'Scanning whole yard…'):'Waiting for frames';
    }
    collectionDetector(m);
    dispatch('yardvisionmetrics',{...m,activeBoardIndex,duplicateBlocked,overlapAccepted,collectionCandidate,autoRoundEnabled,throws:game.throws,round:game.round});
  }

  function baseDiagnostics(extra=''){
    setDiag('dSecure',window.isSecureContext?'ok':'bad',window.isSecureContext?'YES':'NO');
    setDiag('dApi',navigator.mediaDevices?.getUserMedia?'ok':'bad',navigator.mediaDevices?.getUserMedia?'YES':'NO');
    if(!stream)setDiag('dPermission','wait','NOT ASKED');if(!frameCount)setDiag('dFrames','wait','0');
    const proto=location.protocol||'unknown:';
    if($('diagText'))$('diagText').textContent=extra||(!window.isSecureContext?`Opened with ${proto}. Live camera requires HTTPS. Open the GitHack link in Chrome, not a downloaded HTML file.`:'Tap Start Rear Camera, then keep both boards visible in a wide yard view.');
  }
  function waitEvent(el,name,ms=5000){return new Promise((resolve,reject)=>{if(name==='loadedmetadata'&&el.readyState>=1)return resolve();const ok=()=>{cleanup();resolve()},bad=()=>{cleanup();reject(new Error(name+' timeout'))},cleanup=()=>{clearTimeout(t);el.removeEventListener(name,ok)},t=setTimeout(bad,ms);el.addEventListener(name,ok,{once:true})})}
  async function populateCameras(){try{const ds=await navigator.mediaDevices.enumerateDevices(),cams=ds.filter(d=>d.kind==='videoinput'),sel=$('cameraSelect');if(!sel)return;const old=sel.value;sel.innerHTML='<option value="">Auto rear camera</option>';cams.forEach((d,i)=>{const o=document.createElement('option');o.value=d.deviceId;o.textContent=d.label||`Camera ${i+1}`;sel.appendChild(o)});if(selectedDeviceId)sel.value=selectedDeviceId;else if(old)sel.value=old}catch(e){log('Could not enumerate cameras: '+e.message)}}

  function stopPreviewLoop(){if(previewLoop){cancelAnimationFrame(previewLoop);previewLoop=0}imageCapture=null}
  function stopFrameWatch(){if(frameWatchTimer){clearInterval(frameWatchTimer);frameWatchTimer=0}}
  function startFrameWatch(v){
    stopFrameWatch();frameCount=0;setDiag('dFrames','wait','WAITING');
    const got=()=>{frameCount++;setDiag('dFrames','ok',String(frameCount));render()};
    if(typeof v.requestVideoFrameCallback==='function'){const cb=()=>{if(!stream)return;got();v.requestVideoFrameCallback(cb)};v.requestVideoFrameCallback(cb)}
    else{let last=-1;frameWatchTimer=setInterval(()=>{if(!stream)return;if(v.readyState>=2&&v.currentTime!==last){last=v.currentTime;got()}},180)}
  }

  async function forceCanvasPreview(silent=false){
    if(!stream){baseDiagnostics('Start the camera first, then use Canvas Preview.');return}
    stopPreviewLoop();canvasPreview=true;const c=$('liveCanvas'),v=$('cam');c.style.display='block';const track=stream.getVideoTracks()[0];
    try{if('ImageCapture'in window)imageCapture=new ImageCapture(track)}catch{}if(!silent)log('Canvas preview enabled');
    const loop=async()=>{
      if(!stream||!canvasPreview)return;
      try{
        let bitmap=null;if(imageCapture?.grabFrame){try{bitmap=await imageCapture.grabFrame()}catch{}}
        const rect=$('cameraWrap').getBoundingClientRect(),dpr=window.devicePixelRatio||1;c.width=Math.max(1,Math.round(rect.width*dpr));c.height=Math.max(1,Math.round(rect.height*dpr));
        const ctx=c.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);
        const src=bitmap||v,sw=bitmap?.width||v.videoWidth,sh=bitmap?.height||v.videoHeight;
        if(sw&&sh){const scale=Math.min(rect.width/sw,rect.height/sh),w=sw*scale,h=sh*scale;ctx.drawImage(src,(rect.width-w)/2,(rect.height-h)/2,w,h)}
        bitmap?.close?.();
      }catch{}
      previewLoop=requestAnimationFrame(loop)
    };
    loop();baseDiagnostics(`Canvas preview is ON${isAndroid?' (recommended on Android)':''}. Yard Vision is still analyzing live frames.`);
  }
  async function selectCamera(id){selectedDeviceId=id||'';await startCamera()}

  async function startCamera(){
    ensureAudio();baseDiagnostics('Checking camera environment…');
    if(!window.isSecureContext){if($('sys'))$('sys').textContent='HTTPS REQUIRED';setDiag('dSecure','bad','NO');baseDiagnostics('Camera blocked because this page is not HTTPS. Open the HTTPS app link in Chrome.');return}
    if(!navigator.mediaDevices?.getUserMedia){if($('sys'))$('sys').textContent='CAMERA API UNAVAILABLE';setDiag('dApi','bad','NO');baseDiagnostics('Open this page directly in current Chrome for Android.');return}
    $('startBtn').disabled=true;$('startBtn').textContent='Starting camera…';setDiag('dPermission','wait','ASKING');
    try{
      stopPreviewLoop();stopFrameWatch();if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}
      const v=$('cam'),c=$('liveCanvas');canvasPreview=false;c.style.display='none';frameCount=0;
      try{v.pause()}catch{}v.removeAttribute('src');v.srcObject=null;v.controls=false;v.autoplay=true;v.muted=true;v.playsInline=true;v.setAttribute('autoplay','');v.setAttribute('muted','');v.setAttribute('playsinline','');
      const preferred=selectedDeviceId?{deviceId:{exact:selectedDeviceId},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}}:{facingMode:{ideal:facing},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}};
      try{stream=await navigator.mediaDevices.getUserMedia({video:preferred,audio:false})}catch(firstErr){log(`Preferred camera failed (${firstErr.name}); trying generic camera`);stream=await navigator.mediaDevices.getUserMedia({video:true,audio:false})}
      setDiag('dPermission','ok','ALLOWED');const track=stream.getVideoTracks()[0],st=track.getSettings?.()||{};selectedDeviceId=st.deviceId||selectedDeviceId;
      v.srcObject=stream;try{await waitEvent(v,'loadedmetadata',5000)}catch{}try{await v.play()}catch{await new Promise(r=>setTimeout(r,250));await v.play().catch(()=>{})}
      startFrameWatch(v);await populateCameras();Vision.init(v,$('overlay'),onAIThrow,onMetrics);
      const size=`${v.videoWidth||st.width||0}×${v.videoHeight||st.height||0}`;
      if($('cameraMeta'))$('cameraMeta').textContent=`${track.label||'Camera'} · ${size}`;
      if($('calHelp'))$('calHelp').textContent='V9: keep both boards visible when possible. Green outline = active scoring board; cyan = inactive board.';
      if($('sys'))$('sys').textContent='CAMERA STARTING';log(`Camera opened: ${track.label||'camera'} ${size}`);
      await new Promise(r=>setTimeout(r,700));if(isAndroid)await forceCanvasPreview(true);
      baseDiagnostics('Camera live. V9 rejects bounce duplicates, accepts later overlapping bags, and switches ends automatically.');
      render();
    }catch(e){
      stream=null;frameCount=0;if($('sys'))$('sys').textContent='CAMERA ERROR';
      setDiag('dPermission',e?.name==='NotAllowedError'?'bad':'warn',e?.name==='NotAllowedError'?'BLOCKED':'ERROR');setDiag('dFrames','bad','0');
      let help=`${e?.name||'Error'}: ${e?.message||'Camera could not start.'}`;
      if(e?.name==='NotAllowedError')help+=' In Chrome, allow Camera for this site and reload.';
      if(e?.name==='NotReadableError')help+=' Close any other app using the camera.';
      baseDiagnostics(help);log('Camera error: '+help)
    }finally{$('startBtn').disabled=false;$('startBtn').textContent='🤳 Start Rear Camera';render()}
  }

  function stopCamera(){
    stopPreviewLoop();stopFrameWatch();canvasPreview=false;frameCount=0;const c=$('liveCanvas');if(c)c.style.display='none';
    if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}const v=$('cam');if(v){try{v.pause()}catch{}v.srcObject=null}
    auto=false;Vision.setAuto(false);setDiag('dFrames','wait','0');render();log('Camera stopped')
  }
  async function loadClip(input){
    const file=input.files?.[0];if(!file)return;if(stream)stopCamera();const url=URL.createObjectURL(file),v=$('cam');v.srcObject=null;v.src=url;v.muted=true;v.loop=true;v.controls=true;
    try{await v.play();Vision.init(v,$('overlay'),onAIThrow,onMetrics);if($('sys'))$('sys').textContent='TEST VIDEO';setDiag('dFrames','ok','VIDEO');if($('calHelp'))$('calHelp').textContent='Recorded video loaded. V9 will scan it for both boards and holes.';render()}catch(e){baseDiagnostics('Could not play selected video: '+e.message)}
  }
  async function flipCamera(){facing=facing==='environment'?'user':'environment';selectedDeviceId='';await startCamera()}
  function rescanYard(){
    Vision.rescan();cal=Vision.getCalibration();auto=false;Vision.setAuto(false);setActiveBoard(0);
    collectionCandidate=false;collectionHighFrames=0;collectionQuietFrames=0;
    if($('call'))$('call').textContent='';if($('calHelp'))$('calHelp').textContent='Rescanning. Keep both boards and holes visible and hold the phone steady.';
    log('Rescanning yard');render()
  }
  function toggleAuto(){ensureAudio();auto=!auto;Vision.setAuto(auto);if(auto){cowbellHit(0,.45);setTimeout(()=>say(`Automatic referee enabled. Board ${activeBoardIndex+1} is active.`),120)}else if($('call'))$('call').textContent='';log(auto?'Automatic referee enabled':'Automatic referee disabled');render()}
  function testCowbell(){ensureAudio();playCowbell(3);log('Cowbell test')}
  function setFirstTeam(team){game.firstTeam=team==='B'?'B':'A';render()}
  function setSensitivity(v){Vision.setSensitivity(v);log(`Detection sensitivity: ${v}`)}
  function manual(result){ensureAudio();addThrow($('teamSel').value,result,'MANUAL',1,null,null,activeBoardIndex)}
  function endRoundNow(){finishRound('manual end round')}

  function undo(){
    if(!game.history.length)return;
    const x=JSON.parse(game.history.pop());game.A=x.A;game.B=x.B;game.raw=x.raw;game.throws=x.throws;game.round=x.round;game.lastDecision=x.lastDecision;game.firstTeam=x.firstTeam||game.firstTeam;
    recentLandings=x.recentLandings||[];lastAcceptedAt=x.lastAcceptedAt||0;setActiveBoard(x.activeBoardIndex||0);
    if($('winner'))$('winner').textContent=x.w;if($('call'))$('call').textContent=x.call;roundEnding=false;collectionCandidate=false;
    log('Previous decision/round transition undone');render()
  }
  function correct(result){if(!game.lastDecision)return;const prev=game.lastDecision;undo();addThrow(prev.team,result,'REVIEW CORRECTION',1,prev.snapshot,prev.centroid,prev.boardIndex)}
  function swapTeam(){if(!game.lastDecision)return;const prev=game.lastDecision;undo();addThrow(prev.team==='A'?'B':'A',prev.result,'REVIEW CORRECTION',1,prev.snapshot,prev.centroid,prev.boardIndex)}

  function resetGame(){
    const first=$('firstTeam')?.value||'A';game={A:0,B:0,raw:{A:0,B:0},throws:0,round:1,history:[],lastDecision:null,firstTeam:first};
    recentLandings=[];lastAcceptedAt=0;duplicateBlocked=0;overlapAccepted=0;roundEnding=false;collectionCandidate=false;collectionHighFrames=0;collectionQuietFrames=0;setActiveBoard(0);
    if($('winner'))$('winner').textContent='';if($('call'))$('call').textContent='';$('thumb')?.removeAttribute('src');if($('reviewText'))$('reviewText').textContent='No throw detected yet.';if($('log'))$('log').innerHTML='';
    Vision.setAuto(auto);log('New V9 match');render()
  }
  function demoThrow(){ensureAudio();const team=expectedTeam(),x=Math.random(),result=x<.28?'hole':x<.78?'board':'miss';const boardIndex=activeBoardIndex;const vw=$('cam')?.videoWidth||1280,vh=$('cam')?.videoHeight||720;const centroid={x:vw*(.4+Math.random()*.2),y:vh*(.4+Math.random()*.2)};const fake={result,boardIndex,centroid,team,teamConfidence:.95,confidence:.94};onAIThrow(fake)}
  async function installApp(){if(installPrompt){installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;if($('installBtn'))$('installBtn').hidden=true}else baseDiagnostics('Chrome menu (⋮) → Add to Home screen / Install app.')}

  function setAutoRound(v){autoRoundEnabled=!!v;collectionCandidate=false;collectionHighFrames=0;collectionQuietFrames=0;localStorage.setItem('cornhole-v9-auto-round',autoRoundEnabled?'on':'off');render();dispatch('yardautoround',{enabled:autoRoundEnabled})}
  function toggleAutoRound(){setAutoRound(!autoRoundEnabled)}
  function getState(){return{...clone(game),activeBoardIndex,autoRoundEnabled,duplicateBlocked,overlapAccepted,collectionCandidate,boardCount:boardCount(),holeCount:holeCount(),auto,lastMetrics:{...lastMetrics}}}

  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;if($('installBtn'))$('installBtn').hidden=false});
  window.addEventListener('appinstalled',()=>{installPrompt=null;if($('installBtn'))$('installBtn').hidden=true});
  window.addEventListener('calibrationchange',e=>{
    cal=e.detail;
    if(boardCount()<=activeBoardIndex)setActiveBoard(0);
    render()
  });
  autoRoundEnabled=localStorage.getItem('cornhole-v9-auto-round')!=='off';
  Vision.setSensitivity($('sensitivity')?.value||'high');baseDiagnostics();log('Cornhole AI V9 Accuracy + Zero-Touch loaded');render();

  return{
    startCamera,stopCamera,flipCamera,selectCamera,forceCanvasPreview,loadClip,rescanYard,toggleAuto,testCowbell,
    setFirstTeam,setSensitivity,manual,undo,correct,swapTeam,resetGame,demoThrow,installApp,
    finishRound,endRoundNow,setActiveBoard,setAutoRound,toggleAutoRound,getState
  };
})();
