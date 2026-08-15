const App=(()=>{
  const $=id=>document.getElementById(id);
  const isAndroid=/Android/i.test(navigator.userAgent);
  let stream=null,facing='environment',auto=false,selectedDeviceId='',previewLoop=0,imageCapture=null,canvasPreview=false;
  let frameCount=0,lastFrameAt=0,frameWatchTimer=0,installPrompt=null;
  let game={A:0,B:0,raw:{A:0,B:0},throws:0,round:1,history:[],lastDecision:null,firstTeam:'A'};
  let cal=Vision.loadCal();

  function rgb(c){return `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`}
  function setDiag(id,state,text){const el=$(id);if(!el)return;el.className='diagItem '+state;el.querySelector('.diagValue').textContent=text}
  function render(){
    $('sa').textContent=game.A;$('sb').textContent=game.B;$('ra').textContent=game.raw.A;$('rb').textContent=game.raw.B;$('tc').textContent=game.throws;$('rn').textContent=game.round;const expected=game.throws%2===0?game.firstTeam:(game.firstTeam==='A'?'B':'A');$('nextThrow').textContent=`NEXT: TEAM ${expected}`;if($('firstTeam').value!==game.firstTeam)$('firstTeam').value=game.firstTeam;
    $('s1').classList.toggle('done',cal.board?.length===4);
    $('s2').classList.toggle('done',!!(cal.hole&&cal.holeEdge));
    $('s3').classList.toggle('done',!!cal.colorA);
    $('s4').classList.toggle('done',!!cal.colorB);
    $('swA').style.background=cal.colorA?rgb(cal.colorA):'#3fa7ff';
    $('swB').style.background=cal.colorB?rgb(cal.colorB):'#ff9d28';
    const ready=cal.board?.length===4&&cal.hole&&cal.holeEdge&&cal.colorA&&cal.colorB;const mediaReady=!!stream||!!$('cam')?.getAttribute('src');
    $('autoBtn').disabled=!ready||!mediaReady;
    $('autoBtn').textContent=auto?'⏸ Disable Auto Ref':'▶ Enable Auto Ref';
    if(auto)$('sys').textContent='AUTO REF LIVE';
    else if(stream)$('sys').textContent=frameCount?'CAMERA LIVE':'CAMERA STARTING';
    else $('sys').textContent=window.isSecureContext?'READY':'HTTPS REQUIRED';
  }
  function log(t){const d=document.createElement('div');d.textContent=new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})+' · '+t;$('log').prepend(d)}
  function say(t){$('call').textContent=t;if('speechSynthesis'in window){speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(t);u.rate=1.03;speechSynthesis.speak(u)}}
  function snapState(){game.history.push(JSON.stringify({A:game.A,B:game.B,raw:{...game.raw},throws:game.throws,round:game.round,lastDecision:game.lastDecision,firstTeam:game.firstTeam,w:$('winner').textContent,call:$('call').textContent}))}
  function addThrow(team,result,source='MANUAL',confidence=1,snapshot=null,centroid=null){
    if($('winner').textContent)return;snapState();
    const p=result==='hole'?3:result==='board'?1:0;game.raw[team]+=p;game.throws++;
    const name=team==='A'?'Team A':'Team B';game.lastDecision={team,result,source,confidence,snapshot,centroid,points:p};
    $('thumb').src=snapshot||'';$('reviewText').textContent=`${source}: ${name} → ${result.toUpperCase()} (${p} raw), confidence ${Math.round(confidence*100)}%`;
    say(result==='hole'?`${name}, three points`:result==='board'?`${name}, one point`:`${name}, miss`);
    log(`${source}: ${name} ${result.toUpperCase()} → ${p} raw (${Math.round(confidence*100)}%)`);
    if(game.throws>=8)finishRound();render();
  }
  function finishRound(){
    const a=game.raw.A,b=game.raw.B,pts=Math.abs(a-b);let scoringTeam=null;
    if(a>b){game.A+=pts;scoringTeam='A';log(`Round ${game.round}: Team A +${pts}; cancellation ${a}-${b}`)}
    else if(b>a){game.B+=pts;scoringTeam='B';log(`Round ${game.round}: Team B +${pts}; cancellation ${b}-${a}`)}
    else log(`Round ${game.round}: wash ${a}-${b}`);
    if(scoringTeam)game.firstTeam=scoringTeam;
    game.raw={A:0,B:0};game.throws=0;game.round++;
    const w=game.A>=21?'A':game.B>=21?'B':null;
    if(w){const name=w==='A'?'TEAM A':'TEAM B',other=w==='A'?'B':'A';$('winner').textContent=`🏆 ${name} WINS ${game[w]}–${game[other]}`;say(`${name} wins. Final score ${game[w]} to ${game[other]}`)}
  }
  function onAIThrow(e){let pic='';try{pic=Vision.snapshot()}catch{}const expected=game.throws%2===0?game.firstTeam:(game.firstTeam==='A'?'B':'A');const team=e.teamConfidence>=.62?e.team:expected;const src=e.teamConfidence>=.62?'CAMERA AI':'CAMERA AI · ORDER FALLBACK';addThrow(team,e.result,src,e.confidence,pic,e.centroid)}
  function onMetrics(m){
    $('motionPct').textContent=Math.round(m.motion*100)+'%';$('motionBar').style.width=Math.round(m.motion*100)+'%';
    $('fps').textContent=Math.round(m.fps)+' fps';$('visionState').textContent=auto?(m.active?'Bag moving…':'Watching throws'):frameCount?'Vision ready':'Waiting for frames';
  }

  function baseDiagnostics(extra=''){
    setDiag('dSecure',window.isSecureContext?'ok':'bad',window.isSecureContext?'YES':'NO');
    setDiag('dApi',navigator.mediaDevices?.getUserMedia?'ok':'bad',navigator.mediaDevices?.getUserMedia?'YES':'NO');
    if(!stream)setDiag('dPermission','wait','NOT ASKED');
    if(!frameCount)setDiag('dFrames','wait','0');
    const proto=location.protocol||'unknown:';
    $('diagText').textContent=extra||(!window.isSecureContext?`Opened with ${proto}. Live camera requires an HTTPS site or localhost. Do not open index.html directly from Downloads.`:'Tap Start Rear Camera to test the live stream.');
  }

  function waitEvent(el,name,ms=5000){return new Promise((resolve,reject)=>{
    if(name==='loadedmetadata'&&el.readyState>=1)return resolve();
    const ok=()=>{cleanup();resolve()},bad=()=>{cleanup();reject(new Error(name+' timeout'))};
    const cleanup=()=>{clearTimeout(t);el.removeEventListener(name,ok)};const t=setTimeout(bad,ms);el.addEventListener(name,ok,{once:true});
  })}
  async function populateCameras(){try{
    const ds=await navigator.mediaDevices.enumerateDevices(),cams=ds.filter(d=>d.kind==='videoinput'),sel=$('cameraSelect');if(!sel)return;
    const old=sel.value;sel.innerHTML='<option value="">Auto rear camera</option>';
    cams.forEach((d,i)=>{const o=document.createElement('option');o.value=d.deviceId;o.textContent=d.label||`Camera ${i+1}`;sel.appendChild(o)});
    if(selectedDeviceId)sel.value=selectedDeviceId;else if(old)sel.value=old;
  }catch(e){log('Could not enumerate cameras: '+e.message)}}

  function stopPreviewLoop(){if(previewLoop){cancelAnimationFrame(previewLoop);previewLoop=0}imageCapture=null}
  function stopFrameWatch(){if(frameWatchTimer){clearInterval(frameWatchTimer);frameWatchTimer=0}}
  function startFrameWatch(v){
    stopFrameWatch();frameCount=0;lastFrameAt=0;setDiag('dFrames','wait','WAITING');
    const gotFrame=()=>{frameCount++;lastFrameAt=performance.now();setDiag('dFrames','ok',String(frameCount));$('visionState').textContent=auto?'Watching throws':'Vision ready';render()};
    if(typeof v.requestVideoFrameCallback==='function'){
      const cb=()=>{if(!stream)return;gotFrame();v.requestVideoFrameCallback(cb)};v.requestVideoFrameCallback(cb);
    }else{
      let lastTime=-1;frameWatchTimer=setInterval(()=>{if(!stream)return;if(v.readyState>=2&&v.currentTime!==lastTime){lastTime=v.currentTime;gotFrame()}},180);
    }
  }

  async function forceCanvasPreview(silent=false){
    if(!stream){baseDiagnostics('Start the camera first, then use Canvas Preview.');return}
    stopPreviewLoop();canvasPreview=true;
    const c=$('liveCanvas'),v=$('cam');c.style.display='block';
    const track=stream.getVideoTracks()[0];try{if('ImageCapture'in window)imageCapture=new ImageCapture(track)}catch{}
    $('visionState').textContent='Canvas preview';if(!silent)log('Canvas preview enabled');
    const loop=async()=>{
      if(!stream||!canvasPreview)return;
      try{
        let bitmap=null;if(imageCapture?.grabFrame){try{bitmap=await imageCapture.grabFrame()}catch{}}
        const rect=$('cameraWrap').getBoundingClientRect(),dpr=window.devicePixelRatio||1;
        c.width=Math.max(1,Math.round(rect.width*dpr));c.height=Math.max(1,Math.round(rect.height*dpr));
        const ctx=c.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);
        const src=bitmap||v,sw=bitmap?.width||v.videoWidth,sh=bitmap?.height||v.videoHeight;
        if(sw&&sh){const scale=Math.min(rect.width/sw,rect.height/sh),w=sw*scale,h=sh*scale;ctx.drawImage(src,(rect.width-w)/2,(rect.height-h)/2,w,h)}
        bitmap?.close?.();
      }catch(e){$('visionState').textContent='Preview retrying'}
      previewLoop=requestAnimationFrame(loop);
    };loop();
    baseDiagnostics(`Canvas preview is ON${isAndroid?' (recommended on Android)':''}. If you see live video here, the camera stream is working.`);
  }
  async function selectCamera(id){selectedDeviceId=id||'';await startCamera()}

  async function startCamera(){
    baseDiagnostics('Checking camera environment…');
    if(!window.isSecureContext){$('sys').textContent='HTTPS REQUIRED';setDiag('dSecure','bad','NO');baseDiagnostics(`This page is running from ${location.protocol}. Chrome blocks continuous camera access here. Upload/install this PWA from HTTPS, then try again.`);log('Camera blocked: insecure page');return}
    if(!navigator.mediaDevices?.getUserMedia){$('sys').textContent='CAMERA API UNAVAILABLE';setDiag('dApi','bad','NO');baseDiagnostics('This browser does not expose getUserMedia. Open the HTTPS PWA directly in Chrome.');return}
    $('startBtn').disabled=true;$('startBtn').textContent='Starting camera…';setDiag('dPermission','wait','ASKING');
    try{
      stopPreviewLoop();stopFrameWatch();if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}
      const v=$('cam'),c=$('liveCanvas');canvasPreview=false;c.style.display='none';frameCount=0;
      try{v.pause()}catch{}v.removeAttribute('src');v.srcObject=null;v.controls=false;v.autoplay=true;v.muted=true;v.playsInline=true;
      v.setAttribute('autoplay','');v.setAttribute('muted','');v.setAttribute('playsinline','');
      const preferred=selectedDeviceId?{deviceId:{exact:selectedDeviceId},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:60}}:{facingMode:{ideal:facing},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:60}};
      try{stream=await navigator.mediaDevices.getUserMedia({video:preferred,audio:false})}
      catch(firstErr){log(`Preferred camera failed (${firstErr.name}); trying generic video`);stream=await navigator.mediaDevices.getUserMedia({video:true,audio:false})}
      setDiag('dPermission','ok','ALLOWED');
      const track=stream.getVideoTracks()[0],st=track.getSettings?.()||{};selectedDeviceId=st.deviceId||selectedDeviceId;
      track.addEventListener('ended',()=>{setDiag('dFrames','bad','STOPPED');$('sys').textContent='CAMERA STOPPED';baseDiagnostics('The camera track ended. Tap Start Rear Camera to reconnect.')},{once:true});
      v.srcObject=stream;try{await waitEvent(v,'loadedmetadata',5000)}catch{}
      try{await v.play()}catch(e){log('video.play: '+e.message);await new Promise(r=>setTimeout(r,250));await v.play().catch(()=>{})}
      startFrameWatch(v);await populateCameras();Vision.init(v,$('overlay'),onAIThrow,onMetrics);
      const size=`${v.videoWidth||st.width||0}×${v.videoHeight||st.height||0}`;
      $('cameraMeta').textContent=`${track.label||'Camera'} · ${size}`;
      $('calHelp').textContent='Camera connected. Calibrate the board, hole, and bag colors.';
      $('sys').textContent='CAMERA STARTING';log(`Camera opened: ${track.label||'camera'} ${size} state=${track.readyState}`);
      await new Promise(r=>setTimeout(r,900));
      if(isAndroid)await forceCanvasPreview(true);
      baseDiagnostics(`Camera permission allowed. Track: ${track.readyState}. Video: ${size}. ${isAndroid?'Android canvas preview enabled automatically.':'Waiting for decoded frames.'}`);
      render();
    }catch(e){
      stream=null;frameCount=0;$('sys').textContent='CAMERA ERROR';setDiag('dPermission',e?.name==='NotAllowedError'?'bad':'warn',e?.name==='NotAllowedError'?'BLOCKED':'ERROR');setDiag('dFrames','bad','0');
      let help=`${e?.name||'Error'}: ${e?.message||'Camera could not start.'}`;
      if(e?.name==='NotAllowedError')help+=' Allow Camera in Chrome → Site settings, then reload.';
      if(e?.name==='NotReadableError')help+=' Close other apps that may be using the camera.';
      if(e?.name==='NotFoundError')help+=' No compatible camera was found.';
      baseDiagnostics(help);log('Camera error: '+help);
    }finally{$('startBtn').disabled=false;$('startBtn').textContent='🤳 Start Rear Camera';render()}
  }

  function stopCamera(){stopPreviewLoop();stopFrameWatch();canvasPreview=false;frameCount=0;const c=$('liveCanvas');if(c)c.style.display='none';if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}const v=$('cam');if(v){try{v.pause()}catch{}v.srcObject=null}auto=false;Vision.setAuto(false);setDiag('dFrames','wait','0');render();log('Camera stopped')}
  async function loadClip(input){const file=input.files?.[0];if(!file)return;if(stream)stopCamera();const url=URL.createObjectURL(file),v=$('cam');v.srcObject=null;v.src=url;v.muted=true;v.loop=true;v.controls=true;try{await v.play();Vision.init(v,$('overlay'),onAIThrow,onMetrics);$('sys').textContent='TEST VIDEO';$('calHelp').textContent='Recorded video loaded. Calibrate, then enable Auto Ref.';setDiag('dFrames','ok','VIDEO');baseDiagnostics('Native Android test video loaded. This tests the vision/scoring pipeline separately from live-camera permission.');log('Recorded camera clip loaded');render()}catch(e){baseDiagnostics('Could not play selected video: '+e.message)}}
  async function flipCamera(){facing=facing==='environment'?'user':'environment';selectedDeviceId='';await startCamera()}
  function modeBoard(){Vision.setMode('board');$('calHelp').textContent='Tap the four visible corners of the playing surface, in order.'}
  function modeHole(){Vision.setMode('hole');$('calHelp').textContent='Tap the center of the hole, then the hole edge.'}
  function modeColor(team){Vision.setMode(team);$('calHelp').textContent=`Tap directly on a clearly visible Team ${team} bag.`}
  function clearCalibration(){Vision.clear();auto=false;Vision.setAuto(false);$('calHelp').textContent='Calibration cleared.'}
  function toggleAuto(){auto=!auto;Vision.setAuto(auto);if(auto)say('Automatic referee enabled');else $('call').textContent='';log(auto?'Automatic referee enabled':'Automatic referee disabled');render()}
  function setFirstTeam(team){game.firstTeam=team==='B'?'B':'A';log(`First throw set to Team ${game.firstTeam}`);render()}
  function setSensitivity(v){Vision.setSensitivity(v);log(`Detection sensitivity: ${v}`)}
  function manual(result){addThrow($('teamSel').value,result,'MANUAL',1,null,null)}
  function undo(){if(!game.history.length)return;const x=JSON.parse(game.history.pop());game.A=x.A;game.B=x.B;game.raw=x.raw;game.throws=x.throws;game.round=x.round;game.lastDecision=x.lastDecision;game.firstTeam=x.firstTeam||game.firstTeam;$('winner').textContent=x.w;$('call').textContent=x.call;log('Previous decision undone');render()}
  function correct(result){if(!game.lastDecision)return;const prev=game.lastDecision;undo();addThrow(prev.team,result,'REVIEW CORRECTION',1,prev.snapshot,prev.centroid)}
  function swapTeam(){if(!game.lastDecision)return;const prev=game.lastDecision;undo();addThrow(prev.team==='A'?'B':'A',prev.result,'REVIEW CORRECTION',1,prev.snapshot,prev.centroid)}
  function resetGame(){const first=$('firstTeam')?.value||'A';game={A:0,B:0,raw:{A:0,B:0},throws:0,round:1,history:[],lastDecision:null,firstTeam:first};$('winner').textContent='';$('call').textContent='';$('thumb').removeAttribute('src');$('reviewText').textContent='No throw detected yet.';$('log').innerHTML='';Vision.setAuto(auto);log('New match');render()}
  function demoThrow(){const team=Math.random()<.5?'A':'B',x=Math.random(),result=x<.28?'hole':x<.78?'board':'miss';addThrow(team,result,'DEMO CAMERA AI',.9+Math.random()*.08,null,null)}
  async function installApp(){if(installPrompt){installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$('installBtn').hidden=true}else{baseDiagnostics('To install: Chrome menu (⋮) → Add to Home screen / Install app. The app must first be opened from its HTTPS address.')}}

  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('installBtn').hidden=false});
  window.addEventListener('appinstalled',()=>{installPrompt=null;$('installBtn').hidden=true;log('PWA installed')});
  window.addEventListener('calibrationchange',e=>{cal=e.detail;render()});
  Vision.setSensitivity($('sensitivity')?.value||'high');baseDiagnostics();log('Cornhole AI Camera V5.0 AutoScore Android PWA loaded');render();
  return{startCamera,stopCamera,flipCamera,selectCamera,forceCanvasPreview,loadClip,modeBoard,modeHole,modeColor,clearCalibration,toggleAuto,setFirstTeam,setSensitivity,manual,undo,correct,swapTeam,resetGame,demoThrow,installApp}
})();
