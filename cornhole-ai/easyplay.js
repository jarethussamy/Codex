const EasyPlay=(()=>{
  const $=id=>document.getElementById(id);
  let wakeLock=null,setupTimer=0,flashTimer=0,voiceOn=localStorage.getItem('cornhole-v8-voice')!=='off';
  let lastReview='',lastRound=1;

  function setStatus(text,state=''){
    const el=$('gameStatus'); if(!el)return;
    el.textContent=text; el.dataset.state=state;
  }
  function setStartButton(text,disabled=false){
    const b=$('startGameBtn'); if(!b)return; b.textContent=text; b.disabled=disabled;
  }
  async function keepAwake(){
    try{if('wakeLock'in navigator&&!wakeLock)wakeLock=await navigator.wakeLock.request('screen')}catch{}
  }
  async function releaseWake(){try{await wakeLock?.release?.()}catch{}wakeLock=null}

  function boardReady(){return $('s1')?.classList.contains('done')}
  function holeReady(){return $('s2')?.classList.contains('done')}
  function autoEnabled(){return $('autoBtn')&&!$('autoBtn').disabled}
  function autoRunning(){return $('autoBtn')?.textContent.includes('Disable')}

  async function startGame(){
    clearInterval(setupTimer); setupTimer=0;
    setStartButton('Starting…',true); setStatus('Starting rear camera…','working');
    try{
      await keepAwake();
      App.resetGame();
      await App.startCamera();
      const cam=$('cam');
      if(!cam?.srcObject&&!cam?.getAttribute('src')){setStatus('Camera needs attention — open Setup Help below.','error');setStartButton('▶ TRY AGAIN',false);return}
      App.rescanYard();
      setStatus('Finding boards and holes… hold the phone steady.','working');
      let checks=0;
      setupTimer=setInterval(()=>{
        checks++;
        if(boardReady()&&holeReady()&&autoEnabled()){
          if(!autoRunning())App.toggleAuto();
          clearInterval(setupTimer);setupTimer=0;
          setStatus('✅ READY — throw a bag','ready');
          setStartButton('✓ GAME RUNNING',false);
          updateThrowCounts();
        }else if(boardReady()){
          setStatus('Board found — locking onto the hole…','working');
        }else{
          setStatus('Scanning the whole yard for cornhole boards…','working');
        }
        if(checks>80){
          clearInterval(setupTimer);setupTimer=0;
          setStatus('Still scanning — adjust the phone so a board and hole are clearly visible.','warn');
          setStartButton('◎ RESCAN & START',false);
        }
      },350);
    }catch(e){setStatus('Setup error — open Setup Help and try again.','error');setStartButton('▶ TRY AGAIN',false)}
  }

  async function stopGame(){
    clearInterval(setupTimer);setupTimer=0;
    App.stopCamera();await releaseWake();
    setStatus('Game stopped.','');setStartButton('▶ START GAME',false);
  }

  function rescan(){
    App.rescanYard();setStatus('Rescanning boards and holes…','working');setStartButton('◎ SCANNING…',true);
    let checks=0;clearInterval(setupTimer);
    setupTimer=setInterval(()=>{
      checks++;
      if(boardReady()&&holeReady()&&autoEnabled()){
        if(!autoRunning())App.toggleAuto();clearInterval(setupTimer);setupTimer=0;
        setStatus('✅ READY — throw a bag','ready');setStartButton('✓ GAME RUNNING',false);
      }else if(checks>60){clearInterval(setupTimer);setupTimer=0;setStatus('Still scanning — adjust the camera and try again.','warn');setStartButton('◎ RESCAN & START',false)}
    },350)
  }

  function showFlash(team,result,points){
    const el=$('scoreFlash');if(!el)return;
    clearTimeout(flashTimer);
    const name=team.toUpperCase(),word=result==='HOLE'?'CORNHOLE!':result==='BOARD'?'ON THE BOARD':'MISS';
    el.className=`scoreFlash show ${team.toLowerCase()}`;
    el.innerHTML=`<div class="flashTeam">${team==='Blue'?'🔵':'🔴'} ${name}</div><div class="flashPoints">${points>0?'+':''}${points}</div><div class="flashCall">${word}</div><button onclick="App.undo();EasyPlay.hideFlash()">↶ Undo</button>`;
    flashTimer=setTimeout(()=>hideFlash(),2200)
  }
  function hideFlash(){const el=$('scoreFlash');if(el)el.className='scoreFlash'}

  function updateThrowCounts(){
    const total=parseInt($('tc')?.textContent||'0',10)||0;
    const first=$('firstTeam')?.value||'A';
    const firstCount=Math.ceil(total/2),secondCount=Math.floor(total/2);
    const blue=first==='A'?firstCount:secondCount,red=first==='B'?firstCount:secondCount;
    if($('blueBags'))$('blueBags').textContent=`${Math.min(4,blue)}/4 bags`;
    if($('redBags'))$('redBags').textContent=`${Math.min(4,red)}/4 bags`;
  }

  function inspectReview(){
    const text=$('reviewText')?.textContent||'';if(!text||text===lastReview)return;lastReview=text;
    const m=text.match(/Team (Blue|Red)\s*→\s*(HOLE|BOARD|MISS)\s*\((\d+) raw\)/i);
    if(m){showFlash(m[1][0].toUpperCase()+m[1].slice(1).toLowerCase(),m[2].toUpperCase(),Number(m[3]));updateThrowCounts();setStatus('Score confirmed — next bag','ready')}
  }

  function toggleOutdoor(){
    const on=!document.body.classList.contains('outdoor');document.body.classList.toggle('outdoor',on);localStorage.setItem('cornhole-v8-outdoor',on?'on':'off');
    if($('outdoorBtn'))$('outdoorBtn').textContent=on?'☀️ Outdoor ON':'☀️ Outdoor Mode';
  }
  function installVoiceGate(){
    try{
      const synth=window.speechSynthesis;if(!synth||synth.__yardVisionGate)return;
      const original=synth.speak.bind(synth);synth.speak=u=>{if(voiceOn)original(u)};synth.__yardVisionGate=true;
    }catch{}
  }
  function toggleVoice(){voiceOn=!voiceOn;localStorage.setItem('cornhole-v8-voice',voiceOn?'on':'off');if(!voiceOn)try{speechSynthesis.cancel()}catch{};updateVoiceButton()}
  function updateVoiceButton(){if($('voiceBtn'))$('voiceBtn').textContent=voiceOn?'🔊 Ref Voice ON':'🔇 Ref Voice OFF'}

  function syncStatus(){
    updateThrowCounts();
    const r=parseInt($('rn')?.textContent||'1',10)||1;
    if(r!==lastRound){lastRound=r;setStatus(`Round ${r} — ${$('nextThrow')?.textContent||'ready'}`,'ready')}
    if(autoRunning()&&boardReady()&&holeReady()&&!setupTimer&&!$('winner')?.textContent)setStartButton('✓ GAME RUNNING',false)
  }

  function init(){
    installVoiceGate();updateVoiceButton();
    if(localStorage.getItem('cornhole-v8-outdoor')==='on'){document.body.classList.add('outdoor');if($('outdoorBtn'))$('outdoorBtn').textContent='☀️ Outdoor ON'}
    const obs=new MutationObserver(()=>{inspectReview();syncStatus()});
    ['reviewText','tc','rn','sa','sb','nextThrow','s1','s2','autoBtn','winner'].forEach(id=>{const el=$(id);if(el)obs.observe(el,{childList:true,subtree:true,attributes:true})});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&autoRunning())keepAwake()});
    updateThrowCounts();setStatus('Set the phone down, aim at the yard, and tap Start Game.','');
  }
  document.addEventListener('DOMContentLoaded',init);
  return{startGame,stopGame,rescan,hideFlash,toggleOutdoor,toggleVoice};
})();