/* Yard Vision V9 Easy Play controller */
const EasyPlay=(()=>{
  const $=id=>document.getElementById(id);
  let wakeLock=null,setupTimer=0,flashTimer=0,voiceOn=localStorage.getItem('cornhole-v9-voice')!=='off';
  let lastReview='',lastRound=1,sfxCtx=null,sfxMaster=null,lastMetrics={};

  function setStatus(text,state=''){const el=$('gameStatus');if(!el)return;el.textContent=text;el.dataset.state=state}
  function setStartButton(text,disabled=false){const b=$('startGameBtn');if(!b)return;b.textContent=text;b.disabled=disabled}
  async function keepAwake(){try{if('wakeLock'in navigator&&!wakeLock)wakeLock=await navigator.wakeLock.request('screen')}catch{}}
  async function releaseWake(){try{await wakeLock?.release?.()}catch{}wakeLock=null}

  function soundContext(){
    try{
      const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return null;
      if(!sfxCtx){
        sfxCtx=new AC({latencyHint:'interactive'});sfxMaster=sfxCtx.createGain();sfxMaster.gain.value=.9;
        const comp=sfxCtx.createDynamicsCompressor();comp.threshold.value=-18;comp.knee.value=12;comp.ratio.value=5;comp.attack.value=.003;comp.release.value=.18;
        sfxMaster.connect(comp);comp.connect(sfxCtx.destination)
      }
      return sfxCtx
    }catch{return null}
  }
  function unlockSound(){
    const ctx=soundContext();if(!ctx)return Promise.resolve(false);
    try{const p=ctx.state==='suspended'?ctx.resume():Promise.resolve();return Promise.resolve(p).then(()=>ctx.state==='running').catch(()=>false)}catch{return Promise.resolve(false)}
  }
  function bellHit(offset=0,accent=1){
    const ctx=soundContext();if(!ctx||ctx.state!=='running'||!sfxMaster)return false;
    const t=ctx.currentTime+offset,hit=ctx.createGain(),metal=ctx.createBiquadFilter();metal.type='bandpass';metal.frequency.setValueAtTime(1350,t);metal.Q.setValueAtTime(.85,t);
    hit.gain.setValueAtTime(.0001,t);hit.gain.exponentialRampToValueAtTime(.72*accent,t+.006);hit.gain.exponentialRampToValueAtTime(.0001,t+.42);hit.connect(metal);metal.connect(sfxMaster);
    [545,800,1090].forEach((f,i)=>{const o=ctx.createOscillator();o.type=i===2?'sawtooth':'square';o.frequency.setValueAtTime(f,t);o.frequency.exponentialRampToValueAtTime(f*.92,t+.34);o.connect(hit);o.start(t);o.stop(t+.44)});
    return true
  }
  function playBell(points=1){if(points<=0)return;unlockSound().then(ok=>{if(!ok)return;const hits=points>=3?3:1;for(let i=0;i<hits;i++)bellHit(i*.19,i===0?1:.9)})}
  async function testCowbell(){const ok=await unlockSound();if(ok){for(let i=0;i<3;i++)bellHit(i*.19,i===0?1:.9);setStatus('🔔 Cowbell sound is ON','ready')}else setStatus('Sound is blocked — tap Start Game once, then test again.','warn')}

  const boardReady=()=>$('s1')?.classList.contains('done');
  const holeReady=()=>$('s2')?.classList.contains('done');
  const autoEnabled=()=>$('autoBtn')&&!$('autoBtn').disabled;
  const autoRunning=()=>$('autoBtn')?.textContent.includes('Disable');

  function state(){try{return App.getState()}catch{return{throws:0,round:1,firstTeam:'A',activeBoardIndex:0,boardCount:0,duplicateBlocked:0,overlapAccepted:0,autoRoundEnabled:true}}}

  async function startGame(){
    const audioReady=unlockSound();clearInterval(setupTimer);setupTimer=0;setStartButton('Starting…',true);setStatus('Starting rear camera…','working');
    try{
      await audioReady;await keepAwake();App.resetGame();await App.startCamera();
      const cam=$('cam');if(!cam?.srcObject&&!cam?.getAttribute('src')){setStatus('Camera needs attention — open Setup Help below.','error');setStartButton('▶ TRY AGAIN',false);return}
      App.rescanYard();setStatus('Finding boards and holes… hold the phone steady.','working');let checks=0;
      setupTimer=setInterval(()=>{
        checks++;
        if(boardReady()&&holeReady()&&autoEnabled()){
          if(!autoRunning())App.toggleAuto();clearInterval(setupTimer);setupTimer=0;
          const s=state();setStatus(`✅ READY — Board ${s.activeBoardIndex+1} active · throw a bag`,'ready');setStartButton('✓ GAME RUNNING',false);updateThrowCounts()
        }else if(boardReady())setStatus('Board found — locking onto the hole…','working');
        else setStatus('Scanning the whole yard for cornhole boards…','working');
        if(checks>80){clearInterval(setupTimer);setupTimer=0;setStatus('Still scanning — adjust the phone so a board and hole are clearly visible.','warn');setStartButton('◎ RESCAN & START',false)}
      },350)
    }catch(e){setStatus('Setup error — open Setup Help and try again.','error');setStartButton('▶ TRY AGAIN',false)}
  }
  async function stopGame(){clearInterval(setupTimer);setupTimer=0;App.stopCamera();await releaseWake();setStatus('Game stopped.','');setStartButton('▶ START GAME',false)}
  function rescan(){
    App.rescanYard();setStatus('Rescanning boards and holes…','working');setStartButton('◎ SCANNING…',true);let checks=0;clearInterval(setupTimer);
    setupTimer=setInterval(()=>{
      checks++;
      if(boardReady()&&holeReady()&&autoEnabled()){if(!autoRunning())App.toggleAuto();clearInterval(setupTimer);setupTimer=0;const s=state();setStatus(`✅ READY — Board ${s.activeBoardIndex+1} active`,'ready');setStartButton('✓ GAME RUNNING',false)}
      else if(checks>60){clearInterval(setupTimer);setupTimer=0;setStatus('Still scanning — adjust the camera and try again.','warn');setStartButton('◎ RESCAN & START',false)}
    },350)
  }

  function showFlash(team,result,points){
    const el=$('scoreFlash');if(!el)return;clearTimeout(flashTimer);
    const name=team.toUpperCase(),word=result==='HOLE'?'CORNHOLE!':result==='BOARD'?'ON THE BOARD':'MISS';
    el.className=`scoreFlash show ${team.toLowerCase()}`;el.innerHTML=`<div class="flashTeam">${team==='Blue'?'🔵':'🔴'} ${name}</div><div class="flashPoints">${points>0?'+':''}${points}</div><div class="flashCall">${word}</div><button onclick="App.undo();EasyPlay.hideFlash()">↶ Undo</button>`;
    flashTimer=setTimeout(()=>hideFlash(),2200)
  }
  function hideFlash(){const el=$('scoreFlash');if(el)el.className='scoreFlash'}

  function updateThrowCounts(){
    const s=state(),total=s.throws||0,first=s.firstTeam||'A',firstCount=Math.ceil(total/2),secondCount=Math.floor(total/2);
    const blue=first==='A'?firstCount:secondCount,red=first==='B'?firstCount:secondCount;
    if($('blueBags'))$('blueBags').textContent=`${Math.min(4,blue)}/4 bags`;if($('redBags'))$('redBags').textContent=`${Math.min(4,red)}/4 bags`;
    if($('activeBoardLabel'))$('activeBoardLabel').textContent=`🎯 Board ${(s.activeBoardIndex||0)+1} active`;
    if($('guardLabel'))$('guardLabel').textContent=`🛡️ Duplicate guard${s.duplicateBlocked?` · ${s.duplicateBlocked} blocked`:''}`;
    if($('overlapLabel'))$('overlapLabel').textContent=`🧠 Overlap tracking${s.overlapAccepted?` · ${s.overlapAccepted} preserved`:''}`;
    if($('autoRoundBtn'))$('autoRoundBtn').textContent=s.autoRoundEnabled?'🔄 Auto Round ON':'🔄 Auto Round OFF'
  }

  function inspectReview(){
    const text=$('reviewText')?.textContent||'';if(!text||text===lastReview)return;lastReview=text;
    const m=text.match(/Team (Blue|Red)\s*→\s*(HOLE|BOARD|MISS)\s*\((\d+) raw\)/i);
    if(m){const points=Number(m[3]);showFlash(m[1][0].toUpperCase()+m[1].slice(1).toLowerCase(),m[2].toUpperCase(),points);if(points>0)playBell(points);updateThrowCounts();setStatus('Score confirmed — next bag','ready')}
  }

  function toggleOutdoor(){
    const on=!document.body.classList.contains('outdoor');document.body.classList.toggle('outdoor',on);localStorage.setItem('cornhole-v9-outdoor',on?'on':'off');
    if($('outdoorBtn'))$('outdoorBtn').textContent=on?'☀️ Outdoor ON':'☀️ Outdoor Mode'
  }
  function installVoiceGate(){
    try{const synth=window.speechSynthesis;if(!synth||synth.__yardVisionGate)return;const original=synth.speak.bind(synth);synth.speak=u=>{if(voiceOn)original(u)};synth.__yardVisionGate=true}catch{}
  }
  function toggleVoice(){voiceOn=!voiceOn;localStorage.setItem('cornhole-v9-voice',voiceOn?'on':'off');if(!voiceOn)try{speechSynthesis.cancel()}catch{};updateVoiceButton()}
  function updateVoiceButton(){if($('voiceBtn'))$('voiceBtn').textContent=voiceOn?'🔊 Ref Voice ON':'🔇 Ref Voice OFF'}
  function toggleAutoRound(){App.toggleAutoRound();updateThrowCounts()}

  function syncStatus(){
    updateThrowCounts();const s=state(),r=s.round||1;
    if(r!==lastRound){lastRound=r;setStatus(`Round ${r} — Board ${(s.activeBoardIndex||0)+1} active · ${$('nextThrow')?.textContent||'ready'}`,'ready')}
    if(autoRunning()&&boardReady()&&holeReady()&&!setupTimer&&!$('winner')?.textContent)setStartButton('✓ GAME RUNNING',false)
  }

  function onRound(e){
    const d=e.detail||{},score=d.points?`${d.scoringTeam==='A'?'Blue':'Red'} +${d.points}`:'wash';
    setStatus(`Round ${d.completedRound} complete (${score}) — Board ${(d.activeBoardIndex||0)+1} active`,'ready');updateThrowCounts()
  }
  function onGuard(e){
    const d=e.detail||{};
    if(d.type==='duplicate')setStatus('🛡️ Bounce/re-settle ignored — score unchanged','ready');
    else if(d.type==='inactive-board')setStatus(`Ignored activity on Board ${(d.boardIndex||0)+1} — active end is Board ${(d.activeBoardIndex||0)+1}`,'ready');
    else if(d.type==='collection-motion')setStatus('Collecting bags — scoring paused','working');
    updateThrowCounts()
  }
  function onCollection(e){if(e.detail?.state==='detected')setStatus('🚶 Bags being collected — ending round when the yard settles…','working')}
  function onMetrics(e){lastMetrics=e.detail||{};if(lastMetrics.collectionCandidate)setStatus('🚶 Collection detected — waiting for yard to settle…','working');updateThrowCounts()}

  function setBoard(index){App.setActiveBoard(Number(index)||0,true);updateThrowCounts();setStatus(`Board ${Number(index)+1} selected as active end`,'ready')}

  function init(){
    installVoiceGate();updateVoiceButton();
    if(localStorage.getItem('cornhole-v9-outdoor')==='on'){document.body.classList.add('outdoor');if($('outdoorBtn'))$('outdoorBtn').textContent='☀️ Outdoor ON'}
    const obs=new MutationObserver(()=>{inspectReview();syncStatus()});
    ['reviewText','tc','rn','sa','sb','nextThrow','s1','s2','autoBtn','winner'].forEach(id=>{const el=$(id);if(el)obs.observe(el,{childList:true,subtree:true,attributes:true})});
    window.addEventListener('yardroundchange',onRound);window.addEventListener('yardguard',onGuard);window.addEventListener('yardcollection',onCollection);window.addEventListener('yardvisionmetrics',onMetrics);
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&autoRunning()){keepAwake();unlockSound()}});
    document.addEventListener('pointerdown',unlockSound,{passive:true});
    document.querySelectorAll('button').forEach(b=>{if((b.textContent||'').includes('Test Cowbell'))b.onclick=testCowbell});
    updateThrowCounts();setStatus('Set the phone down, aim at the yard, and tap Start Game.','')
  }
  document.addEventListener('DOMContentLoaded',init);
  return{startGame,stopGame,rescan,hideFlash,toggleOutdoor,toggleVoice,toggleAutoRound,testCowbell,setBoard};
})();
