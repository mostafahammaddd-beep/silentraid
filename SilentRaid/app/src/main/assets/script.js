/*
  SILENT RAID gameplay source.
  Sections are intentionally kept in execution order: viewport → progress and
  stages → maze generation → game state → guard/camera AI → Canvas rendering →
  audio → UI events → fixed-rate game loop. Existing comments above functions
  describe compatibility constraints and non-obvious gameplay decisions.
*/
(() => {
  'use strict';

  const canvas = document.getElementById('gameCanvas');
  // The WebView stays on its hardware compositor. The previous permanent
  // software fallback stopped the flash but rasterized the whole game on the
  // CPU at a reduced resolution, which is why movement became choppy and the
  // map looked blurred. The surface-lock below fixes the transition without
  // sacrificing the normal hardware Canvas quality.
  const platformInfo=(typeof navigator!=='undefined')?navigator:{};
  const androidMatch=String(platformInfo.userAgent||'').match(/Android\s+(\d+)/i);
  const androidVersion=androidMatch?Number(androidMatch[1]):0;
  // The Android host also supplies a native verdict. Browser UA/device-memory
  // hints are incomplete on old System WebView builds, which is exactly where
  // the compositor reset appears, so native API/memory information is decisive.
  let nativeLegacyRenderer=false;
  try{
    nativeLegacyRenderer=!!(window.SilentRaidDevice &&
      typeof window.SilentRaidDevice.isLegacyRenderer==='function' &&
      window.SilentRaidDevice.isLegacyRenderer());
  }catch(_){}
  // Native software fallback is intentionally opt-in only. The bundled Android
  // host reports false and uses hardware rendering on every API level.
  const compatibilityRenderer=!!nativeLegacyRenderer;
  document.body.classList.toggle('legacy-renderer',compatibilityRenderer);
  // Base design height is kept fixed. The gameplay width is expanded to the
  // device's real aspect ratio before each new round, so the render stays
  // Map dimensions enlarged by 20% more (1040*1.2 = 1248, 780*1.2 = 936)
  const BASE_W = 1248, H = 936;
  // Camera zoom in by 20% + 22% more (1.9963 * 1.22 = 2.4355)
  const GAMEPLAY_CAMERA_ZOOM = 1.375 * 1.09 * 1.11 * 1.20 * 1.22; // 2.4355 (+22% camera zoom in)
  // Requested review changes:
  // - bricks are 40% smaller, so 60% of each wall cell remains solid brick
  // - passages are widened by another 7% without changing grid topology
  // - in-round guards are reduced by 20% from the previous build
  const BRICK_SIZE_RATIO = 0.60;
  // One-tile passage was ≈1.75c (brick insets + extra clearance 0.35).
  // Widen corridors by exactly 4% → 1.82c, which maps to extra ratio 0.42.
  const CORRIDOR_EXTRA_CLEARANCE_RATIO = 0.42;
  const THIEF_BASE_SCALE = (1.0077503436 * 1.10 * 0.91) * 0.98;
  const THIEF_CHARACTER_SCALE = THIEF_BASE_SCALE * 0.95 * 0.95; // thief: exactly 5% smaller again
const ROUND_CHARACTER_SCALE = THIEF_BASE_SCALE * 1.03 * 0.95; // guards: exactly 5% smaller
  const WALL_VERTICAL_SCALE = 1.09;
  const THIEF_COLLISION_SKIN = 0.0; // no invisible collision buffer beyond the visible wall footprint
  const THIEF_MOVE_COLLISION_RADIUS = 2.0; // close wall contact so thief base reaches the wall cleanly
  // Sprite layout shared by drawing and the thief AABB so the hitbox hugs the
  // visible silhouette. Values match drawPlayerVisual() exactly.
  const THIEF_SPRITE_CANVAS = 480;
  const THIEF_SPRITE_FEET_Y = 460;
  const THIEF_SPRITE_ANCHOR_Y = 472;
  const THIEF_SPRITE_DRAW_W_EMPTY = 44.5;
  const THIEF_SPRITE_DRAW_H_EMPTY = 49.0;
  const THIEF_SPRITE_DRAW_W_LOOT = 48.5;
  const THIEF_SPRITE_DRAW_H_LOOT = 49.5;
  const THIEF_RENDER_Y_OFFSET = 14;
  const THIEF_WALK_BOB_AMPLITUDE = 1.8;
  const THIEF_BODY_HALF_W = 13; // matches the floor-shadow capsule
  const THIEF_EDGE_PENETRATION = 0; // strict contact: no allowed overlap into bricks
  let W = BASE_W;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const thiefEmptyPoses = {
    left: new Image(),
    right: new Image(),
    down: new Image(),
    up: new Image()
  };
  thiefEmptyPoses.left.src = 'assets/thief-pose-left.webp';
  thiefEmptyPoses.right.src = 'assets/thief-pose-right.webp';
  thiefEmptyPoses.down.src = 'assets/thief-pose-down.webp';
  thiefEmptyPoses.up.src = 'assets/thief-pose-up.webp';

  const thiefLootPoses = {
    left: new Image(),
    right: new Image(),
    down: new Image(),
    up: new Image()
  };
  thiefLootPoses.left.src = 'assets/thief-pose-left-loot.webp';
  thiefLootPoses.right.src = 'assets/thief-pose-right-loot.webp';
  thiefLootPoses.down.src = 'assets/thief-pose-down-loot.webp';
  thiefLootPoses.up.src = 'assets/thief-pose-up-loot.webp';

  const thiefEmptyImg = thiefEmptyPoses.down;
  const thiefLootImg = thiefLootPoses.down;
  thiefEmptyPoses.down.onload = () => { if(typeof renderLevelSelectActors === 'function' && gameState === 'LEVELS') renderLevelSelectActors(); };

  // Android System WebView versions before Canvas roundRect support would throw
  // during the first gameplay render. A thrown draw call leaves the HUD visible
  // but the canvas black, so use the native primitive when available and a
  // standard path fallback everywhere else.
  function roundedRectPath(target, x, y, width, height, radius) {
    if (typeof target.roundRect === 'function') {
      target.roundRect(x, y, width, height, radius);
      return;
    }
    target.rect(x, y, width, height);
  }

  // Professional fullscreen renderer:
  // - the physical canvas always covers the entire phone viewport
  // - X/Y use one identical scale (never stretch)
  // - the playable world width expands to the device aspect ratio before a round
  // - the full logical height (including the top/bottom round edges) stays visible
  const viewport = {
    width: BASE_W, height: H, dpr: 1, scale: 1,
    cameraX: 0, cameraY: 0, viewW: BASE_W, viewH: H
  };
  let pendingSurfaceResize = 0;
  // A WebView can dispatch a burst of resize events while changing visible
  // screens even though this game is already locked to landscape. Reassigning
  // canvas.width during that burst repeatedly destroys its backing surface,
  // which is the characteristic black/pixel flicker seen on fragile GPUs.
  let gameplaySurfaceLocked = false;

  function getViewportSize(){
    // Prefer the actual game host over window.innerWidth/innerHeight. Old
    // WebViews can report several transient viewport sizes while immersive
    // system bars animate, even though the fixed game host never changed.
    const host=document.getElementById('gameWrap');
    const hostWidth=Number(host?.clientWidth)||0;
    const hostHeight=Number(host?.clientHeight)||0;
    return {
      width: Math.max(1, hostWidth || window.innerWidth || document.documentElement.clientWidth || BASE_W),
      height: Math.max(1, hostHeight || window.innerHeight || document.documentElement.clientHeight || H)
    };
  }

  // Adaptive render quality. The canvas backing store shrinks a step when this device cannot hold ~45fps,
  // and the learned level is remembered so the next launch starts from a sensible point instead of stuttering again.
  const QUALITY_KEY='silent_raid_quality_v1';
  const RENDER_DPR_CAP=2.5;          // sharper than before (was 2); the launch benchmark steps down on phones that can't hold it
  const RENDER_PIXEL_BUDGET=3.4e6;   // total backing-store pixels at the top tier
  const QUALITY_SCALES=[1,.85,.72,.6];
  let qualityLevel=0;
  // The last measured level is the starting guess; the launch benchmark below replaces it within ~0.5s.
  try{ qualityLevel=Math.max(0,Math.min(QUALITY_SCALES.length-1,(Number(localStorage.getItem(QUALITY_KEY))||1)-1)); }catch(_){}
  let perfAcc=0, perfN=0, perfBad=0, perfWarm=0;
  let thiefSpriteCache=new WeakMap();
  // Safety net only (the launch benchmark makes the real decision): needs two consecutive slow 90-frame windows,
  // and ignores the first second after the loop (re)starts while sprite caches and shaders warm up.
  function monitorFramePerformance(rawMs){
    if(gameState!=='PLAYING' || rawMs>120) return;   // ignore pauses / ad overlays / tab switches
    if(perfWarm>0){ perfWarm--; return; }
    perfAcc+=rawMs; perfN++;
    if(perfN<90) return;
    const avg=perfAcc/perfN; perfAcc=0; perfN=0;
    perfBad = avg>26 ? perfBad+1 : 0;
    if(perfBad>=2 && qualityLevel<QUALITY_SCALES.length-1){
      perfBad=0; qualityLevel++;
      try{ localStorage.setItem(QUALITY_KEY,String(qualityLevel+1)); }catch(_){}
      layoutGameSurface();
    }
  }

  // ---- Launch benchmark -------------------------------------------------------------------------------
  // Goal: know the best resolution this phone sustains BEFORE the first round, invisibly and in a few ms.
  //  * It renders a gameplay-like frame on a detached canvas: full-screen floor gradient + tiles + walls +
  //    guard rings + sprite + the full-screen fog gradient (the real per-frame costs).
  //  * One GPU flush per small batch (a 1x1 readback) so the clock includes real rasterisation, not just JS.
  //  * Tiny time slices (3 frames) between setTimeout yields, so the menu animation never stutters.
  //  * Strong phone: one slice (~3 frames) is enough -> done in a few milliseconds.
  //    Weak phone: tier 0 is measured once, the other tiers are PREDICTED (cost scales with pixel count),
  //    and only the chosen tier is verified -> never more than a handful of slices.
  //  * Median of batches, so one GC pause / background task cannot skew the result.
  const BENCH_BUDGET_MS=8;
  function createBenchTier(width,height,dpr,spriteCv){
    const c=document.createElement('canvas');
    c.width=Math.max(1,Math.round(width*dpr)); c.height=Math.max(1,Math.round(height*dpr));
    const g=c.getContext('2d');
    const lg=g.createLinearGradient(0,0,width,height); lg.addColorStop(0,'#3b342c'); lg.addColorStop(.5,'#2a241e'); lg.addColorStop(1,'#171411');
    const R=Math.min(width,height)*.5;
    const fog=g.createRadialGradient(width/2,height/2,R*.35,width/2,height/2,R);
    fog.addColorStop(0,'rgba(0,0,0,0)'); fog.addColorStop(.65,'rgba(0,0,0,.08)'); fog.addColorStop(.88,'rgba(0,0,0,.55)'); fog.addColorStop(1,'rgba(0,0,0,1)');
    const paint=(k)=>{
      g.setTransform(dpr,0,0,dpr,0,0);
      g.fillStyle='#090a0c'; g.fillRect(0,0,width,height);
      g.fillStyle=lg; g.fillRect(0,0,width,height);
      g.fillStyle='rgba(240,201,108,.05)'; g.beginPath();
      for(let i=0;i<80;i++) g.rect((i*37)%width,(i*53+k)%height,40,40); g.fill();
      g.strokeStyle='rgba(212,184,120,.4)'; g.lineWidth=1; g.beginPath();
      for(let i=0;i<80;i++) g.rect(((i*37)%width)+.5,((i*53+k)%height)+.5,39,39); g.stroke();
      g.fillStyle='#4a4038'; g.beginPath();
      for(let i=0;i<50;i++){ const x=(i*61)%width,y=(i*29)%height; g.moveTo(x,y); g.lineTo(x+44,y+4); g.lineTo(x+40,y+40); g.lineTo(x+2,y+36); g.closePath(); }
      g.fill();
      for(let i=0;i<3;i++){
        const x=width*(.25+i*.25), y=height*.5;
        g.globalAlpha=.09; g.fillStyle='#22c55e'; g.beginPath(); g.arc(x,y,122,0,Math.PI*2); g.fill();
        g.globalAlpha=.32; g.strokeStyle='#22c55e'; g.setLineDash([6,8]); g.lineWidth=8; g.stroke(); g.lineWidth=2; g.stroke(); g.setLineDash([]);
        g.globalAlpha=1;
      }
      g.drawImage(spriteCv,width/2-60+(k%5),height/2-60,120,120);
      g.fillStyle=fog; g.fillRect(0,0,width,height);
    };
    paint(0); g.getImageData(0,0,1,1);                  // warm-up (shader/texture creation) - not timed
    return {
      batch(n){                                          // average ms/frame over n frames, GPU flushed
        const t0=performance.now();
        for(let f=1;f<=n;f++) paint(f);
        g.getImageData(0,0,1,1);
        return (performance.now()-t0)/n;
      },
      dispose(){ c.width=c.height=0; }
    };
  }
  function calibrateRenderQuality(schedule){
    schedule=schedule||((fn)=>setTimeout(fn,0));
    let width,height;
    try{ ({width,height}=getViewportSize()); }catch(_){ return; }
    if(!(width>0&&height>0)) return;
    let baseDpr=Math.min(RENDER_DPR_CAP,Math.max(1,window.devicePixelRatio||1));
    baseDpr=Math.min(baseDpr,Math.sqrt(RENDER_PIXEL_BUDGET/Math.max(1,width*height)));
    const dprOf=(t)=>Math.max(.75,baseDpr*QUALITY_SCALES[t]);
    const spriteCv=document.createElement('canvas'); spriteCv.width=spriteCv.height=128;
    try{ const sg=spriteCv.getContext('2d'); const gr=sg.createRadialGradient(50,44,6,64,64,60); gr.addColorStop(0,'#f5d28a'); gr.addColorStop(1,'#3a2a14'); sg.fillStyle=gr; sg.beginPath(); sg.arc(64,64,60,0,Math.PI*2); sg.fill(); }catch(_){}
    const log={tiers:{},chosen:-1,slices:0};
    const median=(a)=>a.slice().sort((x,y)=>x-y)[a.length>>1];
    const finish=(chosen)=>{
      log.chosen=chosen; window.__srQuality=log;
      qualityLevel=chosen;
      try{ localStorage.setItem(QUALITY_KEY,String(chosen+1)); }catch(_){}
      perfAcc=0; perfN=0; perfBad=0;
      try{ layoutGameSurface(); }catch(_){}
    };
    // Measure one tier in small slices. cb(medianMs) is called when done; `early(v,samples)` may cut it short.
    const measure=(tier,maxBatches,early,cb)=>{
      let bench; try{ bench=createBenchTier(width,height,dprOf(tier),spriteCv); }catch(_){ cb(Infinity); return; }
      const samples=[];
      const slice=()=>{
        log.slices++;
        let v; try{ v=bench.batch(3); }catch(_){ v=Infinity; }
        samples.push(v);
        const verdict=early?early(v,samples):null;
        if(verdict==='stop' || samples.length>=maxBatches){ bench.dispose(); const m=median(samples); log.tiers[tier]=Math.round(m*10)/10; cb(m); return; }
        schedule(slice);
      };
      schedule(slice);
    };
    const last=QUALITY_SCALES.length-1;
    // 1) tier 0: a clearly strong phone (<= half the budget) is decided after ONE slice; a clearly weak one after one too.
    measure(0,3,(v,s)=>(s.length===1&&(v<=BENCH_BUDGET_MS*.5||v>BENCH_BUDGET_MS*3))?'stop':null,(cost0)=>{
      if(cost0<=BENCH_BUDGET_MS){ finish(0); return; }
      // 2) predict the other tiers (cost ~ pixels ~ dpr^2) and pick the best predicted fit...
      let pick=last;
      for(let t=1;t<=last;t++){ const ratio=dprOf(t)/dprOf(0); if(cost0*ratio*ratio<=BENCH_BUDGET_MS*.95){ pick=t; break; } }
      // 3) ...then verify just that tier once; if the prediction was optimistic, drop one more tier.
      measure(pick,1,null,(c)=>{ finish((c>BENCH_BUDGET_MS*1.35 && pick<last)?pick+1:pick); });
    });
  }

  function prepareLogicalGameplayWidth(){
    const {width,height}=getViewportSize();
    // Keep the original 4:3 layout on 4:3-or-narrower displays. On wider
    // landscape displays, widen the actual generated world instead of stretching it.
    W = Math.max(BASE_W, H * (width / Math.max(1,height)));
  }

  function resizeGameSurface(){
    if(gameplaySurfaceLocked) return;
    layoutGameSurface();
  }
  function layoutGameSurface(){
    const {width,height}=getViewportSize();
    // Keep a sharp backing store on every device. The cap avoids wasting memory
    // on 3x/4x panels while preserving the visual quality used on newer phones.
    // Render at the screen's real resolution (up to 2x) so walls, guards and the thief are crisp. A total pixel
    // budget keeps big tablets cheap, and the adaptive quality step lowers it only if the device cannot keep up.
    let dpr=Math.min(RENDER_DPR_CAP,Math.max(1,window.devicePixelRatio||1));
    dpr=Math.min(dpr,Math.sqrt(RENDER_PIXEL_BUDGET/Math.max(1,width*height)));
    dpr=Math.max(.75,dpr*QUALITY_SCALES[qualityLevel]);
    thiefSpriteCache=new WeakMap();
    viewport.width = width;
    viewport.height = height;
    viewport.dpr = dpr;

    // Uniform gameplay scale with the requested 20% reduction in camera height.
    // The result is a closer top-down view without stretching the scene.
    viewport.scale = (height / H) * GAMEPLAY_CAMERA_ZOOM;
    viewport.viewW = width / viewport.scale;
    viewport.viewH = height / viewport.scale;

    const pixelWidth=Math.max(1, Math.round(width * dpr));
    const pixelHeight=Math.max(1, Math.round(height * dpr));
    // Assigning canvas.width/height clears its backing store and forces a GPU
    // allocation. Older WebViews can emit several identical resize events while
    // entering landscape; avoid repeatedly discarding/recreating that texture.
    if(canvas.width!==pixelWidth) canvas.width=pixelWidth;
    if(canvas.height!==pixelHeight) canvas.height=pixelHeight;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
  }

  function updateCamera(){
    // Follow the burglar so the closer camera remains centered during movement.
    // Clamp the camera to the logical world to avoid exposing coordinates beyond it.
    const p = world?.player;
    const targetX = p ? p.x - viewport.viewW * 0.5 : (W - viewport.viewW) * 0.5;
    const targetY = p ? p.y - viewport.viewH * 0.5 : (H - viewport.viewH) * 0.5;
    viewport.cameraX = Math.max(0, Math.min(Math.max(0, W - viewport.viewW), targetX));
    viewport.cameraY = Math.max(0, Math.min(Math.max(0, H - viewport.viewH), targetY));
  }

  function scheduleGameSurfaceResize(){
    if(gameplaySurfaceLocked) return;
    if(pendingSurfaceResize) return;
    pendingSurfaceResize=requestAnimationFrame(()=>{
      pendingSurfaceResize=0;
      resizeGameSurface();
    });
  }
  window.addEventListener('resize', scheduleGameSurfaceResize, {passive:true});
  window.addEventListener('orientationchange', () => setTimeout(scheduleGameSurfaceResize, 160), {passive:true});

  const screens = {
    MENU: document.getElementById('menuScreen'),
    PLAYING: document.getElementById('gameScreen'),
    SUCCESS: document.getElementById('successScreen'),
    FAILURE: document.getElementById('failureScreen'),
    LEVELS: document.getElementById('levelSelectScreen')
  };

  let gameState = 'MENU';
  let isMapFullyLoaded = false;
  let isGameOver = false;
  let isMuted = false;
  const MUSIC_PREF_KEY = 'silent_raid_music_enabled_v1';
  const CONTROL_LAYOUT_KEY = 'silent_raid_control_layout_v2';
  const JOYSTICK_MODE_KEY = 'silent_raid_joystick_mode_v2';
  let musicEnabled = true;
  let controlLayout = 'analog-left';
  let joystickFloating = false;
  try {
    const savedMusic = localStorage.getItem(MUSIC_PREF_KEY);
    if(savedMusic !== null) musicEnabled = savedMusic !== '0';
    const savedLayout = localStorage.getItem(CONTROL_LAYOUT_KEY);
    if(savedLayout === 'analog-left' || savedLayout === 'analog-right') controlLayout = savedLayout;
    const savedJoystickMode = localStorage.getItem(JOYSTICK_MODE_KEY);
    if(savedJoystickMode === 'floating') joystickFloating = true;
    else joystickFloating = false;
  } catch(_) {}

  function applyControlLayout(layout){
    controlLayout = (layout === 'analog-left') ? 'analog-left' : 'analog-right';
    try { localStorage.setItem(CONTROL_LAYOUT_KEY, controlLayout); } catch(_) {}
    const appEl=document.getElementById('app');
    if(appEl) appEl.dataset.controlLayout=controlLayout;
    document.querySelectorAll('.control-choice').forEach(btn=>btn.classList.toggle('selected', btn.dataset.layout===controlLayout));
  }


  function applyJoystickMode(floating){
    joystickFloating=!!floating;
    try{localStorage.setItem(JOYSTICK_MODE_KEY,joystickFloating?'floating':'fixed');}catch(_){}
    const appEl=document.getElementById('app');
    if(appEl) appEl.dataset.joystickMode=joystickFloating?'floating':'fixed';
    const toggle=document.getElementById('floatingJoystickToggle');
    if(toggle){toggle.checked=joystickFloating;toggle.setAttribute('aria-checked',String(joystickFloating));}
    if(!joystickFloating && joystick){
      joystick.classList.remove('floating-active');
      joystick.style.removeProperty('left');joystick.style.removeProperty('top');
      joystick.style.removeProperty('right');joystick.style.removeProperty('bottom');
    }
  }

  function setMusicEnabled(next){
    musicEnabled=!!next;
    try { localStorage.setItem(MUSIC_PREF_KEY, musicEnabled ? '1' : '0'); } catch(_) {}
    updateMusicUi();
    try {
      if(!musicEnabled){
        if(mainTitleMusic){ mainTitleMusic.pause(); mainTitleMusic.muted=true; }
        if(resultMusic){ resultMusic.pause(); resultMusic.muted=true; }
        if(gameOverMusic){ gameOverMusic.pause(); gameOverMusic.muted=true; }
        try{ stopLocalMusic(); }catch(_){}
      }else{
        if(audio?.ac && music.finalGain){
          music.finalGain.gain.cancelScheduledValues(audio.ac.currentTime);
          music.finalGain.gain.setTargetAtTime(GAMEPLAY_LOCAL_MUSIC_GAIN,audio.ac.currentTime,.05);
        }
        if(gameState==='MENU' || gameState==='LEVELS'){ titleMusicGestureUnlocked=true; fadeMainTitleIn(false); }
        else if(gameState==='PLAYING'){ setMainTitleGameplayVolume(); }
      }
    } catch(_) {}
  }

  function updateMusicUi(){
    const enabledText  = 'إيقاف الموسيقى';
    const disabledText = 'تشغيل الموسيقى';
    const enabledIcon  = '🔈';
    const disabledIcon = '🔇';
    ['musicToggleBtn','settingsMusicToggle'].forEach(id=>{
      const btn=document.getElementById(id);
      if(!btn) return;
      const labelEl = btn.querySelector('.music-label');
      const iconEl  = btn.querySelector('.music-icon');
      if(labelEl) {
        labelEl.textContent = musicEnabled ? enabledText : disabledText;
      }
      if(iconEl) {
        iconEl.textContent = musicEnabled ? enabledIcon : disabledIcon;
      }
      if(!labelEl && !iconEl) {
        btn.textContent = musicEnabled ? ('🎵 ' + enabledText) : ('🔇 ' + disabledText);
      }
      btn.setAttribute('aria-pressed', String(!musicEnabled));
    });
  }

  let audio = null;
  let vaultAudio = null;
  let escapeAudio = null;
  let mainTitleMusic = null;
  let mainTitleFadeTimer = 0;
  let resultMusic = null;
  let gameOverMusic = null;
  let resultMusicFadeTimer = 0;
  let resultTransitioning = false;
  let appAudioSuspended = false;
  let appAudioResumeTimer = 0;
  let lastFrame = performance.now();

  function stopAllAudioForAppBackground(){
    try{ sirenStop(true); }catch(_){}
    appAudioSuspended = true;
    if(appAudioResumeTimer){ clearTimeout(appAudioResumeTimer); appAudioResumeTimer=0; }
    try{ if(mainTitleFadeTimer) clearInterval(mainTitleFadeTimer); mainTitleFadeTimer=0; }catch(_){}
    try{ if(resultMusicFadeTimer) clearInterval(resultMusicFadeTimer); resultMusicFadeTimer=0; }catch(_){}
    for(const t of [mainTitleMusic,resultMusic,gameOverMusic,vaultAudio,escapeAudio]){
      try{ if(t){ t.pause(); t.muted=true; } }catch(_){}
    }
    try{ stopLocalMusic(); }catch(_){}
    try{ if(audio?.ac && audio.ac.state==='running') audio.ac.suspend().catch(()=>{}); }catch(_){}
    try{ if(typeof stopGameRenderLoop==='function') stopGameRenderLoop(); }catch(_){}
  }

  function resumeAllAudioAfterAppForeground(){
    if(!appAudioSuspended) return;
    appAudioSuspended = false;
    if(appAudioResumeTimer) clearTimeout(appAudioResumeTimer);
    appAudioResumeTimer=setTimeout(()=>{
      appAudioResumeTimer=0;
      try{
        if(typeof startGameRenderLoop==='function' && !gameLoopActive) startGameRenderLoop();
      }catch(_){}
      if(!musicEnabled) return;
      try{
        if(audio?.ac?.state==='suspended') audio.ac.resume().catch(()=>{});
        if(gameState==='MENU' || gameState==='LEVELS'){
          if(mainTitleMusic) mainTitleMusic.muted=false;
          titleMusicGestureUnlocked=true;
          fadeMainTitleIn(false);
        }else if(gameState==='PLAYING'){
          if(mainTitleMusic) mainTitleMusic.muted=false;
          startNativeMusic();
          setMainTitleGameplayVolume();
        }else{
          if(mainTitleMusic && !mainTitleMusic.paused) mainTitleMusic.muted=false;
          if(resultMusic) resultMusic.muted=false;
          if(gameOverMusic) gameOverMusic.muted=false;
        }
      }catch(_){}
    },60);
  }

  window.__silentRaidAppHidden = stopAllAudioForAppBackground;
  window.__silentRaidAppVisible = resumeAllAudioAfterAppForeground;

  document.addEventListener('visibilitychange',()=>{
    if(document.hidden) stopAllAudioForAppBackground();
    else resumeAllAudioAfterAppForeground();
  });
  window.addEventListener('pagehide',()=>stopAllAudioForAppBackground(),{passive:true});
  window.addEventListener('pageshow',()=>resumeAllAudioAfterAppForeground(),{passive:true});
  let gameFrameRaf = 0;
  let gameLoopActive = false;

  const input = { x: 0, y: 0, keys: new Set(), joystickActive: false };
  const level = { stage: 1, level: 1, turn: 1, totalLevels: 35 };
  const TOTAL_LEVELS = 35;
  const UNLOCK_KEY = 'silent_raid_v9_unlocked_rounds_v1';
  const LEGACY_UNLOCK_KEY = 'silent_raid_v8_unlocked_rounds_v1';
  const DEFAULT_UNLOCKED = 15;
  function getUnlockedTurn(){
    try{
      const saved=Number(localStorage.getItem(UNLOCK_KEY));
      if(Number.isFinite(saved)&&saved>=1) return Math.min(TOTAL_LEVELS,Math.floor(saved));
      const legacy=Number(localStorage.getItem(LEGACY_UNLOCK_KEY));
      // Migrate legacy progress cleanly
      if(Number.isFinite(legacy)&&legacy>=1) return Math.min(TOTAL_LEVELS,Math.floor(legacy));
      return DEFAULT_UNLOCKED;
    }catch(_){ return DEFAULT_UNLOCKED; }
  }
  function isRoundUnlocked(stage,round){
    const s=Math.max(1,Math.min(5,Number(stage)||1));
    const r=Math.max(1,Math.min(7,Number(round)||1));
    const globalTurn=((s-1)*7)+r;
    return globalTurn<=getUnlockedTurn();
  }
  function markRoundCompleted(stage,round){
    const completed=((stage-1)*7)+round;
    const next=Math.min(TOTAL_LEVELS,completed+1);
    try{ localStorage.setItem(UNLOCK_KEY,String(Math.max(getUnlockedTurn(),next))); }catch(_){}
  }
  // Stage art is loaded by its visible <img>. Keeping five large decoded JPEGs
  // resident before a round starts is unnecessary and can evict Canvas textures
  // on low-memory Android WebViews.
  const STAGE_META = [
    { id: 1, name: 'المرحلة البرونزية', subtitle: '', tone: 'bronze', emblem: '🛡️' },
    { id: 2, name: 'المرحلة الفضية', subtitle: '', tone: 'silver', emblem: '⚔️' },
    { id: 3, name: 'المرحلة الذهبية', subtitle: '', tone: 'gold', emblem: '👑' },
    { id: 4, name: 'المرحلة الألماسية', subtitle: '', tone: 'diamond', emblem: '💎' },
    { id: 5, name: 'المرحلة الأسطورية', subtitle: '', tone: 'mythic', emblem: '🐉' }
  ];
  const ROUND_MISSION = {
    1: { title: 'الفانوس', motif: 'lantern' },
    2: { title: 'الكاميرات', motif: 'camera' },
    3: { title: 'الحراس', motif: 'guard' },
    4: { title: 'المتاهة', motif: 'maze' },
    5: { title: 'الخزنة', motif: 'vault' },
    6: { title: 'الإنذار', motif: 'alarm' },
    7: { title: 'الهروب', motif: 'escape' }
  };
  const STAGE_TUNING = {
    1: { theme: 'bronze', cameraMultiplier: .75, guardCount: 1, guardSpeedMult: 1.040, mazeLoopMultiplier: 1.00, corridorMultiplier: 1.00, alternateRoutes: 10, timeMultiplier: 1.00 },
    2: { theme: 'silver', cameraMultiplier: .80, guardCount: 2, guardSpeedMult: 1.061, mazeLoopMultiplier: 1.00, corridorMultiplier: 1.00, alternateRoutes: 10, timeMultiplier: 1.00 },
    3: { theme: 'gold',   cameraMultiplier: .85, guardCount: 3, guardSpeedMult: 1.040, mazeLoopMultiplier: .96, corridorMultiplier: .96, alternateRoutes: 9,  timeMultiplier: .96 },
    4: { theme: 'diamond',cameraMultiplier: 0.88, guardCount: 3, guardSpeedMult: 1.060, mazeLoopMultiplier: .88, corridorMultiplier: .88, alternateRoutes: 8,  timeMultiplier: .88 }, // -12% cameras
    5: { theme: 'mythic', cameraMultiplier: 1.056, guardCount: 3, guardSpeedMult: 1.080, mazeLoopMultiplier: .78, corridorMultiplier: .78, alternateRoutes: 7,  timeMultiplier: .78 }  // -12% cameras
  };
  const STAGE_PALETTES = {
    bronze: {
      world: '#080503',
      floorA: '#24170d',
      floorB: '#17100a',
      floorC: '#0d0805',
      wall: '#b87333',
      wallShade: '#75451f',
      wallTop: '#e0a15c',
      glow: '205,127,50',     // Authentic bronze seam glow
      line: '205,127,50',
      accent: '#cd7f32',      // Crisp bronze accent
      borderGlow: 'rgba(205,127,50,0.85)',
      rimColor: '#cbd5e1'
    },
    silver: {
      world: '#03060a',
      floorA: '#111820',
      floorB: '#0a1016',
      floorC: '#05090d',
      wall: '#b9c3ce',
      wallShade: '#687786',
      wallTop: '#f2f6fa',
      glow: '148,163,184',
      line: '148,163,184',
      accent: '#f8fafc',
      borderGlow: 'rgba(226,232,240,0.90)',
      rimColor: '#cbd5e1'
    },
    gold: {
      world: '#030906',
      floorA: '#091f15',
      floorB: '#05120c',
      floorC: '#020704',
      wall: '#7c5810',        // Pure solid gold vault masonry on dark emerald obsidian marble floor (kept as approved)
      wallShade: '#4f3607',
      wallTop: '#a87916',
      glow: '245,158,11',
      line: '245,158,11',
      accent: '#f59e0b',
      borderGlow: 'rgba(245,158,11,0.85)',
      rimColor: '#d97706'
    },
    diamond: {
      world: '#05050a',
      floorA: '#121220',
      floorB: '#090912',
      floorC: '#040408',
      wall: '#0284c7',
      wallShade: '#0369a1',
      wallTop: '#38bdf8',
      glow: '56,189,248',
      line: '56,189,248',
      accent: '#38bdf8',
      borderGlow: 'rgba(56,189,248,0.90)',
      rimColor: '#0ea5e9'
    },
    mythic: {
      world: '#050305',
      floorA: '#18121a',
      floorB: '#100c12',
      floorC: '#080509',
      wall: '#3b2034',
      wallShade: '#231120',
      wallTop: '#58324f',
      glow: '168,85,247',     // Muted mystical runic ember glow
      line: '168,85,247',
      accent: '#a855f7',
      borderGlow: 'rgba(168,85,247,0.55)',
      rimColor: '#7e22ce'
    }
  };
  function getStageTuning(stage){ return STAGE_TUNING[stage] || STAGE_TUNING[1]; }
  let world = null;
  // The world variable is now initialized before the first viewport sizing pass.
  resizeGameSurface();

  const DIFF = {
    1:  { corridor: 3, room: 5 },
    2:  { corridor: 3, room: 5 },
    3:  { corridor: 3, room: 5 },
    4:  { corridor: 2, room: 4 },
    5:  { corridor: 2, room: 4 },
    6:  { corridor: 2, room: 4 },
    7:  { corridor: 1, room: 3 },
    8:  { corridor: 1, room: 3 },
    9:  { corridor: 1, room: 3 },
    10: { corridor: 1, room: 3 }
  };

  function setState(next) {
    const leavingResult = (gameState==='SUCCESS'||gameState==='FAILURE') && next!=='SUCCESS' && next!=='FAILURE';
    if(next!=='SUCCESS' && next!=='FAILURE') stopResultRain();
    if(leavingResult) fadeResultMusicOut(()=>setGameplayMusicAfterResult());
    // Lock before the CSS screen transition can provoke any WebView resize.
    // Landscape gameplay has no legitimate viewport resize during a round.
    gameplaySurfaceLocked = next === 'PLAYING';
    const prevState = gameState;
    gameState = next;
    // The gameplay host is already edge-to-edge. Toggling this old body class
    // activated several legacy, conflicting fixed/100vw/100vh rule sets in the
    // stylesheet. On older WebViews that creates a layout/resize oscillation
    // precisely when the Canvas first appears, so keep one stable layout path.
    document.body.classList.remove('gameplay-fullscreen');
    // The game simulation/render loop is only needed while actually playing.
    // Keeping the 60fps loop alive on MENU/LEVELS was unnecessary main-thread work
    // and competed directly with the menu compositor animation.
    if(next==='PLAYING') startGameRenderLoop(); else stopGameRenderLoop();
    Object.entries(screens).forEach(([key, el]) => {
      if(!el) return;
      const active = key === next;
      el.classList.toggle('active', active);
      el.setAttribute('aria-hidden', active ? 'false' : 'true');
      // Never force display/opacity on result screens here. Their normal .screen/.screen.active
      // CSS contract is what keeps them hidden at boot and visible only after a real result.
      el.style.removeProperty('position');
      el.style.removeProperty('inset');
      el.style.removeProperty('z-index');
      el.style.removeProperty('display');
      el.style.removeProperty('opacity');
      el.style.removeProperty('visibility');
      el.style.removeProperty('pointer-events');
    });
    if(next==='LEVELS') document.getElementById('levelSelectScreen')?.classList.remove('ls-launching');
    if(next==='PLAYING') screens.PLAYING?.classList.remove('rx-fail','rx-success');
    Object.values(screens).forEach(el=>{ if(el){ el.classList.remove('leaving','entering'); } });
    if(prevState!==next && screens[prevState] && screens[next]){
      // Every screen change: the old screen stays painted underneath while the new one fades in on top
      // (compositor-only opacity), so there is never a hard cut to black.
      screens[prevState].classList.add('leaving');
      screens[next].classList.add('entering');
      clearTimeout(setState._xf);
      setState._xf=setTimeout(()=>{ Object.values(screens).forEach(el=>el&&el.classList.remove('leaving','entering')); document.getElementById('levelSelectScreen')?.classList.remove('ls-launching'); },480);
    }
    if (next !== 'PLAYING') resetInput();

    // The uploaded MP3 is the single background track for MENU + LEVELS.
    // Keep the same HTMLAudioElement alive so playback position is continuous
    // while moving from the main menu to the round-selection screen.
    if(next==='MENU'){ fadeMainTitleIn(false, 0.28); }
    else if(next==='LEVELS'){ fadeMainTitleIn(false, 0.28); }
    else if(next==='PLAYING'){ fadeMainTitleIn(false, GAMEPLAY_MUSIC_VOLUME); }
    else { fadeMainTitleOut(); }
  }

  function resetInput() { input.x = 0; input.y = 0; input.keys.clear(); input.joystickActive = false; smoothInputX = 0; smoothInputY = 0; }

  class RNG {
    constructor(seed) { this.s = seed >>> 0; }
    next() { this.s = (1664525 * this.s + 1013904223) >>> 0; return this.s / 4294967296; }
    int(a, b) { return Math.floor(this.next() * (b - a + 1)) + a; }
  }

  function hashSeed(stage, lvl, turn) {
    const t = Date.now() >>> 0;
    return (t ^ (stage * 73856093) ^ (lvl * 19349663) ^ (turn * 83492791)) >>> 0;
  }

  function buildMaze(seed) {
    const rng = new RNG(seed);
    const d = DIFF[level.level];
    const tuning = getStageTuning(level.stage);
    // Passage width is widened visually/physically by 30% relative to the original grid, preserving matched wall/collision geometry.
    // The grid topology stays unchanged so pathfinding remains stable.
    const cell = Math.round((level.level <= 3 ? 38 : level.level <= 7 ? 34 : 30) * 1.05);
    const cols = Math.floor((W - 22) / cell), rows = Math.floor((H - 66) / cell);
    const grid = Array.from({ length: rows }, () => Array(cols).fill(1));
    const walk = [];

    function carve(x, y) {
      grid[y][x] = 0; walk.push([x, y]);
      const dirs = [[2,0],[-2,0],[0,2],[0,-2]];
      for (let i = dirs.length - 1; i > 0; i--) { const j = rng.int(0, i); [dirs[i], dirs[j]] = [dirs[j], dirs[i]]; }
      dirs.forEach(([dx,dy]) => {
        const nx=x+dx, ny=y+dy;
        if (nx>0 && ny>0 && nx<cols-1 && ny<rows-1 && grid[ny][nx]===1) { grid[y+dy/2][x+dx/2]=0; carve(nx,ny); }
      });
    }
    carve(1, 1);

    // Turn the raw maze into a bank floorplan with dependable escape routes.
    // We keep decorative walls, but deliberately remove terminal dead-end pockets
    // from the navigable graph so the player can never be trapped at a corridor tip.
    function neighbors4(x,y){
      return [[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy])=>[x+dx,y+dy]);
    }
    const loopBudget = Math.max(8, Math.floor((cols * rows) * (level.level <= 2 ? 0.055 : level.level <= 4 ? 0.045 : 0.035) * tuning.mazeLoopMultiplier));
    for (let pass = 0; pass < loopBudget; pass++) {
      const candidates = [];
      for (let y = 1; y < rows - 1; y++) {
        for (let x = 1; x < cols - 1; x++) {
          if (grid[y][x] !== 1) continue;
          const floorNeighbors = neighbors4(x,y).filter(([nx,ny])=>grid[ny]?.[nx]===0).length;
          // Prefer punching through walls that join two existing corridors.
          if (floorNeighbors >= 2) candidates.push([x,y]);
        }
      }
      if (!candidates.length) break;
      const [wx, wy] = candidates[rng.int(0, candidates.length - 1)];
      grid[wy][wx] = 0;
    }

    // Hard 2-core cleanup: repeatedly open a neighboring wall for every terminal
    // floor tile until the playable graph has no corridor end-pockets. This is
    // intentionally stronger than the old four-pass cleanup and runs before
    // objectives, hazards, cameras, and guards are placed.
    for (let pass = 0; pass < 32; pass++) {
      const deadEnds = [];
      for (let y = 1; y < rows - 1; y++) {
        for (let x = 1; x < cols - 1; x++) {
          if (grid[y][x] !== 0) continue;
          const n = neighbors4(x,y).filter(([nx,ny])=>grid[ny]?.[nx]===0).length;
          if (n <= 1 && !(x===1&&y===1)) deadEnds.push([x,y]);
        }
      }
      if (!deadEnds.length) break;
      let changed = false;
      for (const [x,y] of deadEnds) {
        const walls = neighbors4(x,y).filter(([nx,ny])=>nx>0&&ny>0&&nx<cols-1&&ny<rows-1&&grid[ny][nx]===1);
        if (!walls.length) continue;
        let best=-Infinity, chosen=[];
        for (const [wx,wy] of walls) {
          const score = neighbors4(wx,wy).filter(([ax,ay])=>grid[ay]?.[ax]===0).length * 10
            + neighbors4(wx,wy).filter(([ax,ay])=>grid[ay]?.[ax]===0 && !(ax===x&&ay===y)).length * 2
            + rng.next()*1.5;
          if(score>best){best=score;chosen=[[wx,wy]];} else if(Math.abs(score-best)<0.001) chosen.push([wx,wy]);
        }
        const [ox,oy]=chosen[rng.int(0,chosen.length-1)];
        grid[oy][ox]=0;
        changed = true;
      }
      if (!changed) break;
    }

    // Final dead-end bridge pass. The previous implementation ran a full BFS
    // across the entire maze for every terminal tile, then repeated it up to
    // rows*cols times. That is quadratic/cubic work at round start and is enough
    // to stall older Android WebViews. A local repair has the same gameplay
    // invariant (terminal corridors are opened into loops), without blocking the
    // UI thread while a round is loading.
    function bridgeDeadEnds(){
      const repairPasses=8;
      for(let pass=0;pass<repairPasses;pass++){
        const deadEnds=[];
        for(let y=0;y<rows;y++) for(let x=0;x<cols;x++){
          if(grid[y][x]!==0) continue;
          const n=neighbors4(x,y).filter(([nx,ny])=>grid[ny]?.[nx]===0).length;
          if(n<=1) deadEnds.push([x,y]);
        }
        if(!deadEnds.length) return;
        let changed=false;
        for(const [sx,sy] of deadEnds){
          const walls=neighbors4(sx,sy).filter(([x,y])=>x>0&&y>0&&x<cols-1&&y<rows-1&&grid[y][x]===1);
          if(!walls.length) continue;
          // Prefer a wall that already touches another passage: opening it makes
          // a loop immediately. The RNG tie-breaker preserves varied layouts.
          let best=-Infinity, chosen=null;
          for(const [wx,wy] of walls){
            const score=neighbors4(wx,wy).filter(([x,y])=>grid[y]?.[x]===0).length*10+rng.next();
            if(score>best){best=score;chosen=[wx,wy];}
          }
          if(chosen){grid[chosen[1]][chosen[0]]=0;changed=true;}
        }
        if(!changed) break;
      }
    }
    bridgeDeadEnds();

    // Widen corridors for early levels while keeping the maze grid-like.
    if (d.corridor * tuning.corridorMultiplier > 1) {
      for (let y=1;y<rows-1;y++) for (let x=1;x<cols-1;x++) {
        if (grid[y][x]!==0 || rng.next()>=0.11*d.corridor*tuning.corridorMultiplier) continue;
        const [cx,cy]=rng.next()<.5?[Math.min(cols-2,x+1),y]:[x,Math.min(rows-2,y+1)];
        if(grid[cy][cx]!==1) continue;
        const support=neighbors4(cx,cy).filter(([nx,ny])=>grid[ny]?.[nx]===0).length;
        // Only widen through a wall that already joins two floor tiles. Opening
        // a wall with one support cell would create a fresh terminal dead-end.
        if(support>=2) grid[cy][cx]=0;
      }
    }

    // Final topology repair after widening: the exact grid delivered to the
    // game never leaves a terminal pocket at the end of a corridor.
    bridgeDeadEnds();

    // Guaranteed alternate escape network: punch additional loop connections
    // before objectives are placed so the thief is not dependent on one choke point.
    for(let pass=0;pass<tuning.alternateRoutes;pass++){
      const candidates=[];
      for(let y=1;y<rows-1;y++) for(let x=1;x<cols-1;x++){
        if(grid[y][x]!==1) continue;
        let n=0;
        for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) if(grid[y+dy]?.[x+dx]===0) n++;
        if(n>=2)candidates.push([x,y]);
      }
      if(!candidates.length)break;
      const pick=candidates[rng.int(0,candidates.length-1)];
      grid[pick[1]][pick[0]]=0;
    }
    bridgeDeadEnds();

    // Final invariant: no floor cell may be a terminal corridor. This runs
    // after every route-opening operation, so later edits cannot reintroduce
    // a closed pocket into the delivered map.
    bridgeDeadEnds();

    // Remove every isolated single-cell wall/brick island. These are the
    // floating square blocks that visually read as stray tiles in otherwise
    // open floor. Multi-cell wall structures remain intact.
    function removeIsolatedWallCells(){
      const seen=new Set();
      for(let y=1;y<rows-1;y++) for(let x=1;x<cols-1;x++){
        if(grid[y][x]!==1) continue;
        const key=x+','+y; if(seen.has(key)) continue;
        const q=[[x,y]], comp=[]; seen.add(key);
        for(let qi=0;qi<q.length;qi++){
          const [cx,cy]=q[qi]; comp.push([cx,cy]);
          for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
            const nx=cx+dx, ny=cy+dy, nk=nx+','+ny;
            if(nx<=0||ny<=0||nx>=cols-1||ny>=rows-1||seen.has(nk)||grid[ny][nx]!==1) continue;
            seen.add(nk); q.push([nx,ny]);
          }
        }
        if(comp.length===1){
          const [cx,cy]=comp[0]; grid[cy][cx]=0;
        }
      }
    }
    removeIsolatedWallCells();
    bridgeDeadEnds();

    const ox = Math.floor((W-cols*cell)/2), oy = 38 + Math.floor((H-68-rows*cell)/2);
    const isFloor = (x,y) => x>=0&&y>=0&&x<cols&&y<rows&&grid[y][x]===0;
    const toWorld = (x,y) => ({x:ox+x*cell+cell/2,y:oy+y*cell+cell/2});

    const floor = [];
    for (let y=1;y<rows-1;y++) for (let x=1;x<cols-1;x++) if (isFloor(x,y)) floor.push([x,y]);
    const farthestFrom = (start) => {
      const q=[start], dist=new Map([[start.join(','),0]]), prev=new Map(); let best=start;
      for(let i=0;i<q.length;i++){
        const [x,y]=q[i]; const dd=dist.get(x+','+y);
        if(dd>dist.get(best.join(','))) best=[x,y];
        [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx,dy])=>{
          const nx=x+dx,ny=y+dy,k=nx+','+ny;
          if(isFloor(nx,ny)&&!dist.has(k)){dist.set(k,dd+1);prev.set(k,[x,y]);q.push([nx,ny]);}
        });
      }
      return {cell:best,dist,prev};
    };

    const start = [1,1];
    const end1 = farthestFrom(start).cell;
    const end2 = farthestFrom(end1).cell;
    const end3 = farthestFrom(end2).cell;
    const reserved = new Set([start.join(','), end1.join(','), end2.join(','), end3.join(',')]);
    const pickFar = (from, used, minD=10) => {
      let best=null,bestD=-1; const data=farthestFrom(from);
      floor.forEach(p=>{ const k=p.join(','); if(used.has(k)||reserved.has(k)) return; const dd=data.dist.get(k)||0; if(dd>=minD&&dd>bestD){best=p;bestD=dd;} });
      return best || floor[rng.int(0,floor.length-1)];
    };

    const playerCell=start;
    const used = new Set([playerCell.join(',')]);
    // Place the three vault keys on random walkable tiles every round so their
    // locations cannot be predicted from map corners or previous runs. A small
    // gap only prevents stacking on the same tile / spawning on the player.
    const keyCells=[];
    const keyMinGap=4;
    const minPlayerGap=4;
    const pool=floor.filter(c=>{
      const k=c.join(',');
      if(used.has(k)||reserved.has(k)) return false;
      return Math.abs(c[0]-playerCell[0])+Math.abs(c[1]-playerCell[1])>=minPlayerGap;
    });
    for(let i=pool.length-1;i>0;i--){
      const j=rng.int(0,i);
      const tmp=pool[i]; pool[i]=pool[j]; pool[j]=tmp;
    }
    for(const c of pool){
      if(keyCells.length>=3) break;
      let ok=true;
      for(const kc of keyCells){
        if(Math.abs(c[0]-kc[0])+Math.abs(c[1]-kc[1])<keyMinGap){ok=false;break;}
      }
      if(!ok) continue;
      keyCells.push(c); used.add(c.join(','));
    }
    if(keyCells.length<3){
      for(const c of pool){
        if(keyCells.length>=3) break;
        const k=c.join(',');
        if(used.has(k)) continue;
        keyCells.push(c); used.add(k);
      }
    }
    while(keyCells.length<3 && floor.length){
      const c=floor[rng.int(0,floor.length-1)];
      const k=c.join(',');
      if(used.has(k)) continue;
      keyCells.push(c); used.add(k);
    }
    let cursor=keyCells[keyCells.length-1]||playerCell;
    const vaultCell=pickFar(cursor,used,Math.max(10,Math.floor(cols/2))); used.add(vaultCell.join(','));
    const escapeCell=pickFar(vaultCell,used,Math.max(10,Math.floor(cols/2)));

    const p=toWorld(...playerCell), vault=toWorld(...vaultCell), escape=toWorld(...escapeCell);
    const keys=keyCells.map(c=>({...toWorld(...c),collected:false,cell:c}));

    const guardCount = tuning.guardCount;
    const guards=[];
    const occupied=new Set([playerCell.join(','),vaultCell.join(','),escapeCell.join(','),...keyCells.map(c=>c.join(','))]);
    // Never spawn a guard in the player's opening sector. Pick spawn cells by
    // actual path distance from the player so the first patrol begins elsewhere.
    const spawnData=bfsDistancesFrom(grid, playerCell);
    const spawnCandidates=floor.filter(c=>!occupied.has(c.join(',')) && (spawnData.get(c.join(','))||0)>=Math.max(18, Math.floor((cols+rows)*0.45)));
    const shuffled=spawnCandidates.length?spawnCandidates:[...floor].filter(c=>!occupied.has(c.join(',')));
    shuffled.sort(()=>rng.next()-.5);
    let gi=0;
    while(gi<guardCount && shuffled.length){
      let bestIdx=-1,bestScore=-Infinity;
      for(let i=0;i<Math.min(shuffled.length,80);i++){
        const c=shuffled[i], d0=spawnData.get(c.join(','))||0;
        const separation=Math.min(...guards.map(g=>Math.abs(c[0]-g.cell[0])+Math.abs(c[1]-g.cell[1])));
        const score=d0*3 + (guards.length?separation*2:0) + rng.next()*12;
        if(score>bestScore){bestScore=score;bestIdx=i;}
      }
      const c=shuffled.splice(Math.max(0,bestIdx),1)[0];
      guards.push(makeGuard(toWorld(...c), c, rng, gi, seed)); occupied.add(c.join(',')); gi++;
    }

    // Give every guard an independent patrol territory. They may all chase the
    // same player, but their normal patrol targets come from different regions,
    // so multiple guards do not behave like one synchronized unit.
    guards.forEach((g, index) => {
      const local = guards.length <= 1 ? floor.slice() : floor.filter(c => {
        let owner = 0, ownerD = Infinity;
        for (let j=0;j<guards.length;j++) {
          const d=Math.abs(c[0]-guards[j].cell[0])+Math.abs(c[1]-guards[j].cell[1]);
          if(d<ownerD){ownerD=d;owner=j;}
        }
        return owner===index;
      });
      g.patrolCells = (local.length>=8 ? local : floor.slice()).map(c=>c.slice());
      g.patrolPhase = g.patrolRng.next()*Math.PI*2;
    });

    // Decorative floor hazards/standalone white blocks were removed from all stages.
    const hazards=[];
    const cameras=[];
    const baseCameraCount=Math.min(5 + level.level,Math.floor(floor.length/55));
    // Bronze/Silver/Gold each lose exactly one of their generated cameras.
    // Diamond is deliberately exempt: its 7% multiplier is its challenge tuning.
    const stageCameraReduction=level.stage<=3 ? 1 : 0;
    const cameraTarget=Math.max(0,Math.round(baseCameraCount*tuning.cameraMultiplier)-stageCameraReduction);
    const cameraCandidates=floor
      .filter(c=>Math.abs(c[0]-playerCell[0])+Math.abs(c[1]-playerCell[1])>=7)
      .filter(c=>!occupied.has(c.join(',')))
      .sort(()=>rng.next()-.5);
    for(const c of cameraCandidates.slice(0,cameraTarget)){
      const q=toWorld(...c);
      cameras.push({x:q.x,y:q.y,angle:rng.next()*Math.PI*2,sweep:rng.next()<.5?1:-1,phase:rng.next()*Math.PI*2,trigger:0,scanTimer:0});
    }

    const perfectTime = computePerfectTime(grid, playerCell, keyCells, vaultCell, escapeCell, cell) * .075 + 10;
    const bonus = [110, 100, 92, 85, 80, 75, 70, 68, 65, 60][level.level-1] || 60;

    // Keep wall-rectangle cache empty until baseWallRectForCell computes the
    // actual visible brick footprint. Caching the full grid cell here makes the
    // gray inset around a brick collide as if it were solid wall.
    const wallRectCache=Array.from({length:rows},()=>Array(cols).fill(null));
    const baseTimer=Math.max(20,(perfectTime+bonus)-10+18+15);
    const stageSpeedMultiplier = tuning.guardSpeedMult ?? Math.pow(1.02, level.stage-1);
    return {seed,rng,cell,cols,rows,ox,oy,grid,floorCells:floor.map(c=>c.slice()),keyCells:keyCells.map(c=>c.slice()),keys,vault,escape,guards,hazards,cameras,wallRectCache,backgroundCanvas:null,theme:tuning.theme,palette:STAGE_PALETTES[tuning.theme],guardSpeed:(88 + (level.level-1)*2)*stageSpeedMultiplier,wallsDiscovered:[],wallMemory:0,standstill:0,lightRadius:0,perfectTime,timer:Math.max(20,(baseTimer*tuning.timeMultiplier)-10)+10,radarPulses:[],crumbs:[],vaultOpen:false,vaultOpened:false,escapeArmed:false,lockdown:false,spawned:true,explosionFlash:0,lastPlayerMoving:false,alarmUntil:0,alarmTarget:null,objectiveFlash:0,musicBeat:0,timerRunning:false};
  }

  function bfsDistancesFrom(grid, start){
    const h=grid.length,w=grid[0].length,q=[start],d=new Map([[start.join(','),0]]);
    for(let i=0;i<q.length;i++){
      const [x,y]=q[i],cur=d.get(x+','+y);
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const nx=x+dx,ny=y+dy,k=nx+','+ny;
        if(nx>=0&&ny>=0&&nx<w&&ny<h&&grid[ny][nx]===0&&!d.has(k)){d.set(k,cur+1);q.push([nx,ny]);}
      }
    }
    return d;
  }

  function makeGuard(pos, cell, rng, index=0, seed=0){
    const patrolRng = new RNG((seed ^ (0x9E3779B9 + index * 0x85EBCA6B)) >>> 0);
    const patrolSpeed = Number.isFinite(world?.guardSpeed) ? world.guardSpeed : 88 + (level.level-1)*3 + (level.stage-1)*2;
    return {x:pos.x,y:pos.y,radius:8,cell:cell.slice(),vx:0,vy:0,lastKnown:{x:pos.x,y:pos.y},target:{x:pos.x,y:pos.y},state:'PATROL',patrol:null,patrolCooldown:0.8+patrolRng.next()*1.8,patrolWait:0.15+patrolRng.next()*0.8,patrolHistory:[],stepTimer:patrolRng.next()*.5,phase:patrolRng.next()*Math.PI*2,pulse:0,patrolRng,patrolCells:[],patrolSpeed,faceDir:{x:1,y:0},pathTimer:0,path:[],pathIndex:1,pathTarget:null,losTimer:0,alertTimer:0,chaseUntil:0,blockedFrames:0,stuckTime:0,lastMoveX:pos.x,lastMoveY:pos.y,stuckCooldown:0,detourCell:null};
  }

  function computePerfectTime(grid, start, keys, vault, escape, cell){
    const points=[start,...keys,vault,escape]; let total=0;
    for(let i=0;i<points.length-1;i++) total += bfsDistance(grid, points[i], points[i+1]);
    return Math.max(30,total || 80);
  }
  function bfsDistance(grid,a,b){
    const h=grid.length,w=grid[0].length,q=[a],d=new Map([[a.join(','),0]]);
    for(let i=0;i<q.length;i++){const [x,y]=q[i]; if(x===b[0]&&y===b[1]) return d.get(x+','+y); for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=x+dx,ny=y+dy,k=nx+','+ny; if(nx>=0&&ny>=0&&nx<w&&ny<h&&grid[ny][nx]===0&&!d.has(k)){d.set(k,d.get(x+','+y)+1);q.push([nx,ny]);}}} return 999;
  }

  let currentViewingStage = 1;


  function openLevelSelect(){
    try{ ensureAudio(); }catch(_){}
    try{ stopLocalMusic(); }catch(_){}
    try{ if(musicEnabled) fadeMainTitleIn(false); }catch(_){}
    currentViewingStage = Math.max(1, Math.min(5, level.stage || 1));
    renderLevelSelect();
    setState('LEVELS');
  }

  function setViewingStage(stageIndex){
    const next = Math.max(1, Math.min(5, Number(stageIndex) || 1));
    if(next === currentViewingStage) return;
    currentViewingStage = next;
    renderLevelSelect();
  }

  function changeViewingStage(delta){
    setViewingStage(currentViewingStage + delta);
  }

  let pendingRoundStart = null;

  function selectLevel(stage, round, startImmediately=true){
    stage = Math.max(1, Math.min(STAGE_META.length, Number(stage)||1));
    round = Math.max(1, Math.min(7, Number(round)||1));
    if(!isRoundUnlocked(stage, round)){
      showMessage('هذا الدور مقفول — اجتز الدور السابق أولًا');
      return;
    }
    level.stage = stage;
    level.level = round;
    level.turn = ((level.stage-1)*7) + level.level;
    currentViewingStage = stage;
    renderLevelSelect();
    if(startImmediately) startRaid();
  }

  function confirmPendingRoundStart(){
    if(!pendingRoundStart) return;
    document.getElementById('controlSetupPanel')?.classList.add('hidden');
    const target = pendingRoundStart; pendingRoundStart = null;
    level.stage = target.stage; level.level = target.round; level.turn = ((level.stage-1)*7) + level.level;
    currentViewingStage = target.stage;
    startRaid();
  }

  function renderLevelSelect(){
    const stageScreen = document.getElementById('levelSelectScreen');
    const boardImg = document.getElementById('stageBoardImg');
    const prevBtn = document.getElementById('lsPrevBtn');
    const nextBtn = document.getElementById('lsNextBtn');
    const titleEl = document.getElementById('stageTitleText');
    const subtitleEl = document.getElementById('stageSubtitleText');
    const emblemEl = document.getElementById('stageEmblemIcon');
    const badgeEl = document.getElementById('stageOpBadgeText');
    if(!stageScreen) return;

    currentViewingStage = Math.max(1, Math.min(5, currentViewingStage || 1));
    const meta = STAGE_META[currentViewingStage - 1];

    stageScreen.dataset.stageTone = meta.tone;
    stageScreen.dataset.stageIndex = String(currentViewingStage);

    if(boardImg){
      boardImg.src = `assets/stage-bg-clean-${currentViewingStage}.webp`;
      boardImg.alt = `${meta.name} - ${meta.subtitle}`;
    }

    if(titleEl) titleEl.textContent = meta.name;
    if(subtitleEl) subtitleEl.textContent = meta.subtitle;
    if(emblemEl) emblemEl.textContent = meta.emblem;
    if(badgeEl) badgeEl.textContent = `العملية ٠${currentViewingStage}`;

    // Update each round card's unlock status visually
    const cards = document.querySelectorAll('#stageCardsTrack .stage-round-card');
    cards.forEach(card => {
      const r = Number(card.dataset.round) || 0;
      if(r < 1 || r > 7) return;
      const unlocked = isRoundUnlocked(currentViewingStage, r);
      card.classList.toggle('locked', !unlocked);
      const statusSpan = card.querySelector('.card-ribbon-status span');
      if(statusSpan){
        statusSpan.textContent = unlocked ? 'مفتوح' : '🔒 مقفول';
      }
      const labelSpan = card.querySelector('.card-round-label');
      if(labelSpan){
        labelSpan.textContent = `الدور ${r}`;
      }
    });

    // Highlight active stage dot smoothly
    const dots = document.querySelectorAll('.hotspot-dot, .stage-dot-btn');
    dots.forEach(dot => {
      dot.classList.toggle('active', Number(dot.dataset.stage) === currentViewingStage);
    });

    renderLevelSelectStars();
    if(prevBtn) prevBtn.classList.toggle('disabled', currentViewingStage <= 1);
    if(nextBtn) nextBtn.classList.toggle('disabled', currentViewingStage >= 5);
  }

  // A world built ahead of time (while the last round's end-beat plays) so the next round starts instantly.
  let prebuiltRound=null;
  function veil(on){
    const v=document.getElementById('transitionVeil'); if(!v) return;
    v.classList.remove(on?'off':'on'); v.classList.add(on?'on':'off');
  }
  function startRaid(){
    resultTransitioning=false;
    isGameOver=false;
    isMapFullyLoaded=false;
    // Establish the logical world aspect BEFORE generating the maze (true widescreen round).
    document.getElementById('levelSelectScreen')?.classList.add('ls-launching');
    prepareLogicalGameplayWidth();
    let pre=null;
    if(prebuiltRound && prebuiltRound.stage===level.stage && prebuiltRound.level===level.level && prebuiltRound.W===W && prebuiltRound.H===H) pre=prebuiltRound.world;
    prebuiltRound=null;
    const go=()=>{
      // Finish creating a usable world before showing PLAYING. If setup fails the player stays where he is.
      try {
        buildLevel(pre);
      } catch (err) {
        console.error('Silent Raid level setup error', err);
        isMapFullyLoaded=false;
        veil(false);
        document.getElementById('levelSelectScreen')?.classList.remove('ls-launching');
        showMessage('تعذر تجهيز الدور. أعد المحاولة.');
        return;
      }
      // The level-select JPEG is not needed once the round runs; release it to lower peak GPU memory.
      const stageBoardImg=document.getElementById('stageBoardImg');
      if(stageBoardImg && typeof stageBoardImg.removeAttribute==='function') stageBoardImg.removeAttribute('src');
      setState('PLAYING');
      try { setMainTitleGameplayVolume(); } catch (_) {}
      veil(false);
    };
    if(pre){ go(); return; }              // nothing heavy left to do: straight cross-fade into the round
    // Building a maze blocks the main thread for a moment (longer on weak phones). A compositor-driven fade to
    // black starts first and keeps animating smoothly through that moment, then fades out into the round.
    veil(true);
    requestAnimationFrame(()=>requestAnimationFrame(go));
  }
  // Build the round that will most likely be played next while the end-of-round beat is on screen.
  function prebuildRound(stage,lvl){
    const saved={world,stage:level.stage,lvl:level.level,turn:level.turn};
    try{
      level.stage=stage; level.level=lvl; level.turn=((stage-1)*7)+lvl;
      const w=composeRoundWorld();
      prebuiltRound={stage,level:lvl,W,H,world:w};
    }catch(err){ prebuiltRound=null; }
    finally{ world=saved.world; level.stage=saved.stage; level.level=saved.lvl; level.turn=saved.turn; }
  }
  function schedulePrebuild(kind){
    let st=level.stage, lv=level.level;
    if(kind==='success'){
      const g=((st-1)*7)+lv; if(g>=35) return;
      const ng=g+1; st=Math.floor((ng-1)/7)+1; lv=((ng-1)%7)+1;
    }
    // Built only once the result screen is settled and idle (never during a transition).
    setTimeout(()=>{ if(isGameOver && (gameState==='SUCCESS'||gameState==='FAILURE')) prebuildRound(st,lv); },1400);
  }

  function composeRoundWorld(){
    const nextWorld=buildMaze(hashSeed(level.stage,level.level,level.turn));
    const pCell=nextWorld.grid.length ? [1,1] : [0,0];
    world=nextWorld;
    world.spot=createSpotState(world);
    // The full sprite participates in collision: pick the nearest valid floor cell for the spawn.
    let spawnPos=null;
    const candidates=[...nextWorld.floorCells].sort((a,b)=>(Math.abs(a[0]-pCell[0])+Math.abs(a[1]-pCell[1]))-(Math.abs(b[0]-pCell[0])+Math.abs(b[1]-pCell[1])));
    for(const candidate of candidates){
      const candidatePos=worldToCanvas(nextWorld,candidate[0],candidate[1]);
      const fitted=canThiefStandAt(candidatePos.x,candidatePos.y)?candidatePos:fitThiefStand(candidatePos.x,candidatePos.y);
      if(canThiefStandAt(fitted.x,fitted.y)){spawnPos=fitted;break;}
    }
    if(!spawnPos){
      const fallback=worldToCanvas(nextWorld,pCell[0],pCell[1]);
      spawnPos=fitThiefStand(fallback.x,fallback.y);
    }
    nextWorld.player={x:spawnPos.x,y:spawnPos.y,vx:0,vy:0,r:15,lastDir:{x:1,y:0},wobble:0,opacity:1,keys:0};
    nextWorld.backgroundCanvas=null;
    nextWorld.timerStart=Math.max(1,Number(nextWorld.timer)||1);
    return nextWorld;
  }

  function buildLevel(pre){
    isMapFullyLoaded=false; isGameOver=false; world=null;
    if(typeof hudCache!=='undefined') Object.assign(hudCache,{levelText:null,seconds:null,keys:null,chase:null});
    updateHUD();
    const nextWorld=pre||composeRoundWorld();
    world=nextWorld;
    const appEl=document.getElementById('app');
    if(appEl) appEl.dataset.stageTheme=world.theme;
    resizeGameSurface();
    world.backgroundCanvas=null;
    resetRewardState();
    world.timerStart=Math.max(1,Number(world.timer)||1);
    initSpotHud();
    screens.PLAYING?.classList.remove('rx-fail','rx-success');
    track('level_start',{level_name:levelName(),stage:level.stage,level:level.level});
    world.timerRunning=true;
    isMapFullyLoaded = Array.isArray(world.grid)&&world.grid.length>0&&world.player&&Number.isFinite(world.player.x)&&Number.isFinite(world.player.y)&&world.keys.length===3;
    updateHUD();
  }
  function worldToCanvas(w,gx,gy){ return {x:w.ox+gx*w.cell+w.cell/2,y:w.oy+gy*w.cell+w.cell/2}; }

  const hudCache={levelText:null,seconds:null,keys:null,chase:null};
  const hudNodes={};
  function updateHUD(){
    const stageNames = ['المرحلة البرونزية', 'المرحلة الفضية', 'المرحلة الذهبية', 'المرحلة الألماسية', 'المرحلة الأسطورية'];
    const stageName = stageNames[level.stage - 1] || `المرحلة ${level.stage}`;
    const levelHud = hudNodes.level || (hudNodes.level=document.getElementById('levelHud'));
    const levelText=`${stageName} • دور ${level.level}`;
    if(levelHud && hudCache.levelText!==levelText){levelHud.textContent=levelText;hudCache.levelText=levelText;}
    const sec=Math.max(0,Math.floor((world?.timer||0)+0.0001));
    const mm=String(Math.floor(sec/60)).padStart(2,'0'), ss=String(sec%60).padStart(2,'0');
    const timerHud=hudNodes.timer || (hudNodes.timer=document.getElementById('timerHud'));
    if(timerHud && hudCache.seconds!==sec){
      timerHud.textContent=`⏱ ${mm}:${ss}`;
      // Urgency colour classes
      timerHud.classList.toggle('hud-timer--ok',   sec > 30);
      timerHud.classList.toggle('hud-timer--warn', sec <= 30 && sec > 10);
      timerHud.classList.toggle('hud-timer--crit', sec <= 10);
      hudCache.seconds=sec;
    }
    const keysHud=hudNodes.keys || (hudNodes.keys=document.getElementById('keysHud'));
    const collected = world?.player?.keys || 0;
    if(keysHud && hudCache.keys!==collected){
      keysHud.classList.add('keys-hud');
      keysHud.setAttribute('aria-label', `المفاتيح ${collected} من 3`);
      const keySvg = `<svg class="key-svg" viewBox="0 0 32 32" aria-hidden="true"><circle cx="11" cy="15" r="7.2" fill="currentColor"/><circle cx="11" cy="15" r="3.1" fill="#1a140c"/><rect x="16.6" y="13.1" width="12.4" height="3.8" rx="1.4" fill="currentColor"/><rect x="23.4" y="16.8" width="2.7" height="5.4" rx="0.8" fill="currentColor"/><rect x="27.2" y="16.8" width="2.6" height="7.2" rx="0.8" fill="currentColor"/></svg>`;
      let slots = '';
      for(let k=1;k<=3;k++){
        slots += `<span class="key-slot${k<=collected?' filled':''}">${keySvg}</span>`;
      }
      keysHud.innerHTML = `<span class="keys-hud-title">المفاتيح</span><span class="keys-hud-slots">${slots}</span><span class="keys-hud-count">${collected}/3</span>`;
      hudCache.keys=collected;
    }
    const chaseHud=hudNodes.chase || (hudNodes.chase=document.getElementById('chaseHud'));
    let chaseRemaining=0;
    if(world?.guards) for(let gi=0;gi<world.guards.length;gi++){const g=world.guards[gi]; if(g.state==='CHASE'){const r=Math.ceil(Math.max(0,g.alertTimer||0)); if(r>chaseRemaining) chaseRemaining=r;}}
    const chasing=chaseRemaining>0;
    const chaseText=chasing?`⚠ المطاردة: ${chaseRemaining} ث`:'';
    if(chaseHud && hudCache.chase!==chaseText){
      chaseHud.hidden=!chasing;
      if(chasing) chaseHud.textContent=chaseText;
      hudCache.chase=chaseText;
    }
  }

  function baseWallRectForCell(gx,gy){
    if(!world || gy<0 || gx<0 || gy>=world.rows || gx>=world.cols || world.grid[gy][gx]!==1) return null;
    const cached=world.wallRectCache?.[gy]?.[gx];
    if(cached) return cached;
    const c=world.cell, x=world.ox+gx*c, y=world.oy+gy*c;
    // A wall cell does NOT reserve its entire square. The solid footprint is
    // the same shape the player can actually see. Insets are applied only on
    // sides that face a floor cell; touching wall cells remain perfectly joined.
    // A 40% reduction makes each brick 60% of its cell. The corridor clearance is
    // then increased by 10% relative to the previous 50%-of-cell passage width.
    const basePad = c * ((1 - BRICK_SIZE_RATIO) / 2);
    const extraPad = c * (CORRIDOR_EXTRA_CLEARANCE_RATIO / 2);
    const leftOpen = world.grid[gy]?.[gx-1] !== 1;
    const rightOpen = world.grid[gy]?.[gx+1] !== 1;
    const topOpen = world.grid[gy-1]?.[gx] !== 1;
    const bottomOpen = world.grid[gy+1]?.[gx] !== 1;
    // Connected wall cells share the same solid edge. Only outside-facing
    // edges are inset, so adjacent bricks touch with no visible gap.
    const left   = leftOpen ? basePad + extraPad : 0;
    const right  = rightOpen ? basePad + extraPad : 0;
    const top    = topOpen ? basePad + extraPad : 0;
    const bottom = bottomOpen ? basePad + extraPad : 0;
    const rawW=Math.max(1,c-left-right), rawH=Math.max(1,c-top-bottom);
    // Use the cell size, not the locally inset height, for the vertical lift.
    // This keeps connected corner bricks on one continuous level.
    const verticalExtra=(c*(WALL_VERTICAL_SCALE-1))/2;
    const rect={x:x+left,y:y+top-verticalExtra,w:rawW,h:rawH+verticalExtra*2,bevel:1};
    if(world.wallRectCache) world.wallRectCache[gy][gx]=rect;
    return rect;
  }

  function circleHitsRect(cx,cy,r,rect){
    const qx=Math.max(rect.x,Math.min(cx,rect.x+rect.w));
    const qy=Math.max(rect.y,Math.min(cy,rect.y+rect.h));
    const dx=cx-qx,dy=cy-qy;
    return dx*dx+dy*dy < r*r;
  }

  function wallPolygon(rect){
    const b=Math.max(0,Math.min(rect.bevel||0,rect.w*.25,rect.h*.25));
    return [
      {x:rect.x+b,y:rect.y},{x:rect.x+rect.w-b,y:rect.y},
      {x:rect.x+rect.w,y:rect.y+b},{x:rect.x+rect.w,y:rect.y+rect.h-b},
      {x:rect.x+rect.w-b,y:rect.y+rect.h},{x:rect.x+b,y:rect.y+rect.h},
      {x:rect.x,y:rect.y+rect.h-b},{x:rect.x,y:rect.y+b}
    ];
  }





  function canStandAt(x,y,r){
    if(!world) return false;
    r += THIEF_COLLISION_SKIN;
    // Generic circular collision used by guards and other round entities.
    const pad=r+world.cell;
    const minX=Math.max(0,Math.floor((x-pad-world.ox)/world.cell));
    const maxX=Math.min(world.cols-1,Math.floor((x+pad-world.ox)/world.cell));
    const minY=Math.max(0,Math.floor((y-pad-world.oy)/world.cell));
    const maxY=Math.min(world.rows-1,Math.floor((y+pad-world.oy)/world.cell));
    for(let gy=minY;gy<=maxY;gy++) for(let gx=minX;gx<=maxX;gx++){
      const rect=baseWallRectForCell(gx,gy);
      if(rect && circleHitsRect(x,y,r,rect)) return false;
    }
    return true;
  }

  // Uniform AABB of the drawn sprite, including the beanie and the feet.
  // Origin stays at the movement anchor; the box is shifted by the same render
  // offset used when painting so walls meet the visible outline only.
  function thiefSpriteDrawSize(){
    // Use the larger loot frame so both empty and carrying poses stay inside.
    return {w:THIEF_SPRITE_DRAW_W_LOOT,h:THIEF_SPRITE_DRAW_H_LOOT};
  }
  let thiefExtentsMemo=null;
  function thiefCollisionExtents(){
    if(thiefExtentsMemo) return thiefExtentsMemo;
    const {w,h}=thiefSpriteDrawSize();
    const dy=-h*(THIEF_SPRITE_ANCHOR_Y/THIEF_SPRITE_CANVAS);
    const top=THIEF_RENDER_Y_OFFSET-THIEF_WALK_BOB_AMPLITUDE+dy;
    const bottom=THIEF_RENDER_Y_OFFSET+dy+h*(THIEF_SPRITE_FEET_Y/THIEF_SPRITE_CANVAS);
    const halfW=THIEF_BODY_HALF_W-THIEF_EDGE_PENETRATION;
    return (thiefExtentsMemo={halfW,top,bottom});
  }
  function thiefBodyRectAt(x,y){
    const e=thiefCollisionExtents();
    const s=THIEF_CHARACTER_SCALE;
    return {
      left:x-e.halfW*s,
      right:x+e.halfW*s,
      top:y+e.top*s,
      bottom:y+e.bottom*s
    };
  }
  function fitThiefStand(x,y){
    if(canThiefStandAt(x,y)) return {x,y};
    if(!world) return {x,y};
    const limit=Math.max((world.cell||32)*2,48);
    for(let d=1;d<=limit;d++){
      const samples=[[x,y+d],[x,y-d],[x+d,y],[x-d,y],[x+d,y+d],[x-d,y+d],[x+d,y-d],[x-d,y-d]];
      for(const [tx,ty] of samples){
        if(canThiefStandAt(tx,ty)) return {x:tx,y:ty};
      }
    }
    return {x,y};
  }

  // Axis-aligned body vs the bevelled wall octagon. A rectangle and an octagon only have 6 distinct separating
  // axes (x, y and the two diagonals of the bevels), so the test is done directly without building polygons.
  // (The generic SAT used to allocate ~100 objects per call, several times per frame -> constant GC pauses.)
  function rectsOverlap(a,b){
    const bx=b.x,by=b.y,bw=b.w,bh=b.h;
    if(a.right<=bx || bx+bw<=a.left || a.bottom<=by || by+bh<=a.top) return false;
    const bev=Math.max(0,Math.min(b.bevel||0,bw*.25,bh*.25));
    if(bev>0){
      if(a.right+a.bottom<=bx+by+bev || bx+bw+by+bh-bev<=a.left+a.top) return false;      // diagonal (1,1)
      if(a.right-a.top<=bx-by-bh+bev || bx+bw-by-bev<=a.left-a.bottom) return false;      // diagonal (1,-1)
    }
    return true;
  }

  function entityTouchesRect(entity, rect) {
    // Objective pickup follows the rendered silhouette, while wall collision
    // keeps its tighter gameplay footprint so movement remains unchanged.
    const body = {
      left: entity.x - 22,
      right: entity.x + 22,
      top: entity.y - 28,
      bottom: entity.y + 4
    };
    return body.left < rect.right && body.right > rect.left && body.top < rect.bottom && body.bottom > rect.top;
  }

  function canThiefStandAt(x,y){
    if(!world) return false;
    const body=thiefBodyRectAt(x,y);
    const pad=world.cell;
    const minX=Math.max(0,Math.floor((body.left-pad-world.ox)/world.cell));
    const maxX=Math.min(world.cols-1,Math.floor((body.right+pad-world.ox)/world.cell));
    const minY=Math.max(0,Math.floor((body.top-pad-world.oy)/world.cell));
    const maxY=Math.min(world.rows-1,Math.floor((body.bottom+pad-world.oy)/world.cell));
    for(let gy=minY;gy<=maxY;gy++) for(let gx=minX;gx<=maxX;gx++){
      const rect=baseWallRectForCell(gx,gy);
      if(rect && rectsOverlap(body,rect)) return false;
    }
    return true;
  }

  function canThiefMoveTo(x,y,dx,dy){
    // All four directions use the same body-vs-brick test. There is no
    // direction-specific head exception, so every wall edge uses the same bounds.
    return canThiefStandAt(x,y);
  }

  // Guard movement MUST use the same collision contract as the player.
  // The previous build called this function without defining it, so the
  // exception was swallowed by the guarded AI subsystem and every guard
  // stopped before reaching its movement/capture logic.
  function canGuardStandAt(x,y,r){
    return canStandAt(x,y,r);
  }
  function canvasToGrid(x,y){return {x:Math.floor((x-world.ox)/world.cell),y:Math.floor((y-world.oy)/world.cell)}}
  function isFloor(gx,gy){return gx>=0&&gy>=0&&gx<world.cols&&gy<world.rows&&world.grid[gy][gx]===0}

  // Analog steering is smoothed as a continuous signal.  A tiny dead-zone
  // removes finger jitter, the response curve gives finer control near center,
  // and a light low-pass keeps the direction from snapping between samples.
  let smoothInputX=0, smoothInputY=0;
  function getMoveInput(dt=1/60){
    let x=input.x,y=input.y;
    if(!input.joystickActive){
      x=0;y=0;
      if(input.keys.has('a')||input.keys.has('arrowleft')) x-=1;
      if(input.keys.has('d')||input.keys.has('arrowright')) x+=1;
      if(input.keys.has('w')||input.keys.has('arrowup')) y-=1;
      if(input.keys.has('s')||input.keys.has('arrowdown')) y+=1;
    }
    let m=Math.hypot(x,y);
    if(m>1){x/=m;y/=m;m=1;}
    const DEADZONE=input.joystickActive?0.07:0;
    if(m<DEADZONE){x=0;y=0;m=0;}
    else if(input.joystickActive){
      const t=Math.min(1,Math.max(0,(m-DEADZONE)/(1-DEADZONE)));
      // Smoothstep response: precise around center, full authority at edge.
      const curved=t*t*(3-2*t);
      const inv=m>0?1/m:0;
      x*=curved*inv;y*=curved*inv;m=curved;
    }
    const response=input.joystickActive?30:34;
    const a=1-Math.exp(-response*Math.max(0.001,Math.min(0.05,dt)));
    smoothInputX += (x-smoothInputX)*a;
    smoothInputY += (y-smoothInputY)*a;
    const sm=Math.hypot(smoothInputX,smoothInputY);
    if(sm>1){smoothInputX/=sm;smoothInputY/=sm;}
    const smag=Math.min(1,Math.hypot(smoothInputX,smoothInputY));
    return smag>0.001?{x:smoothInputX/smag,y:smoothInputY/smag,mag:smag}:{x:0,y:0,mag:0};
  }

  function moveCircleSwept(entity,dx,dy,r,standFn=canStandAt){
    let x=entity.x,y=entity.y,blockedX=false,blockedY=false;
    const steps=Math.max(1,Math.ceil(Math.hypot(dx,dy)/1.5)),sx=dx/steps,sy=dy/steps;
    for(let i=0;i<steps;i++){
      if(standFn(x+sx,y,r))x+=sx;else blockedX=true;
      if(standFn(x,y+sy,r))y+=sy;else blockedY=true;
    }
    if(!standFn(x,y,r)){
      const fallback=[[entity.x,y],[x,entity.y],[entity.x,entity.y]];
      for(const q of fallback)if(standFn(q[0],q[1],r)){x=q[0];y=q[1];break;}
    }
    return {x,y,blockedX,blockedY};
  }

  function update(dt,now){
    if(gameState!=='PLAYING' || !isMapFullyLoaded || !world?.player || isGameOver) return;
    const p=world.player;

    // Fixed-step simulation keeps timer, pickup and AI deterministic across refresh rates.
    try{
      const mv=getMoveInput(dt);
      const running=mv.mag>.08;
      const maxSpeed=(running?150:110)*SPEED_BOOST;
      const response=running?16:22;
      const follow=1-Math.exp(-response*Math.max(0.001,Math.min(0.05,dt)));
      const tx=mv.x*maxSpeed*mv.mag, ty=mv.y*maxSpeed*mv.mag;
      p.vx += (tx-p.vx)*follow;
      p.vy += (ty-p.vy)*follow;

      // Classic swept collision: smooth sliding along walls and around corners
      const moved=moveCircleSwept(p,p.vx*dt,p.vy*dt,THIEF_MOVE_COLLISION_RADIUS,(tx,ty)=>canThiefMoveTo(tx,ty,p.vx,p.vy)&&canStandAt(tx,ty,THIEF_MOVE_COLLISION_RADIUS));
      p.x=moved.x;p.y=moved.y;
      if(moved.blockedX)p.vx=0;
      if(moved.blockedY)p.vy=0;

      const actualSpeed=Math.hypot(p.vx,p.vy);
      if(actualSpeed>2){p.lastDir.x=p.vx/actualSpeed;p.lastDir.y=p.vy/actualSpeed;}
      const targetWobble=actualSpeed>15?1:0;
      p.wobble += ((targetWobble-p.wobble)*Math.min(1,dt*10));
      world.lastPlayerMoving=actualSpeed>15;

      // Smooth directional pose selection (LEFT, RIGHT, DOWN, UP) with hysteresis
      if(actualSpeed > 4 && p.lastDir){
        const ax = Math.abs(p.lastDir.x);
        const ay = Math.abs(p.lastDir.y);
        const current = p.currentPose || 'down';
        const yBias = (current === 'up' || current === 'down') ? 1.20 : 0.83;
        if(ay * yBias > ax){
          p.currentPose = p.lastDir.y < 0 ? 'up' : 'down';
        } else {
          p.currentPose = p.lastDir.x < 0 ? 'left' : 'right';
        }
      } else if (!p.currentPose) {
        p.currentPose = 'down';
      }
      world.objectiveFlash=Math.max(0,(world.objectiveFlash||0)-dt);

      if(actualSpeed<15){
        world.standstill+=dt;
        world.wallMemory=Math.max(0,5-world.standstill);
      }else{
        world.standstill=0; world.wallMemory=5;
      }
      // Dynamic vision radius: when moving, expands smoothly up to 190px.
      // When stopped, collapses completely to 0 (bank is pitch black, only thief is visible).
      const IDLE_LIGHT_R = 0;    // completely collapses when stopped
      const MOVE_LIGHT_R = 190 * 1.03;  // +3% wider thief vision
      const lightTarget = actualSpeed > 15 ? MOVE_LIGHT_R : IDLE_LIGHT_R;
      const lightResponse = actualSpeed > 15 ? 7.5 : 5.0;
      world.lightRadius = (world.lightRadius ?? IDLE_LIGHT_R) + (lightTarget - (world.lightRadius ?? IDLE_LIGHT_R)) * (1 - Math.exp(-lightResponse * dt));
      world.lightRadius = Math.max(0, Math.min(MOVE_LIGHT_R, world.lightRadius));

      // The clock is intentionally updated BEFORE AI/cameras so a fault in any
      // expensive subsystem can never silently stop the countdown or HUD.
      updateTimer(dt);
      updatePlayerObjectives();

      world.spotSeen={guard:false,camera:false};
      const subsystems=[
        ['camera',()=>updateSecurityCameras(dt,now,actualSpeed)],
        ['guards',()=>updateGuards(dt,now,actualSpeed)],
        ['spotting',()=>updateDetectionEvents(dt)],
        ['hazards',()=>updateHazards(dt,actualSpeed)],
        ['failure',()=>checkFailureAndSuccess()],
        ['audio',()=>updateAudio(dt)]
      ];
      for(const [name,fn] of subsystems){
        try{fn();}catch(err){
          console.error(`Silent Raid ${name} subsystem error`,err);
          if(name==='guards') world.guardRuntimeError=String(err?.message||err);
        }
        if(isGameOver) break;
      }
    }catch(err){
      // Never let a single gameplay system abort the simulation loop.
      console.error('Silent Raid player subsystem error',err);
    }
  }

  function updatePlayerObjectives(){
    const p=world.player;
    world.keys.forEach(k=>{
      if(k.collected) return;
      const keyRect={left:k.x-10,right:k.x+10,top:k.y-10,bottom:k.y+10};
      if(entityTouchesRect(p, keyRect)){
        k.collected=true;
        p.keys=Math.min(3,p.keys+1);
        world.objectiveFlash=1;
        playSfx('key');
      }
    });
    world.vaultOpen=p.keys===3;
    if(world.vaultOpen){
      const vaultRect={left:world.vault.x-18,right:world.vault.x+18,top:world.vault.y-18,bottom:world.vault.y+18};
      if(entityTouchesRect(p,vaultRect)&&!world.vaultOpened){
        world.vaultOpened=true;
        playSfx('vault');
      }
    }
    world.escapeArmed=world.vaultOpened;
  }

  // Deterministic emergency detour used by the guard when its current
  // direction is blocked. It intentionally does not depend on a secondary
  // helper, so the chase loop cannot die from a missing function.
  function pickGuardDetour(g,targetCell){
    const c=canvasToGrid(g.x,g.y);
    const candidates=[[1,0],[-1,0],[0,1],[0,-1]]
      .map(([dx,dy])=>[c.x+dx,c.y+dy])
      .filter(([x,y])=>isFloor(x,y));
    if(!candidates.length) return null;
    candidates.sort((a,b)=>{
      const da=Math.abs(a[0]-targetCell.x)+Math.abs(a[1]-targetCell.y);
      const db=Math.abs(b[0]-targetCell.x)+Math.abs(b[1]-targetCell.y);
      return da-db;
    });
    return candidates[0];
  }


  // Pick a locally reachable escape cell when the current movement edge is blocked.
  // The chooser prefers cells that are safe for the guard's full radius, closer to the
  // current target, and different from the cell that just caused a stall.
  function pickGuardEscapeCell(g,targetCell){
    const c=canvasToGrid(g.x,g.y);
    const currentKey=c.x+','+c.y;
    const candidates=[[1,0],[-1,0],[0,1],[0,-1]]
      .map(([dx,dy])=>[c.x+dx,c.y+dy])
      .filter(([x,y])=>isFloor(x,y))
      .filter(([x,y])=>{
        const pos=worldToCanvas(world,x,y);
        return canGuardStandAt(pos.x,pos.y,g.radius);
      })
      .filter(([x,y])=>x+','+y !== currentKey)
      .filter(([x,y])=>!g.detourCell || x+','+y !== g.detourCell.join(','));
    if(!candidates.length)return null;
    candidates.sort((a,b)=>{
      const da=Math.abs(a[0]-targetCell.x)+Math.abs(a[1]-targetCell.y);
      const db=Math.abs(b[0]-targetCell.x)+Math.abs(b[1]-targetCell.y);
      const aa=Math.atan2(a[1]-c.y,a[0]-c.x), ab=Math.atan2(b[1]-c.y,b[0]-c.x);
      const dir= Math.atan2(g.faceDir?.y||0,g.faceDir?.x||1);
      const turnA=Math.abs(Math.atan2(Math.sin(aa-dir),Math.cos(aa-dir)));
      const turnB=Math.abs(Math.atan2(Math.sin(ab-dir),Math.cos(ab-dir)));
      return (da*1.0+turnA*.18+g.patrolRng.next()*.001)-(db*1.0+turnB*.18+g.patrolRng.next()*.001);
    });
    return candidates[0];
  }

  function updateGuards(dt,now,playerSpeed){
    const p=world.player;
    const nowSec=now/1000;
    let anyChase=false;
    const SENSE_R=108;
    const VISION_R=146;
    const CAPTURE_R=p.r+10;
    const CHASE_SECONDS=6;
    const defaultGuardSpeed=Number.isFinite(world.guardSpeed)?world.guardSpeed:88;
    const MAX_MOVE_STEP=2.25;

    for(const g of world.guards){
      const d=dist(g,p);
      const clearSight=hasLineOfSight(g,p);
      // Walls strictly block both guard vision and sensory awareness
      const visible=d<=VISION_R && clearSight;
      const cameraAlarm=(world.alarmUntil||0)>nowSec;
      const insideSense=d<=SENSE_R && clearSight;
      const detectedNow=insideSense || visible || cameraAlarm;
      if((insideSense||visible) && (world.continueGrace||0)<=0 && world.spotSeen) world.spotSeen.guard=true;

      if(g.state!=='CHASE' && detectedNow){
        g.state='CHASE';
        g.lastKnown={x:p.x,y:p.y};
        g.target={x:p.x,y:p.y};
        g.chaseUntil=nowSec+CHASE_SECONDS;
        g.alertTimer=CHASE_SECONDS;
        g.path=[]; g.pathIndex=0; g.pathTimer=0; g.pathTarget=null;
        playAlarmSiren();
      }else if(g.state==='CHASE'){
        if(detectedNow){
          // Hard rule: the 6-second window is a grace/search window, not a timeout.
          // As long as the player remains detectable, pursuit is continuously refreshed.
          g.lastKnown={x:p.x,y:p.y};
          g.target={x:p.x,y:p.y};
          g.chaseUntil=nowSec+CHASE_SECONDS;
          g.alertTimer=CHASE_SECONDS;
          anyChase=true;
        }else if(nowSec < (g.chaseUntil||0)){
          g.target={...g.lastKnown};
          g.alertTimer=Math.max(0,g.chaseUntil-nowSec);
          anyChase=true;
        }else{
          // Lost target: leave chase only after the grace window expires while
          // the player is actually outside the sensory/LOS envelope.
          g.state='SEARCH';
          g.target={...g.lastKnown};
          g.path=[]; g.pathIndex=0; g.pathTimer=0; g.pathTarget=null;
          g.searchUntil=nowSec+3;
        }
      }else if(g.state==='SEARCH'){
        if(detectedNow){
          g.state='CHASE';
          g.lastKnown={x:p.x,y:p.y};
          g.target={x:p.x,y:p.y};
          g.chaseUntil=nowSec+CHASE_SECONDS;
          g.alertTimer=CHASE_SECONDS;
          g.path=[]; g.pathIndex=0; g.pathTimer=0; g.pathTarget=null;
          anyChase=true;
        }else if(dist(g,g.target)<10 || nowSec>(g.searchUntil||0)){
          g.state='PATROL';
          g.path=[]; g.pathIndex=0; g.patrol=null; g.pathTimer=0; g.pathTarget=null;
          g.patrolRoute=null; g.patrolRouteIndex=0;
          g.patrolCooldown=0; g.patrolWait=0;
        }
      }

      if(g.state==='PATROL'){
        g.patrolCooldown-=dt;
        if(g.patrolWait>0) g.patrolWait=Math.max(0,g.patrolWait-dt);
        const gc=canvasToGrid(g.x,g.y);
        const routeActive=Array.isArray(g.patrolRoute) && g.patrolRoute.length>1 && g.patrolRouteIndex<g.patrolRoute.length;
        if(!routeActive){
          if(g.patrolWait>0 || g.patrolCooldown>0){
            g.vx=0; g.vy=0;
          }else{
            const recent=new Set((g.patrolHistory||[]).slice(-5).map(c=>c.join(',')));
            let bestPath=[], bestScore=-Infinity;
            for(let attempt=0;attempt<40;attempt++){
              const patrolPool=(g.patrolCells?.length?g.patrolCells:world.floorCells);
              const target=patrolPool[g.patrolRng.int(0,patrolPool.length-1)];
              const tk=target.join(',');
              if((target[0]===gc.x&&target[1]===gc.y)||recent.has(tk)) continue;
              const nearOther=world.guards.some(other=>other!==g && Math.abs(target[0]-other.cell[0])+Math.abs(target[1]-other.cell[1])<4);
              if(nearOther) continue;
              const candidate=findGridPath(gc,target);
              if(candidate.length<6) continue;
              const manhattan=Math.abs(target[0]-gc.x)+Math.abs(target[1]-gc.y);
              const score=candidate.length*1.8+manhattan*.65+g.patrolRng.next()*24;
              if(score>bestScore){bestScore=score;bestPath=candidate;}
            }
            if(!bestPath.length){
              let longest=[];
              for(let attempt=0;attempt<16;attempt++){
                const patrolPool=(g.patrolCells?.length?g.patrolCells:world.floorCells);
              const target=patrolPool[g.patrolRng.int(0,patrolPool.length-1)];
                const candidate=findGridPath(gc,target);
                if(candidate.length>longest.length) longest=candidate;
              }
              bestPath=longest.length?longest:[gc];
            }
            g.patrolRoute=bestPath;
            g.patrolRouteIndex=bestPath.length>1?1:0;
            g.patrolHistory=g.patrolHistory||[];
            const finalCell=bestPath[bestPath.length-1]||gc;
            g.patrolHistory.push(finalCell.slice());
            if(g.patrolHistory.length>10) g.patrolHistory.shift();
            g.patrolCell=finalCell.slice();
            g.patrolCooldown=0;
            g.patrolWait=0;
          }
        }
        if(g.patrolRoute?.length && g.patrolRouteIndex<g.patrolRoute.length){
          const pc=g.patrolRoute[g.patrolRouteIndex];
          g.target=worldToCanvas(world,pc[0],pc[1]);
          g.path=g.patrolRoute;
          g.pathIndex=g.patrolRouteIndex;
          g.pathTarget=null;
        }else{
          g.target={x:g.x,y:g.y};
          g.path=[]; g.pathIndex=0; g.pathTarget=null;
        }
      }

      const target=g.target||{x:g.x,y:g.y};
      if(g.state==='CHASE' || g.state==='SEARCH' || g.state==='DISTRACT'){
        const tx=target.x-g.x, ty=target.y-g.y, td=Math.hypot(tx,ty);
        if(td>0.5){g.faceDir.x=tx/td;g.faceDir.y=ty/td;}
      }
      const targetCell=canvasToGrid(target.x,target.y);
      const guardCell=canvasToGrid(g.x,g.y);
      const pathState=(g.state==='CHASE'||g.state==='SEARCH'||g.state==='DISTRACT');

      // CHASE/SEARCH no longer performs a full BFS independently for every guard on a
      // timer. One flow field is computed from the current player cell and every guard
      // follows its own local downhill neighbor. The guards remain independent in their
      // patrol/state/choice logic, but the shared chase field removes repeated searches
      // that can block the JS main thread and visually freeze agents for seconds.
      if(pathState){
        const playerCellNow=canvasToGrid(p.x,p.y);
        const fieldKey=playerCellNow.x+','+playerCellNow.y;
        if(!world.guardFlowField || world.guardFlowFieldKey!==fieldKey){
          const field=new Map();
          const q=[[playerCellNow.x,playerCellNow.y]];
          field.set(fieldKey,null);
          for(let qi=0;qi<q.length;qi++){
            const [cx,cy]=q[qi];
            for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
              const nx=cx+dx,ny=cy+dy,k=nx+','+ny;
              if(!isFloor(nx,ny) || field.has(k)) continue;
              field.set(k,[cx,cy]);
              q.push([nx,ny]);
            }
          }
          world.guardFlowField=field;
          world.guardFlowFieldKey=fieldKey;
          world.guardFlowFieldStamp=nowSec;
        }
        const ck=guardCell.x+','+guardCell.y;
        const next=world.guardFlowField.get(ck);
        if(next){
          g.path=[guardCell,next];
          g.pathIndex=1;
          g.pathTarget={x:targetCell.x,y:targetCell.y};
          g.pathTimer=0.12;
        }else{
          // The player may be in a disconnected region or a transient edge case.
          // Fall back to a bounded local search; never spin on the same waypoint.
          const found=findGridPath(guardCell,targetCell);
          g.path=found.length?found:[guardCell];
          g.pathIndex=g.path.length>1?1:0;
          g.pathTarget={x:targetCell.x,y:targetCell.y};
          g.pathTimer=0.20;
          if(!found.length){
            const detour=pickGuardEscapeCell(g,targetCell)||pickGuardDetour(g,targetCell);
            if(detour){g.path=[guardCell,detour];g.pathIndex=1;}
          }
        }
      }

      while(g.path?.length && g.pathIndex<g.path.length){
        const wp=worldToCanvas(world,g.path[g.pathIndex][0],g.path[g.pathIndex][1]);
        if(Math.hypot(wp.x-g.x,wp.y-g.y)<=4){
          g.x=wp.x; g.y=wp.y; g.cell=[g.path[g.pathIndex][0],g.path[g.pathIndex][1]];
          g.pathIndex++;
          if(g.state==='PATROL')g.patrolRouteIndex=g.pathIndex;
        }else break;
      }

      let waypoint=null;
      if(g.path?.length && g.pathIndex<g.path.length){
        waypoint=worldToCanvas(world,g.path[g.pathIndex][0],g.path[g.pathIndex][1]);
      }else if(pathState && isFloor(targetCell.x,targetCell.y)){
        waypoint=worldToCanvas(world,targetCell.x,targetCell.y);
      }

      let dx=(waypoint?waypoint.x:g.x)-g.x;
      let dy=(waypoint?waypoint.y:g.y)-g.y;
      const moveSpeed=(g.patrolSpeed||defaultGuardSpeed)*SPEED_BOOST;
      const dm=Math.hypot(dx,dy);
      const moveStartX=g.x, moveStartY=g.y;

      if(dm>0.35){
        const ux=dx/dm, uy=dy/dm;
        const total=moveSpeed*dt;
        const totalX=ux*total, totalY=uy*total;
        const subSteps=Math.max(1,Math.ceil(Math.hypot(totalX,totalY)/MAX_MOVE_STEP));
        const sx=totalX/subSteps, sy=totalY/subSteps;
        let movedAny=false;
        for(let i=0;i<subSteps;i++){
          const fullX=g.x+sx, fullY=g.y+sy;
          if(canGuardStandAt(fullX,fullY,g.radius)){
            g.x=fullX; g.y=fullY; movedAny=true; continue;
          }
          const canX=canGuardStandAt(fullX,g.y,g.radius);
          const canY=canGuardStandAt(g.x,fullY,g.radius);
          if(canX){g.x=fullX;movedAny=true;}
          if(canY){g.y=fullY;movedAny=true;}
          if(!canX && !canY) break;
        }
        // Velocity reflects the intended motion, not a collision response. This keeps
        // animation/heading continuous and lets the stall detector decide when a true
        // blockage occurred instead of creating a visible zero-speed pause.
        g.vx=ux*moveSpeed; g.vy=uy*moveSpeed;
        g.faceDir.x=ux; g.faceDir.y=uy;
        g.lastMovementSucceeded=!!movedAny;
      }else{
        g.vx=0; g.vy=0;
        if(g.state==='PATROL'){
          g.patrolRouteIndex=g.patrolRoute?.length||0;
          g.patrolCooldown=Math.min(g.patrolCooldown,0);
        }
      }

      // ROOT CAUSE FIX: detect lack of actual world-space progress, not merely a
      // blocked-path flag. This catches corner-snags, stale waypoints, diagonal
      // collisions, and two-agent interference even when the grid path itself is valid.
      const moved=Math.hypot(g.x-moveStartX,g.y-moveStartY);
      const wantedDistance=Math.max(0,dm);
      if(wantedDistance>1.5 && moved<0.20){
        g.stuckTime=(g.stuckTime||0)+dt;
      }else{
        g.stuckTime=Math.max(0,(g.stuckTime||0)-dt*2.5);
      }
      g.stuckCooldown=Math.max(0,(g.stuckCooldown||0)-dt);

      if(g.stuckTime>0.06 && g.stuckCooldown<=0){
        g.stuckCooldown=0.08;
        g.blockedFrames=(g.blockedFrames||0)+1;
        const actualCell=canvasToGrid(g.x,g.y);
        const goalCell=targetCell;
        // Repath from the guard's REAL cell immediately; never keep walking against
        // a stale waypoint after collision has invalidated it.
        const retry=findGridPath(actualCell,goalCell);
        if(retry.length>1){
          g.path=retry;
          g.pathIndex=1;
          g.pathTarget={x:goalCell.x,y:goalCell.y};
          g.pathTimer=0.04;
          g.detourCell=null;
        }else{
          const detour=pickGuardEscapeCell(g,goalCell) || pickGuardDetour(g,goalCell);
          if(detour){
            g.path=[actualCell,detour];
            g.pathIndex=1;
            g.pathTarget={x:goalCell.x,y:goalCell.y};
            g.pathTimer=0.04;
            g.detourCell=detour.slice();
          }
        }
        // Do not zero velocity here: the next fixed step should immediately use the new path.
      }

      // If the guard has made effectively no progress for a sustained interval,
      // relocate only to the nearest legal floor center. This is a last-resort
      // recovery from numerical/corner deadlocks, not a teleport toward the player.
      if(g.stuckTime>0.42){
        const actual=canvasToGrid(g.x,g.y);
        let safe=pickGuardEscapeCell(g,targetCell);
        if(!safe) safe=nearestSafeFloorCell(g);
        // Prefer an actual adjacent escape cell when possible. Snapping to the same
        // cell is not recovery; it would simply restart the same deadlock.
        if(safe && (safe[0]!==actual.x || safe[1]!==actual.y)){
          const pos=worldToCanvas(world,safe[0],safe[1]);
          g.x=pos.x; g.y=pos.y; g.cell=safe.slice();
        }else{
          // Final bounded BFS recovery: find the nearest legal neighboring cell,
          // regardless of whether it moves toward the current target. This breaks
          // local corner/doorway deadlocks deterministically without teleporting
          // across the map.
          const q=[[actual.x,actual.y]],seen=new Set([actual.x+','+actual.y]);
          let recovery=null;
          for(let qi=0;qi<q.length && qi<20;qi++){
            const [cx,cy]=q[qi];
            for(const [dx2,dy2] of [[1,0],[-1,0],[0,1],[0,-1]]){
              const nx=cx+dx2,ny=cy+dy2,key=nx+','+ny;
              if(seen.has(key)||!isFloor(nx,ny))continue;
              seen.add(key);q.push([nx,ny]);
              const pos=worldToCanvas(world,nx,ny);
              if(canGuardStandAt(pos.x,pos.y,g.radius)){recovery=[nx,ny];break;}
            }
            if(recovery)break;
          }
          if(recovery){
            const pos=worldToCanvas(world,recovery[0],recovery[1]);
            g.x=pos.x; g.y=pos.y; g.cell=recovery.slice();
          }
        }
        g.path=[]; g.pathIndex=0; g.pathTimer=0; g.pathTarget=null;
        g.patrolRoute=null; g.patrolRouteIndex=0;
        g.detourCell=null;
        g.stuckTime=0;
        g.blockedFrames=0;
      }

      if(!canGuardStandAt(g.x,g.y,g.radius)){
        const safe=nearestSafeFloorCell(g);
        if(safe){const pos=worldToCanvas(world,safe[0],safe[1]);g.x=pos.x;g.y=pos.y;g.cell=safe.slice();g.vx=0;g.vy=0;g.path=[];g.pathIndex=0;g.pathTimer=0;}
      }

      const cg=canvasToGrid(g.x,g.y);
      if(isFloor(cg.x,cg.y)) g.cell=[cg.x,cg.y];
      if(g.state==='CHASE'||g.state==='SEARCH'||g.state==='DISTRACT'||d<=SENSE_R) anyChase=true;

      g.stepTimer=(g.stepTimer||0)-dt;
      if(g.stepTimer<=0){
        g.stepTimer=.42;
        g.pulse=1;
        if(g.state!=='PATROL'||d<300)playSfx('step');
      }
      g.pulse=Math.max(0,(g.pulse||0)-dt*1.15);

      if((world.continueGrace||0)<=0 && dist(g,p)<=CAPTURE_R){fail('تم القبض عليك! رجال الأمن أمسكوا بك.','caught');return;}
    }
    world.anyChase=anyChase;
  }

  function nearestSafeFloorCell(g){
    const start=canvasToGrid(g.x,g.y);
    if(isFloor(start.x,start.y)){
      const pos=worldToCanvas(world,start.x,start.y);
      if(canGuardStandAt(pos.x,pos.y,g.radius)) return [start.x,start.y];
    }
    const q=[[start.x,start.y]],seen=new Set([start.x+','+start.y]);
    for(let i=0;i<q.length;i++){
      const [x,y]=q[i];
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const nx=x+dx,ny=y+dy,key=nx+','+ny;
        if(seen.has(key)||!isFloor(nx,ny))continue;
        seen.add(key);q.push([nx,ny]);
        const pos=worldToCanvas(world,nx,ny);
        if(canGuardStandAt(pos.x,pos.y,g.radius))return [nx,ny];
      }
    }
    return null;
  }

  // Robust grid pathfinder. Accepts either {x,y} objects or [x,y] tuples,
  // but internally uses one representation only. This prevents the old
  // object/array mismatch that silently reduced chase paths to length 1.
  function findGridPath(start, target){
    const s=Array.isArray(start)?[start[0],start[1]]:[start?.x,start?.y];
    const t=Array.isArray(target)?[target[0],target[1]]:[target?.x,target?.y];
    if(!Number.isInteger(s[0]) || !Number.isInteger(s[1]) || !Number.isInteger(t[0]) || !Number.isInteger(t[1])) return [];
    if(!isFloor(s[0],s[1]) || !isFloor(t[0],t[1])) return [];
    if(s[0]===t[0] && s[1]===t[1]) return [[s[0],s[1]]];

    const q=[[s[0],s[1]]];
    const prev=new Map([[s[0]+','+s[1],null]]);
    const dirs=[[1,0],[-1,0],[0,1],[0,-1]];

    for(let i=0;i<q.length;i++){
      const [x,y]=q[i];
      if(x===t[0] && y===t[1]) break;
      for(const [dx,dy] of dirs){
        const nx=x+dx, ny=y+dy;
        const key=nx+','+ny;
        if(!isFloor(nx,ny) || prev.has(key)) continue;
        prev.set(key,[x,y]);
        q.push([nx,ny]);
      }
    }

    const targetKey=t[0]+','+t[1];
    if(!prev.has(targetKey)) return [];

    const path=[];
    let cur=[t[0],t[1]];
    while(cur){
      path.push(cur);
      cur=prev.get(cur[0]+','+cur[1]) || null;
    }
    path.reverse();
    return path;
  }

  function updateSecurityCameras(dt,now,playerSpeed){
    if(!world.cameras?.length)return;
    const p=world.player; const nowSec=now/1000;
    for(const cam of world.cameras){
      cam.angle+=cam.sweep*dt*(0.42+level.level*0.028);
      cam.angle=Math.atan2(Math.sin(cam.angle),Math.cos(cam.angle));
      const dx=p.x-cam.x,dy=p.y-cam.y,d=Math.hypot(dx,dy);
      const RANGE=150;
      const HALF_ANGLE=0.25;
      if(d>RANGE){
        cam.trigger=Math.max(0,(cam.trigger||0)-dt*4);
        continue;
      }
      const target=Math.atan2(dy,dx);
      const diff=Math.abs(Math.atan2(Math.sin(target-cam.angle),Math.cos(target-cam.angle)));
      // Add the player's angular radius so a camera does not miss because its cone
      // passes across the edge of the character between simulation steps.
      const bodyAngle=d>1?Math.asin(Math.min(.45,(p.r||8)/d)):.45;
      const inCone=diff<(HALF_ANGLE+bodyAngle);
      // A camera can only report the player when the entire sight ray is clear.
      // Any wall cell between camera and player blocks detection, regardless of range.
      const clear=inCone && hasLineOfSight(cam,p);
      if(clear && (world.continueGrace||0)<=0){
        const firstDetection=!cam.trigger;
        if(world.spotSeen) world.spotSeen.camera=true;
        cam.trigger=1;
        world.alarmUntil=Math.max(world.alarmUntil||0,nowSec+6);
        world.alarmTarget={x:p.x,y:p.y};
        if(!world.radarPulses.some(r=>Math.abs(r.x-cam.x)<1&&Math.abs(r.y-cam.y)<1&&r.life>.5)) world.radarPulses.push({x:cam.x,y:cam.y,r:12,max:176,life:.75});
        if(firstDetection){playSfx('alarm');}
      }else{
        cam.trigger=Math.max(0,(cam.trigger||0)-dt*5);
      }
    }
  }

  // Kept as a safe fallback for any older call site. It is intentionally random
  // over the whole connected floor set and never reads the player.
  function hasLineOfSight(a,b){
    const d=dist(a,b);
    if(d<1) return true;
    const steps=Math.max(2,Math.ceil(d/6));
    for(let i=1;i<steps;i++){
      const t=i/steps;
      const x=a.x+(b.x-a.x)*t,y=a.y+(b.y-a.y)*t;
      const g=canvasToGrid(x,y);
      if(!isFloor(g.x,g.y)) return false;
    }
    return true;
  }

  function updateHazards(dt,speed){
    const p=world.player;
    for(const h of world.hazards){
      h.cool=Math.max(0,h.cool-dt);
      if(h.cool<=0 && dist(p,h)<h.r+7 && speed>10){
        h.cool=1.25; world.radarPulses.push({x:h.x,y:h.y,r:8,max:105,life:1.0});
        playSfx('glass');
      }
    }
  }
  function updateTimer(dt){
    if(!world.timerRunning || isGameOver) return;
    world.continueGrace=Math.max(0,(world.continueGrace||0)-dt);
    world.timer=Math.max(0,world.timer-dt);
    if(world.timer<=0&&!world.lockdown){
      world.timer=0; world.lockdown=true; canvas.classList.add('lockdown'); playSfx('lockdown');
      world.guards.forEach(g=>{g.state='CHASE';g.lastKnown={...world.player};g.target={...world.player};g.vx*=2;g.vy*=2;});
    }
  }
  function checkFailureAndSuccess(){
    if(world.lockdown){fail('انتهى الوقت — تم تفعيل الإغلاق الأحمر','time');return;}
    if(world.escapeArmed){
      const doorRect={left:world.escape.x-18,right:world.escape.x+18,top:world.escape.y-18,bottom:world.escape.y+18};
      if(entityTouchesRect(world.player, doorRect)){ succeed(); }
    }
  }
  function advanceToNextLevel(){
    const global=((level.stage-1)*7)+level.level;
    if(global>=35){ openLevelSelect(); return; }
    const nextGlobal=global+1;
    const nextStage=Math.floor((nextGlobal-1)/7)+1;
    const nextRound=((nextGlobal-1)%7)+1;
    level.stage=nextStage; level.level=nextRound; level.turn=nextGlobal;
    currentViewingStage=nextStage;
    renderLevelSelect();
    startRaid();
  }

  let pendingRewardPurpose=null;
  let rewardAdInFlight=false, rewardAdTimer=null;
  const REWARD_BONUS_SECONDS=25;
  const REWARD_BTN_TEXT_CAUGHT='شاهد وأكمل المداهمة';
  const REWARD_BTN_TEXT_TIME='شاهد واحصل على '+REWARD_BONUS_SECONDS+'ث إضافية';
  const REWARD_EYE_SRC='assets/raid-eye.png';
  // Sets the reward button to its normal label + the raider icon (icon is a real transparent PNG).
  function setRewardBtnReady(btn){
    if(!btn)return;
    const isTime=pendingRewardPurpose==='time';
    btn.textContent='';
    const shine=document.createElement('span'); shine.className='reward-shine'; shine.setAttribute('aria-hidden','true'); btn.appendChild(shine);
    const img=document.createElement('img'); img.className='reward-eye'; img.src=REWARD_EYE_SRC; img.alt=''; img.draggable=false;
    const sp=document.createElement('span'); sp.className='reward-label'; sp.textContent=isTime?REWARD_BTN_TEXT_TIME:REWARD_BTN_TEXT_CAUGHT;
    btn.appendChild(img); btn.appendChild(sp);
    if(isTime){ const bd=document.createElement('span'); bd.className='reward-badge'; bd.textContent='+'+REWARD_BONUS_SECONDS; btn.appendChild(bd); }
    const scr=document.getElementById('failureScreen'); if(scr) scr.classList.toggle('is-time',isTime);
  }

  /**
   * After a rewarded ad the player resumes exactly where they were caught, so the guard that
   * caught them is still standing on top of them. Move EVERY guard to a far-away floor cell
   * (by real walking distance), calm them down, and give a few seconds of protection.
   */
  function relocateGuardsAfterReward(){
    if(!world||!world.guards||!world.grid||!world.player) return;
    const p=world.player;
    world.continueGrace=4;      // seconds with no capture / no camera alarm
    world.alarmUntil=0;
    (world.cameras||[]).forEach(c=>{ if(c) c.trigger=0; });
    const pc=canvasToGrid(p.x,p.y);
    const data=bfsDistancesFrom(world.grid,[pc.x,pc.y]);
    const cands=[];
    let maxD=0;
    for(let y=0;y<world.rows;y++){
      for(let x=0;x<world.cols;x++){
        if(!isFloor(x,y)) continue;
        const d=data.get(x+','+y);
        if(d==null) continue;
        const pos=worldToCanvas(world,x,y);
        if(!canGuardStandAt(pos.x,pos.y,8)) continue;
        cands.push({c:[x,y],d,pos});
        if(d>maxD) maxD=d;
      }
    }
    if(!cands.length) return;
    const minD=Math.max(14,Math.floor(maxD*0.6));
    let pool=cands.filter(k=>k.d>=minD);
    if(pool.length<world.guards.length){ pool=cands.slice().sort((a,b)=>b.d-a.d).slice(0,Math.max(12,world.guards.length*4)); }
    const placed=[];
    world.guards.forEach(g=>{
      let pick=null;
      for(let tries=0;tries<40&&!pick;tries++){
        const k=pool[Math.floor(Math.random()*pool.length)];
        if(placed.every(q=>Math.abs(k.c[0]-q[0])+Math.abs(k.c[1]-q[1])>=6)) pick=k;
      }
      if(!pick) pick=pool[Math.floor(Math.random()*pool.length)];
      placed.push(pick.c);
      g.x=pick.pos.x; g.y=pick.pos.y; g.cell=pick.c.slice();
      g.vx=0; g.vy=0;
      g.state='PATROL';
      g.alertTimer=0; g.chaseUntil=0; g.searchUntil=0;
      g.lastKnown={x:g.x,y:g.y}; g.target={x:g.x,y:g.y};
      g.path=[]; g.pathIndex=1; g.pathTimer=0; g.pathTarget=null;
      g.patrol=null; g.patrolRoute=null; g.patrolRouteIndex=0; g.patrolHistory=[];
      g.patrolCooldown=1.5; g.detourCell=null;
      g.stuckTime=0; g.blockedFrames=0; g.stuckCooldown=0;
      g.lastMoveX=g.x; g.lastMoveY=g.y; g.pulse=0;
    });
    world.anyChase=false;
  }

  function resetRewardState(){
    pendingRewardPurpose=null; rewardAdInFlight=false;
    if(rewardAdTimer){clearTimeout(rewardAdTimer);rewardAdTimer=null;}
  }
  function beginRoundEndFx(kind){
    const gs=screens.PLAYING; if(!gs) return;
    gs.classList.remove('rx-fail','rx-success');
    void gs.offsetWidth;
    gs.classList.add(kind==='fail'?'rx-fail':'rx-success');
  }
  function fail(msg, purpose='caught'){
    if(!isMapFullyLoaded||isGameOver)return;
    isGameOver=true;
    canvas.classList.remove('lockdown');
    pendingRewardPurpose=purpose; rewardAdInFlight=false;
    if(rewardAdTimer){clearTimeout(rewardAdTimer);rewardAdTimer=null;}
    const spotted=purpose==='spotted';
    const rewardBtn=document.getElementById('rewardContinueBtn');
    if(rewardBtn){rewardBtn.classList.remove('sr-hide');rewardBtn.disabled=false;setRewardBtnReady(rewardBtn);}
    const failScreen=document.getElementById('failureScreen');
    if(failScreen) failScreen.classList.toggle('is-spotted',spotted);
    showSpotFailure();
    const failureTitle=document.querySelector('#failureScreen .rs2-title');
    const failureText=document.querySelector('#failureScreen .rs2-sub');
    if(failureTitle) failureTitle.textContent=spotted?'انكشف أمرك!':(purpose==='time'?'انتهى الوقت!':'اتمسكت!');
    if(failureText) failureText.textContent=spotted?'تم رصدك مرات كثيرة':(purpose==='time'?'انتهى الوقت قبل أن تهرب بالمسروقات.':'أحاط بك رجال الأمن وأُغلقت العملية.');
    // A short, deliberate beat on the frozen last frame (red vignette + punch), then a cross-fade to the result screen.
    beginRoundEndFx('fail');
    recordResult(false);
    haptic([120,70,220]);
    // No waiting beat: the failure screen starts fading in over the frozen frame right away while the red
    // vignette (compositor-only) plays on the layer underneath. Nothing heavy runs in this frame.
    setState('FAILURE');
    fadeGameOverMusicIn();
    schedulePrebuild('fail');
  }

  function requestRewardContinue(){
    if(!pendingRewardPurpose || rewardAdInFlight) return;
    sirenStop(true);
    const btn=document.getElementById('rewardContinueBtn');
    const ads=window.SilentRaidAds;
    if(!ads || typeof ads.showRewarded!=='function'){
      if(btn){btn.disabled=false;btn.textContent='الإعلان غير متاح الآن';}
      showMessage('الإعلان غير جاهز. أعد المحاولة أو ابدأ من جديد.');
      return;
    }
    rewardAdInFlight=true;
    if(btn) btn.disabled=true;
    // Safety net: if the native side never answers, release the button.
    rewardAdTimer=setTimeout(()=>{rewardAdTimer=null; if(rewardAdInFlight){rewardAdInFlight=false; if(btn){btn.disabled=false;setRewardBtnReady(btn);}}},120000);
    track('reward_ad_requested',{level_name:levelName(),purpose:pendingRewardPurpose});
    try{ ads.showRewarded(pendingRewardPurpose); }
    catch(e){
      rewardAdInFlight=false;
      if(rewardAdTimer){clearTimeout(rewardAdTimer);rewardAdTimer=null;}
      if(btn){btn.disabled=false;btn.textContent='تعذر عرض الإعلان — حاول مجددًا';}
    }
  }
  window.onNativeRewardAdEarned=function(purpose){
    // Reward only once, only for an ad requested by the player, only for the purpose requested.
    if(!pendingRewardPurpose || !rewardAdInFlight || purpose!==pendingRewardPurpose || !world) return;
    const earned=pendingRewardPurpose;
    track('reward_ad_earned',{level_name:levelName(),purpose:earned});
    resetRewardState(); isGameOver=false;
    canvas.classList.remove('lockdown'); world.lockdown=false; world.timerRunning=true;
    if(earned==='time') world.timer=Math.max(0,Number(world.timer)||0)+REWARD_BONUS_SECONDS; // bonus seconds only when time ran out
    relocateGuardsAfterReward();
    if(earned==='spotted' && world.spot){
      // Resume with exactly one sighting left before the mission fails again.
      const sp=world.spot;
      sp.count=Math.max(0,sp.limits.failAt-1);
      sp.stars=starsForSpots(sp.count,sp.limits);
      sp.exposed=false; sp.unseen=0;
      initSpotHud();
    }
    setState('PLAYING');
  };
  window.onNativeRewardAdStatus=function(status){
    const btn=document.getElementById('rewardContinueBtn'); if(!btn)return;
    status=String(status||'');
    if(status==='ready'){ if(!rewardAdInFlight){btn.disabled=false;btn.dataset.adReady='1';setRewardBtnReady(btn);} return; }
    // The player already tapped the button and the ad is still loading: keep waiting. The native
    // side shows the ad as soon as it is ready and then calls onNativeRewardAdEarned.
    if(status==='loading' && rewardAdInFlight){ btn.disabled=true; btn.textContent='جارٍ تجهيز الإعلان…'; return; }
    // any other non-ready status while an ad was requested means no reward will come
    rewardAdInFlight=false; if(rewardAdTimer){clearTimeout(rewardAdTimer);rewardAdTimer=null;}
    btn.dataset.adReady='0';btn.disabled=false;
    if(status==='loading')btn.textContent='جارٍ تجهيز الإعلان…';
    else if(status==='offline')btn.textContent='لا يوجد اتصال بالإنترنت — الإعلان يحتاج إنترنت';
    else if(status==='consent_required')btn.textContent='يلزم إعداد الموافقة في AdMob';
    else if(status==='not_ready')btn.textContent='الإعلان غير جاهز، حاول بعد لحظات';
    else if(status.indexOf('engine_failed')===0){const q=status.split(':');btn.textContent='تعذر تشغيل محرك الإعلان — WebView: '+(q[1]||'?').replace(/_/g,' ').trim()+' | Android '+(q[2]||'?')+' | '+(q[3]||'').replace(/_/g,' ').trim();}
    else if(status.indexOf('load_failed')===0){const q=status.split(':');btn.textContent='تعذر تحميل الإعلان (خطأ '+(q[1]||'?')+(q[2]?' - '+q[2].replace(/_/g,' ').trim():'')+')';}
    else btn.textContent='تعذر عرض الإعلان — حاول مجددًا';
  };
  window.onNativeRewardAdFailed=function(){window.onNativeRewardAdStatus('not_ready');};
  window.onNativeRewardAdReady=function(){window.onNativeRewardAdStatus('ready');};
  const SPOT_W={g:.35,c:.25,e:.15,n:.20,l:.05};
  const SPOT_REF={guard:3*1.08*(88+6*2)/150,camera:8,exposure:.25,narrowLo:.24,narrowHi:.65,load:.33,scoreLo:.35,scoreHi:.90};
  // ===== Detection (spotting) + adaptive stars =====
  // Stars depend ONLY on how many times the thief is spotted by a guard or a
  // camera. The allowed margins are inferred from the real round that was built.
  const SPOT_STARS_KEY='silent_raid_stars_v2';
  const SPOT_REARM_SECONDS=1.0;   // a new spotting needs the thief to stay unseen this long
  const SPOT_CAMERA_RANGE=150;    // same range the cameras use in updateSecurityCameras
  const spotLimitCache={};        // per round, per app session: retries keep the same rules
  function arDigits(v){ return String(v).replace(/\d/g,d=>'٠١٢٣٤٥٦٧٨٩'[Number(d)]); }
  function spotClamp01(v){ return Math.max(0,Math.min(1,v)); }
  function bfsPathCells(grid,a,b){
    const h=grid.length,w=grid[0].length,prev=new Map([[a.join(','),null]]),q=[a];
    for(let i=0;i<q.length;i++){
      const [x,y]=q[i];
      if(x===b[0]&&y===b[1]) break;
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const nx=x+dx,ny=y+dy,k=nx+','+ny;
        if(nx>=0&&ny>=0&&nx<w&&ny<h&&grid[ny][nx]===0&&!prev.has(k)){prev.set(k,[x,y]);q.push([nx,ny]);}
      }
    }
    const out=[]; let cur=prev.has(b.join(','))?b:null;
    while(cur){ out.push(cur); cur=prev.get(cur.join(',')); }
    return out.reverse();
  }
  // Reads the built round (the global `world` must already be this round).
  function measureRoundDifficulty(w){
    const floor=w.floorCells, nF=Math.max(1,floor.length);
    let narrow=0;
    for(const [x,y] of floor){
      let n=0; for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) if(isFloor(x+dx,y+dy)) n++;
      if(n<=2) narrow++;
    }
    const start=[1,1];
    const vaultCell=(()=>{const g=canvasToGrid(w.vault.x,w.vault.y);return [g.x,g.y];})();
    const escapeCell=(()=>{const g=canvasToGrid(w.escape.x,w.escape.y);return [g.x,g.y];})();
    const stops=[start,...w.keyCells,vaultCell,escapeCell];
    const route=new Map();
    for(let i=0;i<stops.length-1;i++) for(const c of bfsPathCells(w.grid,stops[i],stops[i+1])) route.set(c.join(','),c);
    let exposed=0;
    for(const c of route.values()){
      const pos=worldToCanvas(w,c[0],c[1]);
      if(w.cameras.some(cam=>dist(cam,pos)<=SPOT_CAMERA_RANGE && hasLineOfSight(cam,pos))) exposed++;
    }
    return {
      guardPressure:w.guards.length*((Number(w.guardSpeed)||88)/150),
      cameraCount:w.cameras.length,
      routeExposure:route.size?exposed/route.size:0,
      narrowness:narrow/nF,
      routeLoad:route.size/nF
    };
  }
  // Difficulty -> tolerance 0..1 -> three margins. Harder to avoid detection = more margin.
  function analyzeRoundDifficulty(w){
    const m=measureRoundDifficulty(w);
    const f={
      g:spotClamp01(m.guardPressure/SPOT_REF.guard),
      c:spotClamp01(m.cameraCount/SPOT_REF.camera),
      e:spotClamp01(m.routeExposure/SPOT_REF.exposure),
      n:spotClamp01((m.narrowness-SPOT_REF.narrowLo)/(SPOT_REF.narrowHi-SPOT_REF.narrowLo)),
      l:spotClamp01(m.routeLoad/SPOT_REF.load)
    };
    const score=SPOT_W.g*f.g+SPOT_W.c*f.c+SPOT_W.e*f.e+SPOT_W.n*f.n+SPOT_W.l*f.l;
    const tol=spotClamp01((score-SPOT_REF.scoreLo)/(SPOT_REF.scoreHi-SPOT_REF.scoreLo));
    const loseFirst=1+Math.round(tol*2);            // detections that cost the 1st star
    const loseSecond=loseFirst+1+Math.round(tol);   // ...the 2nd star
    const failAt=loseSecond+1+Math.round(tol);      // ...mission failure
    return {score,tol,measures:m,limits:{loseFirst,loseSecond,failAt}};
  }
  function starsForSpots(count,lim){
    if(count>=lim.failAt) return 0;
    if(count>=lim.loseSecond) return 1;
    if(count>=lim.loseFirst) return 2;
    return 3;
  }
  function createSpotState(w){
    const id=((level.stage-1)*7)+level.level;
    let info=spotLimitCache[id];
    if(!info){ info=analyzeRoundDifficulty(w); spotLimitCache[id]=info; }
    return {count:0,exposed:false,unseen:0,limits:{...info.limits},stars:3,lastSource:null,flash:0};
  }

  // ---- Stats, stars and haptics (all stored locally) ----
  const STATS_KEY='silent_raid_stats_v1';
  function readJson(key,def){ try{ const v=JSON.parse(localStorage.getItem(key)||'null'); return (v&&typeof v==='object')?v:def; }catch(_){ return def; } }
  function writeJson(key,v){ try{ localStorage.setItem(key,JSON.stringify(v)); }catch(_){} }
  // Analytics (Firebase via the native bridge). Silent no-op in a normal browser or when Firebase is not configured.
  function track(name,params){ try{ const a=window.SilentRaidAnalytics; if(a&&typeof a.logEvent==='function') a.logEvent(String(name),JSON.stringify(params||{})); }catch(_){} }
  function levelName(){ try{ return 's'+level.stage+'_l'+level.level; }catch(_){ return 'unknown'; } }
  function haptic(pattern){ try{ if(navigator.vibrate) navigator.vibrate(pattern); }catch(_){} }
  // ---- Stars: saved best result per round, star markup, HUD and result UI ----
  const SR_STAR_PATH='M32.0 5.0 L39.4 23.8 L59.6 25.0 L44.0 37.9 L49.0 57.5 L32.0 46.6 L15.0 57.5 L20.0 37.9 L4.4 25.0 L24.6 23.8 Z';
  function srStarHtml(on,i,shards){
    const sh=shards?[0,60,120,180,240,300].map(a=>`<i style="--a:${a}deg"></i>`).join(''):'';
    return `<span class="sr-star ${on?'on':'off'}" style="--i:${i}"><svg viewBox="0 0 64 64" aria-hidden="true"><path class="sr-star-off" d="${SR_STAR_PATH}"/><path class="sr-star-on" d="${SR_STAR_PATH}"/></svg>${sh}</span>`;
  }
  function srStarsRow(n,shards){ return [1,2,3].map(i=>srStarHtml(i<=n,i,shards)).join(''); }
  function readStarRecords(){
    const raw=readJson(SPOT_STARS_KEY,{}), out={};
    for(const k of Object.keys(raw)){
      const v=raw[k]; const st=Number(v&&v.s)||0;
      if(st>=1&&st<=3) out[k]={s:st,d:Math.max(0,Math.floor(Number(v.d)||0))};
    }
    return out;
  }
  function isBetterResult(next,prev){
    if(!prev) return true;
    return next.s>prev.s || (next.s===prev.s && next.d<prev.d);
  }
  function recordResult(won){
    const st=readJson(STATS_KEY,{wins:0,losses:0,bestTime:{}});
    if(!st.bestTime||typeof st.bestTime!=='object') st.bestTime={};
    const sp=world?.spot;
    const spots=sp?sp.count:0;
    let stars=0, newBest=false;
    if(won){
      st.wins=(st.wins||0)+1;
      stars=Math.max(1,starsForSpots(spots,sp?sp.limits:{loseFirst:1,loseSecond:2,failAt:3}));
      const id=((level.stage-1)*7)+level.level;
      const all=readStarRecords();
      const prev=all[id], next={s:stars,d:spots};
      if(isBetterResult(next,prev)){ newBest=!!prev; all[id]=next; writeJson(SPOT_STARS_KEY,all); }
      const used=Math.round((Number(world.timerStart)||0)-(Number(world.timer)||0));
      if(!st.bestTime[id]||used<st.bestTime[id]) st.bestTime[id]=used;
    }else st.losses=(st.losses||0)+1;
    writeJson(STATS_KEY,st);
    track('level_end',{level_name:levelName(),stage:level.stage,level:level.level,success:won?1:0,stars,spots,
      duration_s:Math.max(0,Math.round((Number(world?.timerStart)||0)-(Number(world?.timer)||0)))});
    return {stars,spots,newBest};
  }
  function spotResultText(stars,spots){
    if(stars>=3) return spots===0?'تنفيذ مثالي — لم يرصدك أحد':'عمل رائع — بقيت ضمن الحد المسموح للرصد';
    if(stars===2) return 'تم فقدان نجمة بسبب زيادة مرات الرصد.';
    return 'تم فقدان نجمتين بسبب زيادة مرات الرصد.';
  }
  function showStars(result){
    const row=document.getElementById('rsStars'); if(!row) return;
    row.classList.toggle('perfect',result.stars>=3);
    row.setAttribute('aria-label',`النجوم: ${arDigits(result.stars)} من ٣`);
    row.innerHTML=srStarsRow(result.stars,false)+(result.stars>=3?'<span class="sr-burst" aria-hidden="true">'+[0,36,72,108,144,180,216,252,288,324].map(a=>`<i style="--a:${a}deg"></i>`).join('')+'</span>':'');
    const cnt=document.getElementById('rsSpotCount');
    if(cnt) cnt.innerHTML=`<span>مرات الرصد: ${arDigits(result.spots)}</span>`+(result.newBest?'<em class="rs2-newbest">أفضل نتيجة جديدة!</em>':'');
    const msg=document.getElementById('rsMessage');
    if(msg) msg.textContent=spotResultText(result.stars,result.spots);
  }
  function showSpotFailure(){
    const sp=world?.spot; if(!sp) return;
    const row=document.getElementById('failStars'); if(row) row.innerHTML=srStarsRow(0,false); // any lost round (caught, spotted too often, time) shows zero stars
    const cnt=document.getElementById('failSpotCount');
    if(cnt) cnt.textContent=`مرات الرصد: ${arDigits(sp.count)} / ${arDigits(sp.limits.failAt)}`;
  }
  function totalStars(){ return Object.values(readStarRecords()).reduce((a,b)=>a+(Number(b.s)||0),0); }
  window.SilentRaidStats={totalStars,read:()=>readJson(STATS_KEY,{}),stars:()=>{const r=readStarRecords(),o={};for(const k of Object.keys(r))o[k]=r[k].s;return o;}};

  // ---- In-round detection events + stars HUD ----
  function updateDetectionEvents(dt){
    const sp=world?.spot; if(!sp||isGameOver) return;
    const seen=world.spotSeen||{};
    if(seen.guard||seen.camera){
      sp.unseen=0;
      if(!sp.exposed){ sp.exposed=true; registerDetection(seen.guard?'guard':'camera'); }
    }else if(sp.exposed){
      sp.unseen+=dt;
      if(sp.unseen>=SPOT_REARM_SECONDS){ sp.exposed=false; sp.unseen=0; }
    }
  }
  function registerDetection(source){
    const sp=world.spot, before=sp.stars;
    sp.count++; sp.lastSource=source;
    sp.stars=starsForSpots(sp.count,sp.limits);
    track('spotted',{level_name:levelName(),source,count:sp.count,stars:sp.stars});
    animateSpotHud(source,before,sp.stars);
    haptic(35);
    if(sp.count>=sp.limits.failAt) fail('تم رصدك مرات كثيرة','spotted');
  }
  function initSpotHud(){
    const el=document.getElementById('spotHud'); if(!el||!world?.spot) return;
    clearTimeout(el._t);
    el.classList.remove('hit','hit-loss');
    const stars=el.querySelector('.spot-hud-stars'); if(stars) stars.innerHTML=srStarsRow(world.spot.stars,true);
    renderSpotCount();
  }
  function renderSpotCount(){
    const el=document.getElementById('spotHud'), sp=world?.spot; if(!el||!sp) return;
    const c=el.querySelector('.spot-hud-count');
    const text=`الرصد: ${arDigits(sp.count)} / ${arDigits(sp.limits.failAt)}`;
    if(c) c.textContent=text;
    el.setAttribute('aria-label',`${text} — النجوم: ${arDigits(sp.stars)} من ٣`);
  }
  function animateSpotHud(source,before,after){
    const el=document.getElementById('spotHud'); if(!el) return;
    renderSpotCount();
    const spans=el.querySelectorAll('.spot-hud-stars .sr-star');
    for(let i=before;i>after;i--){
      const sp=spans[i-1]; if(!sp) continue;
      sp.classList.remove('on'); sp.classList.add('off','lost');
      setTimeout(()=>sp.classList.remove('lost'),950);
    }
    const lost=before>after;
    const flash=el.querySelector('.spot-hud-flash');
    if(flash) flash.textContent=(source==='camera'?'رصدتك الكاميرا':'رصدك الحارس')+(lost?' — خسرت نجمة':'');
    el.classList.remove('hit','hit-loss'); void el.offsetWidth;
    el.classList.add('hit'); if(lost) el.classList.add('hit-loss');
    clearTimeout(el._t);
    el._t=setTimeout(()=>el.classList.remove('hit','hit-loss'),1700);
  }
  function renderLevelSelectStars(){
    const rec=readStarRecords();
    document.querySelectorAll('#stageCardsTrack .stage-round-card').forEach(card=>{
      const r=Number(card.dataset.round)||0; if(r<1||r>7) return;
      const plaque=card.querySelector('.card-plaque'); if(!plaque) return;
      let box=card.querySelector('.card-stars');
      if(!box){ box=document.createElement('div'); box.className='card-stars'; plaque.appendChild(box); }
      const id=((currentViewingStage-1)*7)+r;
      const best=rec[id]?rec[id].s:0;
      box.innerHTML=srStarsRow(best,false);
      const spots=rec[id]?rec[id].d:null;
      card.setAttribute('aria-label',`الدور ${arDigits(r)} — ${best?`أفضل نتيجة: ${arDigits(best)} من ٣ نجوم، مرات الرصد: ${arDigits(spots)}`:'لم يُلعب بعد'}`);
    });
    const tot=document.getElementById('lsTotalText');
    if(tot) tot.textContent=`${arDigits(totalStars())} / ${arDigits(TOTAL_LEVELS*3)}`;
  }

  function succeed(){
    if(!isMapFullyLoaded||isGameOver)return;
    stopResultMusicNow();
    isGameOver=true;
    // Start the escape-door animation at the exact same moment as the existing
    // door-opening sound. The animation duration matches that recording.
    world.escapeDoorAnimStart=performance.now()/1000;
    // The money-win SFX is immediate on escape success (original timing).
    playSfx('success');
    playSfx('escape');
    try{
      if(audio?.ac?.state==='running' && music.finalGain){
        music.finalGain.gain.cancelScheduledValues(audio.ac.currentTime);
        music.finalGain.gain.setTargetAtTime(0,audio.ac.currentTime,.70);
      }
    }catch(_){ }
    markRoundCompleted(level.stage,level.level);
    const result=recordResult(true);
    // Keep the success SFX aligned with the result transition.
    beginRoundEndFx('success');
    setTimeout(()=>{
      if(!isGameOver)return;
      setState('SUCCESS');
      showStars(result);
      haptic([40,40,90]);
      // The falling money and the music start after the cross-fade, so the transition frames stay light.
      setTimeout(()=>{ if(gameState==='SUCCESS'){ startResultRain('money'); fadeResultMusicIn(); } },300);
      schedulePrebuild('success');
    },1000);
  }

  function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
  function draw(now){
    updateCamera();

    // The physical canvas is fullscreen, while the gameplay scene is rendered
    // with exactly one scale factor on both axes. No image/object-fit stretching
    // is used anywhere in the gameplay render path.
    ctx.setTransform(viewport.dpr,0,0,viewport.dpr,0,0);
    ctx.fillStyle='#090a0c';
    ctx.fillRect(0,0,viewport.width,viewport.height);

    if(gameState!=='PLAYING'||!world||!isMapFullyLoaded)return;

    const s=viewport.scale;
    const sx=s*viewport.dpr;
    const tx=(-viewport.cameraX*s)*viewport.dpr;
    const ty=(-viewport.cameraY*s)*viewport.dpr;
    ctx.setTransform(sx,0,0,sx,tx,ty);
    // Standing still collapses the light to nothing: the fog is then 100% opaque, so drawing the
    // world underneath it is pure waste.
    if((Number(world.lightRadius)||0)>2) drawWorld(now);
    drawLighting(now);
    drawHUDEffects();
  }
  function visibleWorldBounds(pad=2){
    let left=Math.max(0,Math.floor(viewport.cameraX-pad));
    let top=Math.max(0,Math.floor(viewport.cameraY-pad));
    let right=Math.min(W,Math.ceil(viewport.cameraX+viewport.viewW+pad));
    let bottom=Math.min(H,Math.ceil(viewport.cameraY+viewport.viewH+pad));
    // Fog of war covers everything outside this circle with opaque black. Do
    // not spend draw calls painting bank tiles that cannot reach the display.
    // This keeps the one-canvas renderer smooth while preserving every visible
    // pixel of the original lighting/design.
    const p=world?.player;
    const light=Math.max(0,Number(world?.lightRadius)||0);
    if(p){
      const visionPad=light>2 ? light+pad+3 : pad+3;
      left=Math.max(left,Math.floor(p.x-visionPad));
      top=Math.max(top,Math.floor(p.y-visionPad));
      right=Math.min(right,Math.ceil(p.x+visionPad));
      bottom=Math.min(bottom,Math.ceil(p.y+visionPad));
    }
    return {left,top,right,bottom,width:Math.max(1,right-left),height:Math.max(1,bottom-top)};
  }

  // Paint only the camera-visible portion directly onto the primary Canvas.
  // This preserves the existing floor/wall artwork exactly while removing the
  // persistent full-map offscreen canvas (the highest-risk GPU allocation on
  // older Android WebViews).
  const bgWallBuf=[];
  function drawWorldBackground(target,w,bounds){
    const c=w.cell, bw=w.cols*c, bh=w.rows*c, p=w.palette;
    const minCol=Math.max(0,Math.floor((bounds.left-w.ox)/c)-1);
    const maxCol=Math.min(w.cols-1,Math.ceil((bounds.right-w.ox)/c)+1);
    const minRow=Math.max(0,Math.floor((bounds.top-w.oy)/c)-1);
    const maxRow=Math.min(w.rows-1,Math.ceil((bounds.bottom-w.oy)/c)+1);

    // Pitch dark void around the bank.
    target.fillStyle=p.world;
    target.fillRect(bounds.left,bounds.top,bounds.width,bounds.height);

    // Bank floor uses the same world-space gradient as the old cached layer.
    const floorGrad=target.createLinearGradient(w.ox,w.oy,w.ox+bw,w.oy+bh);
    floorGrad.addColorStop(0,p.floorA); floorGrad.addColorStop(.35,p.floorB); floorGrad.addColorStop(1,p.floorC);
    target.fillStyle=floorGrad; target.fillRect(w.ox,w.oy,bw,bh);

    // Floor tiles + walls. Geometry is static per world: every 6x6-cell chunk gets its Path2D objects built once
    // (the first time it is on screen) and each frame only replays the visible chunks. Previously thousands of
    // per-tile / per-wall path calls and many short-lived objects were rebuilt every single frame.
    const CH=6, chCols=Math.ceil(w.cols/CH), chRows=Math.ceil(w.rows/CH);
    if(!w._chunks) w._chunks=new Array(chCols*chRows);
    const cMin=Math.floor(minCol/CH), cMax=Math.floor(maxCol/CH), rMin=Math.floor(minRow/CH), rMax=Math.floor(maxRow/CH);
    const chunks=bgWallBuf; chunks.length=0;
    for(let cy=rMin;cy<=rMax;cy++) for(let cx=cMin;cx<=cMax;cx++){
      const key=cy*chCols+cx;
      let ch=w._chunks[key];
      if(ch===undefined) ch=w._chunks[key]=buildMapChunk(w,cx*CH,cy*CH,Math.min(w.cols,cx*CH+CH),Math.min(w.rows,cy*CH+CH));
      if(ch) chunks.push(ch);
    }
    if(chunks.length){
      const styles=w._toneStyles||(w._toneStyles=[0,1,2,3,4,5,6].map(i=>`rgba(${p.glow},${0.03+i*.005})`));
      const nAll=chunks.length;
      for(let t=0;t<7;t++){
        target.fillStyle=styles[t];
        for(let i=0;i<nAll;i++){ const tp=chunks[i].tones[t]; if(tp) target.fill(tp); }
      }
      target.strokeStyle=`rgba(${p.line},.55)`; target.lineWidth=.8;
      for(let i=0;i<nAll;i++) if(chunks[i].tileLines) target.stroke(chunks[i].tileLines);
      target.fillStyle=`rgba(${p.glow},.08)`;
      for(let i=0;i<nAll;i++) if(chunks[i].dots) target.fill(chunks[i].dots);
    }
    // keep only chunks that contain walls for the wall passes
    for(let i=chunks.length-1;i>=0;i--) if(!chunks[i].wall) chunks.splice(i,1);
    if(chunks.length){
      const n=chunks.length;
      // 1) offset shadow + fill (cheap offset copy instead of a blurred shadow)
      target.save();
      target.translate(1.5,2); target.fillStyle='rgba(0,0,0,.30)';
      for(let i=0;i<n;i++) target.fill(chunks[i].wall);
      target.restore();
      target.fillStyle=p.wall;
      for(let i=0;i<n;i++) target.fill(chunks[i].wall);
      // 2) bottom shade + top highlight, clipped to the wall outlines
      for(let i=0;i<n;i++){
        target.save();
        target.clip(chunks[i].wall);
        target.fillStyle=p.wallShade; target.fill(chunks[i].shade);
        target.fillStyle=p.wallTop; target.fill(chunks[i].top);
        target.restore();
      }
      // 3) outlines and inner edge highlights
      target.strokeStyle=`rgba(${p.glow},.50)`; target.lineWidth=1;
      for(let i=0;i<n;i++) target.stroke(chunks[i].wall);
      target.strokeStyle=`rgba(${p.line},.42)`; target.lineWidth=.8;
      for(let i=0;i<n;i++) target.stroke(chunks[i].lines);
    }
  }
  // Builds the static Path2D set (floor tiles + walls) for one chunk of cells; null when the chunk is empty.
  function buildMapChunk(w,x0,y0,x1,y1){
    const c=w.cell;
    const ch={tones:[null,null,null,null,null,null,null],tileLines:null,dots:null,wall:null,shade:null,top:null,lines:null};
    let any=false;
    for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
      const v=w.grid[y][x];
      if(v===0){
        any=true;
        const t=((x*17+y*31+w.seed)>>>0)%7;
        const fx=w.ox+x*c, fy=w.oy+y*c;
        (ch.tones[t]||(ch.tones[t]=new Path2D())).rect(fx+1,fy+1,c-2,c-2);
        (ch.tileLines||(ch.tileLines=new Path2D())).rect(fx+.4,fy+.4,c-.8,c-.8);
        const dots=ch.dots||(ch.dots=new Path2D());
        for(let q=0;q<2;q++) dots.rect(fx+((t*13+q*11)%Math.max(2,c-2))+1,fy+((t*5+q*7)%Math.max(2,c-2))+1,1,1);
      }else if(v===1){
        any=true;
        if(!ch.wall){ ch.wall=new Path2D(); ch.shade=new Path2D(); ch.top=new Path2D(); ch.lines=new Path2D(); }
        const wx=w.ox+x*c,wy=w.oy+y*c;
        const basePad = c * ((1 - BRICK_SIZE_RATIO) / 2);
        const extraPad = c * (CORRIDOR_EXTRA_CLEARANCE_RATIO / 2);
        const leftOpen = w.grid[y]?.[x-1] !== 1;
        const rightOpen = w.grid[y]?.[x+1] !== 1;
        const topOpen = w.grid[y-1]?.[x] !== 1;
        const bottomOpen = w.grid[y+1]?.[x] !== 1;
        const left   = leftOpen ? basePad + extraPad : 0;
        const right  = rightOpen ? basePad + extraPad : 0;
        const topPad = topOpen ? basePad + extraPad : 0;
        const bottom = bottomOpen ? basePad + extraPad : 0;
        const rw=Math.max(1,c-left-right), rh=Math.max(1,c-topPad-bottom);
        const verticalExtra=(c*(WALL_VERTICAL_SCALE-1))/2;
        const rx=wx+left, ry=wy+topPad-verticalExtra, rhFinal=rh+verticalExtra*2;
        const pts=wallPolygon({x:rx,y:ry,w:rw,h:rhFinal,bevel:1});
        ch.wall.moveTo(pts[0].x,pts[0].y);
        for(let k=1;k<pts.length;k++) ch.wall.lineTo(pts[k].x,pts[k].y);
        ch.wall.closePath();
        ch.shade.rect(rx,ry+Math.max(0,rhFinal-5),rw,Math.min(4,rhFinal));
        ch.top.rect(rx,ry,rw,Math.min(3,rhFinal));
        if(w.grid[y]?.[x-1]===0){ ch.lines.moveTo(rx+.5,ry+1); ch.lines.lineTo(rx+.5,ry+rhFinal-1); }
        if(w.grid[y-1]?.[x]===0){ ch.lines.moveTo(rx+1,ry+.5); ch.lines.lineTo(rx+rw-1,ry+.5); }
      }
    }
    return any?ch:null;
  }

  function drawWorld(now){
    drawWorldBackground(ctx,world,visibleWorldBounds());
    drawBankDecor();
    drawKeys(); drawVault(); drawEscape(); drawHazards(); drawGuards(); drawPlayer(now);
  }

  function drawBankDecor(){
    const CAMERA_RANGE=150;
    const CAMERA_HALF_ANGLE=0.25;
    world.cameras?.forEach(cam=>{
      if(!inLitArea(cam.x,cam.y,CAMERA_RANGE+14)) return;
      ctx.save();ctx.translate(cam.x,cam.y);
      ctx.fillStyle='#a9a39a';ctx.strokeStyle=cam.trigger>0?'#d5222d':'#4f5660';ctx.lineWidth=1.3;
      ctx.beginPath();ctx.arc(0,0,6,0,Math.PI*2);ctx.fill();ctx.stroke();
      ctx.rotate(cam.angle);
      const edgeX=Math.cos(CAMERA_HALF_ANGLE)*CAMERA_RANGE;
      const edgeY=Math.sin(CAMERA_HALF_ANGLE)*CAMERA_RANGE;
      ctx.fillStyle=cam.trigger>0?'rgba(220,30,38,.22)':'rgba(219,203,157,.075)';
      ctx.beginPath();ctx.moveTo(5,-2);ctx.lineTo(edgeX,-edgeY);ctx.quadraticCurveTo(CAMERA_RANGE+10,0,edgeX,edgeY);ctx.lineTo(5,2);ctx.closePath();ctx.fill();
      ctx.strokeStyle=cam.trigger>0?'rgba(230,45,55,.38)':'rgba(212,184,120,.18)';ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(5,0);ctx.lineTo(edgeX,-edgeY);ctx.moveTo(5,0);ctx.lineTo(edgeX,edgeY);ctx.stroke();
      ctx.fillStyle=cam.trigger>0?'#f2444f':'#55616d';ctx.fillRect(2,-3,8,6);
      ctx.restore();
    });
  }

  function stageHeistProps(theme, round){
    const table={
      bronze:{
        vaultOuter:'#8a4a1c', vaultFace:'#d0893a', vaultShade:'#6a3412', vaultRim:'#f0c27a',
        vaultCore:'#3a1d0c', spoke:'#f6e0b0', plaque:'#f8e7c4',
        doorFrame:'#6b3a16', doorTrim:'#e0a15c', doorGlass:'rgba(232,186,110,.42)',
        doorSteel:'#8b5424', doorSeam:'#f0c896', ready:'#4e9b60'
      },
      silver:{
        vaultOuter:'#6d7c8c', vaultFace:'#c9d4e0', vaultShade:'#4a5866', vaultRim:'#f4f8fc',
        vaultCore:'#24303a', spoke:'#ffffff', plaque:'#e8eef4',
        doorFrame:'#3d4a56', doorTrim:'#c5d2de', doorGlass:'rgba(186,214,230,.40)',
        doorSteel:'#7d8c99', doorSeam:'#e8f1f7', ready:'#4aa3c8'
      },
      gold:{
        vaultOuter:'#8a620c', vaultFace:'#e2b13a', vaultShade:'#5c4108', vaultRim:'#ffe08a',
        vaultCore:'#2d1d04', spoke:'#fff3c4', plaque:'#fff0c2',
        doorFrame:'#3d2a08', doorTrim:'#f0c14a', doorGlass:'rgba(80,180,120,.28)',
        doorSteel:'#a87916', doorSeam:'#ffe9a8', ready:'#62c07a'
      },
      diamond:{
        vaultOuter:'#0369a1', vaultFace:'#38bdf8', vaultShade:'#075985', vaultRim:'#e0f7ff',
        vaultCore:'#082f49', spoke:'#ffffff', plaque:'#d7f4ff',
        doorFrame:'#0b3a58', doorTrim:'#7dd3fc', doorGlass:'rgba(125,211,252,.38)',
        doorSteel:'#0284c7', doorSeam:'#e0f2fe', ready:'#22d3ee'
      },
      mythic:{
        vaultOuter:'#4a1d4a', vaultFace:'#8b3d8e', vaultShade:'#2a102c', vaultRim:'#e9b5ff',
        vaultCore:'#160814', spoke:'#f3d4ff', plaque:'#f0d6ff',
        doorFrame:'#2a1228', doorTrim:'#c084fc', doorGlass:'rgba(192,132,252,.32)',
        doorSteel:'#6b2a6e', doorSeam:'#f0abfc', ready:'#c084fc'
      }
    };
    const props=Object.assign({}, table[theme] || table.bronze);
    props.round=Math.max(1, Math.min(7, Number(round)||1));
    props.motif=(ROUND_MISSION[props.round]||ROUND_MISSION[1]).motif;
    props.mission=(ROUND_MISSION[props.round]||ROUND_MISSION[1]).title;
    return props;
  }

  function drawRoundVaultMotif(p, theme){
    ctx.fillStyle=p.vaultRim;
    if(p.motif==='lantern'){
      ctx.beginPath();ctx.arc(-9,-28,2.4,0,Math.PI*2);ctx.arc(9,-28,2.4,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#fff4c8';ctx.beginPath();ctx.arc(0,-27,2,0,Math.PI*2);ctx.fill();
    } else if(p.motif==='camera'){
      ctx.beginPath();roundedRectPath(ctx,-7,-31,14,7,2);ctx.fill();
      ctx.fillStyle=p.vaultCore;ctx.beginPath();ctx.arc(0,-27.5,2.2,0,Math.PI*2);ctx.fill();
    } else if(p.motif==='guard'){
      ctx.beginPath();ctx.moveTo(0,-32);ctx.lineTo(7,-24);ctx.lineTo(-7,-24);ctx.closePath();ctx.fill();
    } else if(p.motif==='maze'){
      ctx.lineWidth=1.6;ctx.strokeStyle=p.vaultRim;
      ctx.strokeRect(-8,-31,16,8);ctx.beginPath();ctx.moveTo(-8,-27);ctx.lineTo(2,-27);ctx.stroke();
    } else if(p.motif==='vault' || theme==='gold'){
      ctx.beginPath();ctx.moveTo(0,-32);ctx.lineTo(4,-24);ctx.lineTo(-4,-24);ctx.closePath();ctx.fill();
    } else if(p.motif==='alarm'){
      ctx.fillStyle='#ef4444';ctx.beginPath();ctx.arc(-6,-28,2.6,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#3b82f6';ctx.beginPath();ctx.arc(6,-28,2.6,0,Math.PI*2);ctx.fill();
    } else if(p.motif==='escape'){
      ctx.beginPath();ctx.moveTo(-8,-24);ctx.quadraticCurveTo(0,-34,8,-24);ctx.fill();
    } else if(theme==='diamond'){
      ctx.beginPath();ctx.moveTo(0,-31);ctx.lineTo(5,-24);ctx.lineTo(0,-21);ctx.lineTo(-5,-24);ctx.closePath();ctx.fill();
    } else if(theme==='mythic'){
      ctx.beginPath();ctx.ellipse(0,-28,6,3.5,0,0,Math.PI*2);ctx.fill();
    } else if(theme==='silver'){
      ctx.beginPath();ctx.arc(0,-28,3.2,0,Math.PI*2);ctx.fill();
    }
  }

  function drawKeys(){
    world.keys.forEach((k,i)=>{if(k.collected||!inLitArea(k.x,k.y,30))return;ctx.save();ctx.translate(k.x,k.y);
      const bob=Math.sin(performance.now()*.004+i)*1.5;ctx.translate(0,bob);ctx.rotate(-.08);
      const pal=world.palette||STAGE_PALETTES.bronze;
      ctx.globalAlpha=.22;ctx.fillStyle=pal.accent||'#f0c96c';ctx.beginPath();ctx.arc(-2,0,15,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;
      ctx.strokeStyle='#a66b28';ctx.fillStyle=pal.accent||'#d7a84b';ctx.lineWidth=1.4;
      ctx.beginPath();ctx.arc(-6,0,6,0,Math.PI*2);ctx.fill();ctx.stroke();
      ctx.fillStyle='#8b5a24';ctx.beginPath();ctx.arc(-6,0,2.6,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#d9ad55';ctx.fillRect(0,-2,15,4);ctx.fillRect(9,-2,3,7);ctx.fillRect(13,-2,3,5);
      ctx.strokeStyle='rgba(255,247,205,.75)';ctx.beginPath();ctx.arc(-8,-2,1.5,0,Math.PI*2);ctx.stroke();ctx.restore();
    });
  }

  function drawVault(){
    const v=world.vault; if(!inLitArea(v.x,v.y,60)) return;
    const p=world._heistProps||(world._heistProps=stageHeistProps(world.theme, level.level));
    ctx.save();ctx.translate(v.x,v.y);
    // Cartoon vault keeps the same 60×68 footprint so pickup bounds stay valid.
    ctx.fillStyle='rgba(0,0,0,.22)';ctx.beginPath();roundedRectPath(ctx,-35,-30,70,74,13);ctx.fill();
    ctx.fillStyle='rgba(0,0,0,.2)';ctx.beginPath();roundedRectPath(ctx,-33,-32,66,72,12);ctx.fill();
    ctx.fillStyle=p.vaultOuter;
    ctx.beginPath();roundedRectPath(ctx,-30,-34,60,68,10);ctx.fill();
    ctx.fillStyle=p.vaultShade;
    ctx.beginPath();roundedRectPath(ctx,-25,-29,50,58,8);ctx.fill();
    ctx.fillStyle=p.vaultFace;
    ctx.beginPath();roundedRectPath(ctx,-21,-25,42,50,7);ctx.fill();
    ctx.strokeStyle=p.vaultRim;ctx.lineWidth=2;
    ctx.beginPath();roundedRectPath(ctx,-18,-22,36,44,6);ctx.stroke();

    drawRoundVaultMotif(p, world.theme||'bronze');

    ctx.fillStyle=p.vaultCore;ctx.beginPath();ctx.arc(0,0,12,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle=p.spoke;ctx.lineWidth=2.2;
    for(let a=0;a<Math.PI*2;a+=Math.PI/6){
      ctx.beginPath();ctx.moveTo(Math.cos(a)*4,Math.sin(a)*4);ctx.lineTo(Math.cos(a)*11,Math.sin(a)*11);ctx.stroke();
    }
    ctx.fillStyle=p.vaultRim;ctx.beginPath();ctx.arc(0,0,3.4,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=p.spoke;ctx.fillRect(-4,-18,8,6);ctx.fillRect(-4,12,8,6);
    ctx.fillStyle=world.vaultOpen?p.ready:'#9c352f';ctx.beginPath();ctx.arc(19,-19,3.4,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.45)';ctx.lineWidth=1;ctx.beginPath();ctx.arc(18.2,-19.8,1.1,0,Math.PI*2);ctx.stroke();
    ctx.fillStyle=p.plaque;ctx.font='700 9px Cairo,sans-serif';ctx.textAlign='center';
    ctx.fillText('الخزنة',0,43);
    ctx.font='700 6.5px Cairo,sans-serif';
    ctx.fillText(p.mission,0,52);
    ctx.restore();
  }

  function drawEscape(){
    const e=world.escape;
    ctx.save();
    ctx.translate(e.x,e.y);

    const animStart=world.escapeDoorAnimStart||0;
    const openDur=1.032;
    const progress=animStart?Math.max(0,Math.min(1,(performance.now()/1000-animStart)/openDur)):0;
    const ease=progress*progress*(3-2*progress);

    // Keep the exit 10% smaller than its original V28 presentation.
    const scale=.90;
    ctx.scale(scale,scale);

    const outerW=58, outerH=65;
    const frame=3;
    const innerW=outerW-frame*2;
    const innerH=outerH-frame*2;
    const panelGap=1;
    const panelW=(innerW-panelGap)/2;
    const maxShift=panelW+2;

    const props=world._heistProps||(world._heistProps=stageHeistProps(world.theme, level.level));
    const theme=world.theme||'bronze';

    ctx.fillStyle='#111820';
    ctx.fillRect(-innerW/2,-innerH/2,innerW,innerH);

    ctx.fillStyle=props.doorFrame;
    ctx.strokeStyle='#0e1114';
    ctx.lineWidth=1.6;
    ctx.beginPath();
    if(theme==='mythic' || theme==='gold' || props.motif==='escape'){
      ctx.moveTo(-outerW/2+4,-outerH/2+8);
      ctx.quadraticCurveTo(0,-outerH/2-6,outerW/2-4,-outerH/2+8);
      ctx.lineTo(outerW/2,outerH/2);
      ctx.lineTo(-outerW/2,outerH/2);
      ctx.closePath();
    } else {
      roundedRectPath(ctx,-outerW/2,-outerH/2,outerW,outerH, theme==='diamond'||props.motif==='vault'?10:6);
    }
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle=props.doorTrim;
    ctx.fillRect(-innerW/2,-innerH/2,innerW,2.5);
    ctx.fillRect(-innerW/2,innerH/2-2.5,innerW,2.5);
    ctx.fillRect(-innerW/2,-innerH/2,2.5,innerH);
    ctx.fillRect(innerW/2-2.5,-innerH/2,2.5,innerH);

    const leftClosedX=-innerW/2;
    const rightClosedX=panelGap/2;
    const leftX=leftClosedX-maxShift*ease;
    const rightX=rightClosedX+maxShift*ease;
    const top=-innerH/2+1.5;
    const panelH=innerH-3;

    function drawGlassPanel(x,side){
      ctx.fillStyle=props.doorSteel;
      ctx.strokeStyle='#0e1317';
      ctx.lineWidth=1.2;
      ctx.beginPath();roundedRectPath(ctx,x,top,panelW,panelH,3.5);ctx.fill();ctx.stroke();

      ctx.fillStyle=props.doorGlass;
      ctx.fillRect(x+2,top+2,panelW-4,panelH-4);

      if(props.motif==='alarm'){
        ctx.fillStyle=side==='left'?'rgba(239,68,68,.35)':'rgba(59,130,246,.35)';
        ctx.fillRect(x+2,top+2,panelW-4,6);
      } else if(props.motif==='camera'){
        ctx.fillStyle=props.doorSeam;
        ctx.beginPath();ctx.arc(x+panelW/2,top+10,3.2,0,Math.PI*2);ctx.fill();
      } else if(props.motif==='maze'){
        ctx.strokeStyle='rgba(255,255,255,.22)';ctx.lineWidth=1;
        ctx.strokeRect(x+4,top+8,panelW-8,panelH-16);
      }

      ctx.fillStyle='rgba(255,255,255,.20)';
      ctx.fillRect(x+panelW*.22,top+2,1.2,panelH-4);
      ctx.beginPath();
      ctx.moveTo(x+4,top+panelH*.18);
      ctx.lineTo(x+panelW*.42,top+4);
      ctx.lineTo(x+panelW*.42+2,top+4);
      ctx.lineTo(x+7,top+panelH*.22);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle='rgba(30,39,45,.28)';
      ctx.fillRect(x+2,top+panelH*.72,panelW-4,panelH*.22);

      const seamX=side==='left'?x+panelW-1.5:x+1.5;
      ctx.fillStyle=props.doorSeam;
      ctx.fillRect(seamX,top+panelH*.47,1.5,panelH*.10);
    }

    drawGlassPanel(leftX,'left');
    drawGlassPanel(rightX,'right');

    if(progress<0.02){
      ctx.fillStyle='#13181c';
      ctx.fillRect(-0.7,top+1,1.4,panelH-2);
    }

    ctx.fillStyle=props.doorSteel;
    ctx.fillRect(-innerW/2,innerH/2-2,innerW,2);
    ctx.fillStyle=world.escapeArmed?props.ready:'#8b8f91';
    ctx.font='700 7.2px Cairo,sans-serif';
    ctx.textAlign='center';
    ctx.fillText('مخرج',0,-outerH/2-4);

    ctx.restore();
  }
  function drawHazards(){}

  function drawLighting(now){
    const p=world.player;
    const radius = Math.max(0, Math.min(190, world.lightRadius ?? 0));

    // ── Pure fog-of-war: ONLY the player's dynamic vision circle punches through darkness.
    // The bank is 100% pitch-black. When standing still, the circle completely collapses (radius=0).
    // Outside the circle, absolutely nothing is illuminated.

    // Draw the darkness directly into the active canvas. Keeping a second full
    // world-sized mask canvas meant an extra multi-megabyte GPU texture and a
    // full texture upload/composite every frame, which commonly causes black
    // flashes or context loss on older Android GPUs.
    ctx.save();
    // A radial alpha overlay preserves the already-drawn world beneath it. It
    // is equivalent to the old mask but avoids a second canvas texture.
    if(radius > 2){
      const innerR = Math.max(1, radius * 0.35);
      const pGrad = ctx.createRadialGradient(p.x, p.y, innerR, p.x, p.y, radius);
      pGrad.addColorStop(0, 'rgba(0,0,0,0)');
      pGrad.addColorStop(0.65, 'rgba(0,0,0,0.08)');
      pGrad.addColorStop(0.88, 'rgba(0,0,0,0.55)');
      pGrad.addColorStop(1,    'rgba(0,0,0,1)');
      ctx.fillStyle=pGrad;
      ctx.fillRect(viewport.cameraX-2,viewport.cameraY-2,viewport.viewW+4,viewport.viewH+4);
    }else{
      ctx.fillStyle='#000000';
      ctx.fillRect(viewport.cameraX-2,viewport.cameraY-2,viewport.viewW+4,viewport.viewH+4);
    }
    ctx.restore();

    // Radar pulses are intentionally visible through the darkness.
    world.radarPulses=world.radarPulses.filter(pu=>{
      pu.life-=1/60;
      pu.r+=4;
      return pu.life>0&&pu.r<pu.max;
    });
    world.radarPulses.forEach(pu=>{
      ctx.save();
      ctx.globalAlpha=Math.max(0,pu.life*.30);
      ctx.strokeStyle=pu.life>.7?'#f5f1dc':'#d9d9d9';
      ctx.lineWidth=2;
      ctx.beginPath();
      ctx.arc(pu.x,pu.y,pu.r,0,Math.PI*2);
      ctx.stroke();
      ctx.restore();
    });

    // The burglar's body is ALWAYS rendered on top of darkness
    // When stopped, bank is pitch dark and ONLY the thief body is visible.
    drawPlayer(now,true);
  }

  function drawHUDEffects(){
    if(world.explosionFlash>0){ctx.save();ctx.fillStyle=`rgba(220,30,35,${world.explosionFlash})`;ctx.fillRect(0,0,W,H);ctx.restore();}
    ctx.save();ctx.font='12px "Share Tech Mono"';ctx.fillStyle='rgba(65,50,40,.82)';ctx.fillText(world.escapeArmed?'الخزنة مؤمّنة — اذهب إلى المخرج':'اجمع 3 مفاتيح',20,H-20);ctx.restore();
  }

  function drawPlayer(now,ghostOverlay=false){
    drawPlayerVisual(ctx, world.player, now, ghostOverlay, !!world.vaultOpened);
  }

  function drawPlayerVisual(target,p,now,ghostOverlay=false,hasLoot=false,menuStatic=false){
    target.save();
    target.translate(p.x, p.y);

    // Classic stealth squash & stretch wobble
    const bob = (p.wobble || 0) * Math.sin(now * 0.012) * 0.08;
    const sx = 1 + bob, sy = 1 - bob;

    const characterScale = menuStatic ? 1.0 : THIEF_CHARACTER_SCALE;
    target.scale(characterScale * sx, characterScale * sy);
    target.globalAlpha = ghostOverlay ? 0.75 : 1.0;

    // Subtle stealth walk bounce
    const walkBob = (p.wobble || 0) * Math.abs(Math.sin(now * 0.012)) * -THIEF_WALK_BOB_AMPLITUDE;
    const tilt = (p.wobble || 0) * (p.vx ? Math.sin(now * 0.012) * 0.025 : 0);
    // Fixed render-only correction for the sprite anchor. It never depends on
    // velocity, time, or collision state, so movement remains unchanged and smooth.
    target.translate(0, (menuStatic ? 0 : THIEF_RENDER_Y_OFFSET) + walkBob);
    target.rotate(tilt);

    // Soft stealth floor shadow under the capsule base
    target.fillStyle = 'rgba(0,0,0,0.38)';
    target.beginPath();
    target.ellipse(0, 0, 13, 5, 0, 0, Math.PI * 2);
    target.fill();

    // Select authentic directional thief pose matching the 4 uploaded poses:
    // LEFT, RIGHT, DOWN, UP (with loot variants after vault)
    const poseKey = menuStatic ? 'down' : (p.currentPose || 'down');
    const poseSet = hasLoot ? thiefLootPoses : thiefEmptyPoses;
    const img = (poseSet && poseSet[poseKey]) || (hasLoot ? thiefLootImg : thiefEmptyImg);

    // Standardized 480x480 sprite:
    // Center of capsule body is at X=240 (50.0%), feet baseline sits at Y=460 (95.83%)
    const drawW = hasLoot ? THIEF_SPRITE_DRAW_W_LOOT : THIEF_SPRITE_DRAW_W_EMPTY;
    const drawH = hasLoot ? THIEF_SPRITE_DRAW_H_LOOT : THIEF_SPRITE_DRAW_H_EMPTY;

    if(img && img.complete && img.naturalWidth > 0){
      const dx = -drawW * 0.50;
      // Some poses (look-up) carry extra transparent headroom so the beanie is not clipped:
      // the image is taller than 480px, so scale height and shift the anchor accordingly.
      const padTop = Math.max(0, img.naturalHeight - THIEF_SPRITE_CANVAS);
      const dy = -drawH * ((THIEF_SPRITE_ANCHOR_Y + padTop) / THIEF_SPRITE_CANVAS);
      const drawHImg = drawH * (img.naturalHeight / THIEF_SPRITE_CANVAS);
      target.drawImage(sharpSprite(target,img,drawW,drawHImg), dx, dy, drawW, drawHImg);
      if(hasLoot) drawLootBagFill(target, poseKey);

      // Cohesive subtle blocky/square toon highlights matching the guard's blocky aesthetic on menu
      if(menuStatic){
        target.save();
        target.fillStyle = 'rgba(255, 255, 255, 0.07)';
        // Blocky tactical highlights across torso and knit beanie
        target.fillRect(-10, -26, 7, 7);
        target.fillRect(3, -26, 7, 7);
        target.fillRect(-12, -14, 8, 6);
        target.fillRect(4, -14, 8, 6);
        target.fillStyle = 'rgba(0, 0, 0, 0.12)';
        target.fillRect(-12, -8, 24, 2);
        target.fillRect(-12, 2, 24, 2);
        target.restore();
      }
    } else {
      target.fillStyle = '#18181b';
      target.fillRect(-10, -32, 20, 32);
    }

    target.restore();
  }

  // A direct 480px -> ~120px drawImage uses plain bilinear sampling and shimmers/aliases ("pixelated").
  // Pre-scale once per size with repeated halving, then blit ~1:1.
  function sharpSprite(target,img,logicalW,logicalH){
    try{
      const m=target.getTransform(); const eff=Math.hypot(m.a,m.b);
      const dw=Math.max(8,Math.round(logicalW*eff/4)*4), dh=Math.max(8,Math.round(logicalH*eff/4)*4);
      if(img.naturalWidth<=dw*1.34) return img;
      let perImg=thiefSpriteCache.get(img); if(!perImg){perImg=new Map();thiefSpriteCache.set(img,perImg);}
      const key=dw+'x'+dh; let out=perImg.get(key);
      if(out) return out;
      let cur=img, cw=img.naturalWidth, ch=img.naturalHeight;
      while(cw/2>=dw*1.01){
        const nw=Math.ceil(cw/2), nh=Math.ceil(ch/2);
        const c=document.createElement('canvas'); c.width=nw; c.height=nh;
        const cx=c.getContext('2d'); cx.imageSmoothingEnabled=true; cx.imageSmoothingQuality='high'; cx.drawImage(cur,0,0,nw,nh);
        cur=c; cw=nw; ch=nh;
      }
      out=document.createElement('canvas'); out.width=dw; out.height=dh;
      const ox=out.getContext('2d'); ox.imageSmoothingEnabled=true; ox.imageSmoothingQuality='high'; ox.drawImage(cur,0,0,dw,dh);
      perImg.set(key,out);
      return out;
    }catch(_){ return img; }
  }

  function drawLootBagFill(target,poseKey){
    const bagX = poseKey === 'left' ? 13 : -13;
    const bagY = -19;
    target.save();
    target.fillStyle='rgba(255,221,74,.98)';
    target.strokeStyle='rgba(135,77,13,.95)';
    target.lineWidth=1.15;
    for(const [x,y,r] of [[-7,2,3.5],[-3,0,3.8],[1,1,3.6],[5,0,3.4],[-5,-3,3.1],[0,-4,3.5],[4,-3,3.0]]){
      target.beginPath();
      target.arc(bagX+x,bagY+y,r,0,Math.PI*2);
      target.fill();
      target.stroke();
      target.fillStyle='rgba(255,247,173,.92)';
      target.beginPath();
      target.arc(bagX+x-r*.28,bagY+y-r*.28,r*.28,0,Math.PI*2);
      target.fill();
      target.fillStyle='rgba(255,221,74,.98)';
    }
    target.restore();
  }

  // Only objects that can touch the lit circle are worth drawing (everything else is under opaque fog).
  function inLitArea(x,y,reach){
    const p=world.player, l=Number(world.lightRadius)||0;
    return Math.hypot(x-p.x,y-p.y)<=l+reach;
  }
  function drawGuards(){
    for(let i=0;i<world.guards.length;i++){ const g=world.guards[i]; if(inLitArea(g.x,g.y,175)) drawGuardVisual(ctx,g); }
  }

  function drawGuardVisual(target,g,menuStatic=false){
    const isChasing = g.state === 'CHASE';
    const dangerR = isChasing ? 146 : 122;

    if(!menuStatic){
      // ── FILLED DETECTION CIRCLE: GREEN IN PATROL, RED IN CHASE (SAME OPACITY) ──
      const circleColor = isChasing ? '#ef4444' : '#22c55e';

      target.save();
      // Filled circle: identical smooth opacity
      target.globalAlpha = 0.09;
      target.fillStyle = circleColor;
      target.beginPath();
      target.arc(g.x, g.y, dangerR, 0, Math.PI * 2);
      target.fill();

      // Circle border
      target.globalAlpha = isChasing ? 0.42 : 0.32;
      target.strokeStyle = circleColor;
      target.lineWidth = isChasing ? 2.5 : 2.0;
      target.setLineDash(isChasing ? [10, 6] : [6, 8]);
      target.beginPath();
      target.arc(g.x, g.y, dangerR, 0, Math.PI * 2);
      // soft glow = one wider, fainter pass (a canvas shadowBlur here cost a CPU blur per guard per frame)
      const strokeAlpha = target.globalAlpha;
      target.globalAlpha = strokeAlpha * .35;
      target.lineWidth = (isChasing ? 2.5 : 2.0) + 6;
      target.stroke();
      target.globalAlpha = strokeAlpha;
      target.lineWidth = isChasing ? 2.5 : 2.0;
      target.stroke();
      target.setLineDash([]);

      if(g.pulse>0 && !world.lastPlayerMoving){
        target.globalAlpha = g.pulse * .55;
        target.strokeStyle = '#efe8d6';
        target.lineWidth = 1.5;
        target.beginPath();
        target.arc(g.x, g.y, 18 + g.pulse * 92, 0, Math.PI * 2);
        target.stroke();
      }
      target.restore();
    }

    target.globalAlpha = 1;
    target.save();
    target.translate(g.x, g.y);
    if(!menuStatic) target.scale(ROUND_CHARACTER_SCALE, ROUND_CHARACTER_SCALE);

    const fd = g.faceDir || { x: 1, y: 0 };
    const dm = Math.hypot(fd.x, fd.y) || 1;
    const ux = fd.x / dm, uy = fd.y / dm;
    const px = -uy, py = ux;
    const rot = Math.atan2(uy, ux);

    // ── GUARD FEET & COMBAT BOOTS ──
    const gSpeed = isChasing ? 2.4 : 1.2;
    if(!menuStatic) { g.walkDist = (g.walkDist || 0) + gSpeed * 0.14; }
    const gStride = !menuStatic ? Math.sin(g.walkDist || 0) * 5.2 : 0;
    const gLeftLift = !menuStatic ? Math.max(0, -Math.cos(g.walkDist || 0) * 2.8) : 0;
    const gRightLift = !menuStatic ? Math.max(0, Math.cos(g.walkDist || 0) * 2.8) : 0;

    const leftBootX = -px * 5.0 + ux * gStride;
    const leftBootY = 17 - gLeftLift;
    const rightBootX = px * 5.0 - ux * gStride;
    const rightBootY = 17 - gRightLift;

    for(const [bx, by] of [[leftBootX, leftBootY], [rightBootX, rightBootY]]){
      target.save();
      target.translate(bx, by);
      target.rotate(rot);
      target.fillStyle = 'rgba(0,0,0,0.3)';
      target.fillRect(-3.5, -2.5, 8, 5.5);
      // Dark rubber sole
      target.fillStyle = '#0f172a';
      target.fillRect(-4.5, -2, 9.5, 2.5);
      // Police boot upper
      target.fillStyle = '#1e293b';
      target.beginPath();
      roundedRectPath(target, -4, -4, 8.5, 3.5, 1.5);
      target.fill();
      target.restore();
    }

    // Shadow under guard
    target.fillStyle = 'rgba(0,0,0,.34)';
    target.beginPath();
    target.ellipse(0, 18, 15, 5, 0, 0, Math.PI * 2);
    target.fill();

    // Guard body & uniform
    target.fillStyle = '#1c2d3d';
    target.beginPath();
    roundedRectPath(target, -13, -2, 26, 24, 6);
    target.fill();
    target.fillStyle = '#f1eee5';
    target.fillRect(-4, 3, 8, 11);
    target.fillStyle = '#33485a';
    target.fillRect(-18, 2, 6, 16);
    target.fillRect(12, 2, 6, 16);
    target.fillStyle = '#2b2b2b';
    target.fillRect(-13, 15, 26, 3);

    // Head and cap with directional looking (looks down when moving down, looks up when moving up)
    if(uy < -0.3){
      // ── LOOKING UP / AWAY (BACK OF GUARD'S HEAD & CAP) ──
      // Rear neck collar
      target.fillStyle = '#b88968';
      target.fillRect(-4, -4, 8, 4);
      // Full dark cap dome seen from behind
      target.fillStyle = '#182735';
      target.beginPath();
      target.arc(0, -11, 9.5, 0, Math.PI * 2);
      target.fill();
      // Rear cap adjustment band
      target.fillStyle = '#0f1722';
      target.fillRect(-6, -7, 12, 2.5);
    } else if(uy > 0.3){
      // ── LOOKING DOWN TOWARDS CAMERA / PLAYER ──
      // Cap upper dome
      target.fillStyle = '#182735';
      target.beginPath();
      target.arc(0, -13, 9.5, Math.PI, Math.PI * 2);
      target.fill();
      // Cap visor angled downward
      target.fillRect(-12, -9, 24, 3.5);
      // Face looking down
      target.fillStyle = '#c99d7c';
      target.beginPath();
      target.arc(0, -6, 8, 0, Math.PI * 2);
      target.fill();
      // Chin badge
      target.fillStyle = '#e5c45d';
      target.beginPath();
      target.arc(0, -1, 2.8, 0, Math.PI * 2);
      target.fill();

      // Eyes intently looking DOWN
      for(const side of [-1, 1]){
        const ex = side * 3.5;
        const ey = -4.5;
        target.fillStyle = '#f8f4e7';
        target.beginPath();
        roundedRectPath(target, ex - 2.2, ey - 1.5, 4.4, 3.2, 1);
        target.fill();
        // Pupil lowered at bottom of eye looking down
        target.fillStyle = '#111';
        target.beginPath();
        target.arc(ex, ey + 0.8, 1.3, 0, Math.PI * 2);
        target.fill();
        // Tactical brow angled over eyes
        target.strokeStyle = '#111';
        target.lineWidth = 1.5;
        target.beginPath();
        target.moveTo(ex - 2.5, ey - 2.2);
        target.lineTo(ex + 2.5, ey - 1.8);
        target.stroke();
      }
    } else {
      // ── SIDEWAYS / PROFILE VIEW (TRACKING HORIZONTALLY) ──
      const hx = ux * 2.0;
      target.fillStyle = '#c99d7c';
      target.beginPath();
      target.arc(hx, -9, 8.5, 0, Math.PI * 2);
      target.fill();
      target.fillStyle = '#182735';
      target.beginPath();
      target.arc(hx, -12, 10, Math.PI, Math.PI * 2);
      target.fill();
      target.fillRect(-12 + hx, -12, 24, 3);
      target.fillStyle = '#e5c45d';
      target.beginPath();
      target.arc(hx, -4, 2.8, 0, Math.PI * 2);
      target.fill();

      // Tracking eyes facing horizontal direction
      for(const side of [-1, 1]){
        const ex = hx + ux * 4.2 + px * 3.0 * side, ey = -9 + uy * 4.2 + py * 3.0 * side;
        target.fillStyle = '#f8f4e7';
        target.beginPath();
        target.moveTo(ex - px * 2.0, ey - py * 1.0);
        target.lineTo(ex + px * 2.0 + ux * 1.0, ey + py * 1.7 + uy * 1.0);
        target.lineTo(ex + px * 1.8, ey + py * 0.6);
        target.lineTo(ex - px * 1.7 + ux * 0.8, ey - py * 1.5 + uy * 0.8);
        target.closePath();
        target.fill();
        target.fillStyle = '#111';
        target.beginPath();
        target.arc(ex + ux * 0.5, ey + uy * 0.5, 1.3, 0, Math.PI * 2);
        target.fill();
        target.strokeStyle = '#111';
        target.lineWidth = 1.6;
        target.beginPath();
        target.moveTo(ex - px * 2.1 + ux * 0.8, ey - py * 1.8 + uy * 0.8);
        target.lineTo(ex + px * 2.1 - ux * 0.9, ey + py * 1.6 - uy * 0.9);
        target.stroke();
      }
    }

    target.shadowBlur = 0;
    target.strokeStyle = '#273d50';
    target.lineWidth = 1.5;
    target.beginPath();
    target.moveTo(8, -16);
    target.lineTo(11, -23);
    target.stroke();
    target.fillStyle = isChasing ? '#e63b43' : '#22c55e';
    target.beginPath();
    target.arc(11, -23, 1.6, 0, Math.PI * 2);
    target.fill();
    target.restore();
  }

  // In-round character scale is kept independent from the menu actor canvas. CSS transform animation then
  // runs on the compositor, so the menu no longer clears/redraws a large canvas every frame.
  let menuActorsReady=false, menuActorsResizeRaf=0;
  function renderMenuActorsOnce(){
    const thief=document.getElementById('menuThiefActor');
    const guard=document.getElementById('menuGuardActor');
    if(!thief||!guard)return;
    const dpr=Math.min(2.5,Math.max(1,window.devicePixelRatio||1));   // drawn once, so full sharpness is cheap
    const size=460;
    const scale=5.725;
    for(const [canvas,type] of [[thief,'thief'],[guard,'guard']]){
      canvas.width=Math.floor(size*dpr); canvas.height=Math.floor(size*dpr);
      canvas.style.width=size+'px'; canvas.style.height=size+'px';
      const c=canvas.getContext('2d'); c.setTransform(dpr,0,0,dpr,0,0);
      c.clearRect(0,0,size,size); c.save();
      // Render the exact same gameplay character functions, only scaled for the menu.
      c.translate(size/2,type==='thief'?size*.66:size*.64);
      c.scale(scale,scale);
      if(type==='thief'){
        // Thief faces LEFT (outward — left side of screen)
        const p={x:0,y:0,vx:0,vy:0,r:9,lastDir:{x:-1,y:-.04},wobble:0,currentPose:'left'};
        drawPlayerVisual(c,p,0,false,false,true);
      }else{
        // Guard faces RIGHT (outward — right side of screen)
        const g={x:0,y:0,vx:0,vy:0,radius:8,faceDir:{x:1,y:-.04},state:'PATROL',pulse:0};
        drawGuardVisual(c,g,true);
      }
      c.restore();
    }
    menuActorsReady=true;
  }
  function scheduleMenuActorsRender(){
    if(menuActorsResizeRaf)cancelAnimationFrame(menuActorsResizeRaf);
    menuActorsResizeRaf=requestAnimationFrame(()=>{menuActorsResizeRaf=0;renderMenuActorsOnce();});
  }
  window.addEventListener('resize',scheduleMenuActorsRender,{passive:true});

  function showMessage(text){
    const el=document.getElementById('messageHud');
    if(!el) return;
    el.textContent=text;
    el.classList.add('visible');
    clearTimeout(showMessage.t);
    showMessage.t=setTimeout(()=>{
      el.classList.remove('visible');
      setTimeout(()=>{
        if(!el.classList.contains('visible')) el.textContent='';
      }, 300);
    }, 2000);
  }

  // ====== AUDIO ENGINE V26: LIVE, CONTINUOUS BACKGROUND MUSIC ======
  // Music deliberately uses persistent oscillators rather than a large generated
  // AudioBuffer. SFX already prove that the browser's AudioContext works; keeping
  // the BGM on that same context removes file/autoplay/decoding dependencies.
  const music = {
    started:false, ready:false, mode:'ambient', target:'ambient', lastError:'', lastPlayState:'idle',
    finalGain:null, preGain:null, compressor:null, analyser:null, musicBus:null,
    ambientNodes:[], chaseNodes:[], masterLfo:null, masterLfoGain:null,
    ambientLevel:1, chaseLevel:0, signalRms:0, beatTimer:0
  };

  function setAudioStatusSafe(text){
    try { setMusicStatus(text); } catch(_) {
      const el=document.getElementById('audioStatus'); if(el) el.textContent=text;
    }
  }

  function createToneNode(ac, freq, type, level, bus, detune=0){
    const osc=ac.createOscillator();
    const gain=ac.createGain();
    osc.type=type;
    osc.frequency.value=freq;
    osc.detune.value=detune;
    gain.gain.value=level;
    osc.connect(gain).connect(bus);
    osc.start();
    return {osc,gain};
  }

  function ensureMusicGraph(){
    if(!audio||!audio.ac)return false;
    const ac=audio.ac;
    if(music.finalGain)return true;

    music.musicBus=ac.createGain();
    music.musicBus.gain.value=1;

    music.preGain=ac.createGain();
    // Strong internal level so the final BGM cap of 6.4% is intentionally quieter for gameplay.
    music.preGain.gain.value=3.0;

    music.compressor=ac.createDynamicsCompressor();
    music.compressor.threshold.value=-16;
    music.compressor.knee.value=10;
    music.compressor.ratio.value=6;
    music.compressor.attack.value=.004;
    music.compressor.release.value=.14;

    music.finalGain=ac.createGain();
    music.finalGain.gain.value=musicEnabled?GAMEPLAY_LOCAL_MUSIC_GAIN:0;

    music.analyser=ac.createAnalyser();
    music.analyser.fftSize=1024;
    music.analyser.smoothingTimeConstant=.65;

    music.musicBus.connect(music.preGain);
    music.preGain.connect(music.compressor);
    music.compressor.connect(music.finalGain);
    music.finalGain.connect(music.analyser);
    music.analyser.connect(ac.destination);

    // Slow global breathing modulation, kept deliberately subtle.
    music.masterLfo=ac.createOscillator();
    music.masterLfoGain=ac.createGain();
    music.masterLfo.frequency.value=.075;
    music.masterLfoGain.gain.value=.045;
    music.masterLfo.connect(music.masterLfoGain).connect(music.musicBus.gain);
    music.masterLfo.start();

    return true;
  }

  function buildLiveMusic(){
    if(!ensureMusicGraph()) return false;
    const ac=audio.ac;
    // Do not duplicate persistent sources.
    if(music.ambientNodes.length || music.chaseNodes.length) return true;

    // Ambient: audible mid-range harmony + low bed + soft fifths.
    const ambient=[
      [110,'sine',.20,0],
      [164.81,'triangle',.17,0],
      [220,'sine',.13,0],
      [329.63,'triangle',.085,4],
      [440,'sine',.055,-4]
    ];
    for(const [f,t,g,d] of ambient) music.ambientNodes.push(createToneNode(ac,f,t,g,music.musicBus,d));

    // Chase: brighter, more rhythmic harmonic stack.
    const chase=[
      [123.47,'sawtooth',.14,0],
      [184.99,'triangle',.16,0],
      [246.94,'square',.075,0],
      [369.99,'sawtooth',.065,5],
      [493.88,'triangle',.05,-5]
    ];
    for(const [f,t,g,d] of chase) music.chaseNodes.push(createToneNode(ac,f,t,g,music.musicBus,d));

    // Separate buses are represented by per-node gains so crossfade is explicit.
    // Ambient starts on; chase starts muted.
    for(const n of music.ambientNodes) n.gain.gain.value *= 1;
    for(const n of music.chaseNodes) n.gain.gain.value *= 0;

    music.started=true;
    music.ready=true;
    music.lastPlayState='playing';
    music.target='ambient';
    return true;
  }


  function applyMusicMix(ambient, chase){
    // Node base levels are restored through explicit target values.
    const ambientBase=[.20,.17,.13,.085,.055];
    const chaseBase=[.14,.16,.075,.065,.05];
    music.ambientNodes.forEach((n,i)=>n.gain.gain.setTargetAtTime(ambientBase[i]*ambient,audio.ac.currentTime,.05));
    music.chaseNodes.forEach((n,i)=>n.gain.gain.setTargetAtTime(chaseBase[i]*chase,audio.ac.currentTime,.05));
  }

  function sampleMusicMeter(){
    if(!music.analyser)return;
    try{
      const data=new Float32Array(music.analyser.fftSize);
      music.analyser.getFloatTimeDomainData(data);
      let sum=0; for(const v of data) sum+=v*v;
      music.signalRms=Math.sqrt(sum/data.length)||0;
    }catch(_){music.signalRms=0;}
  }

  function startNativeMusic(){
    if(!musicEnabled)return false;
    if(!ensureAudio()||!audio?.ac){
      music.lastError='NO_AUDIO_CONTEXT';
      setAudioStatusSafe('الموسيقى: تعذر فتح الصوت');
      return false;
    }
    const ac=audio.ac;
    try{
      if(ac.state!=='running') ac.resume().catch(()=>{});
      if(!buildLiveMusic()) throw new Error('MUSIC_GRAPH_FAILED');
      if(music.finalGain){
        music.finalGain.gain.cancelScheduledValues(ac.currentTime);
        music.finalGain.gain.setTargetAtTime(GAMEPLAY_LOCAL_MUSIC_GAIN,ac.currentTime,.08);
      }
      applyMusicMix(1,0);
      try{ setMainTitleGameplayVolume(world?.anyChase ? CHASE_MUSIC_VOLUME : GAMEPLAY_MUSIC_VOLUME); }catch(_){}
      if(music.finalGain){
        const initialGain=world?.anyChase ? CHASE_LOCAL_MUSIC_GAIN : GAMEPLAY_LOCAL_MUSIC_GAIN;
        music.finalGain.gain.setTargetAtTime(initialGain,ac.currentTime,.08);
      }
      music.lastChaseState=!!world?.anyChase;
      music.target=world?.anyChase?'chase':'ambient';
      music.lastPlayState='playing';
      setAudioStatusSafe('الصوت: موسيقى الخلفية تعمل');
      return true;
    }catch(err){
      music.lastError=String(err?.message||err);
      music.lastPlayState='error';
      setAudioStatusSafe('الموسيقى: خطأ في محرك الصوت');
      return false;
    }
  }

  function crossfadeMusic(dt){
    if(!music.started||!music.finalGain||!musicEnabled)return;
    const rate=Math.min(1,dt/.45);
    const wantA=music.target==='ambient'?1:0;
    const wantC=music.target==='chase'?1:0;
    music.ambientLevel += (wantA-music.ambientLevel)*rate;
    music.chaseLevel += (wantC-music.chaseLevel)*rate;
    applyMusicMix(music.ambientLevel,music.chaseLevel);
    if(audio?.ac?.state==='running')sampleMusicMeter();
  }

  function setMusicChase(chasing){
    const next=!!chasing;
    if(music.lastChaseState===next) return;
    music.lastChaseState=next;
    if(music.started&&musicEnabled) music.target=next?'chase':'ambient';

    // The chase transition is intentionally perceptible: +25% while active,
    // then a smooth return to the quieter baseline (-10% extra from the prior baseline).
    try{
      if(musicEnabled && gameState==='PLAYING') {
        fadeMainTitleIn(false, next ? CHASE_MUSIC_VOLUME : GAMEPLAY_MUSIC_VOLUME);
      }
    }catch(_){}

    if(music.finalGain&&audio?.ac&&musicEnabled){
      const now=audio.ac.currentTime;
      const target=next?CHASE_LOCAL_MUSIC_GAIN:GAMEPLAY_LOCAL_MUSIC_GAIN;
      music.finalGain.gain.cancelScheduledValues(now);
      music.finalGain.gain.setTargetAtTime(target,now,CHASE_MUSIC_SMOOTH);
    }
  }

  function stopLocalMusic(){
    for(const group of [music.ambientNodes,music.chaseNodes]) for(const n of group){try{n.osc.stop();}catch(_){} }
    try{music.masterLfo?.stop();}catch(_){}
    music.ambientNodes=[]; music.chaseNodes=[]; music.masterLfo=null; music.masterLfoGain=null;
    music.started=false; music.ready=false; music.lastPlayState='stopped';
    music.finalGain=null;music.preGain=null;music.compressor=null;music.analyser=null;music.musicBus=null;
  }

  function createAudio(){
    try{
      const C=window.AudioContext||window.webkitAudioContext;if(!C)return null;
      const ac=new C();
      const sfxBus=ac.createGain();
      const sfxComp=ac.createDynamicsCompressor();
      sfxComp.threshold.value=-8;sfxComp.knee.value=8;sfxComp.ratio.value=5;sfxComp.attack.value=.002;sfxComp.release.value=.10;
      sfxBus.gain.value=isMuted?0:1.18;
      sfxBus.connect(sfxComp).connect(ac.destination);
      return {ac,sfxBus,sfxComp};
    }catch(err){console.warn('Audio setup failed',err);return null;}
  }

  let mainTitleStartPositionApplied=false;
  const MAIN_TITLE_START=2;
  const MAIN_MENU_VOLUME=0.28;
  const GAMEPLAY_MUSIC_VOLUME=0.124416 * 1.10; // 10% louder during gameplay
  const GAMEPLAY_LOCAL_MUSIC_GAIN=0.041472; // additional -10% quieter gameplay live-music baseline
  const CHASE_MUSIC_MULTIPLIER=1.25;
  const CHASE_MUSIC_VOLUME=GAMEPLAY_MUSIC_VOLUME*CHASE_MUSIC_MULTIPLIER;
  const CHASE_LOCAL_MUSIC_GAIN=GAMEPLAY_LOCAL_MUSIC_GAIN*CHASE_MUSIC_MULTIPLIER;
  const CHASE_MUSIC_SMOOTH=0.55;

  function seekMainTitleToStart(){
    const mm=mainTitleMusic;
    if(!mm || mainTitleStartPositionApplied) return;
    try{
      if(Number.isFinite(mm.duration) && mm.duration>MAIN_TITLE_START){
        mm.currentTime=Math.min(MAIN_TITLE_START, Math.max(0, mm.duration-0.05));
        mainTitleStartPositionApplied=true;
      }
    }catch(_){}
  }

  function ensureMainTitleMusic(){
    try{
      if(!mainTitleMusic){
        mainTitleMusic=document.getElementById('mainTitleAudio') || new Audio('assets/main-title.mp3');
        mainTitleMusic.preload='auto';
        mainTitleMusic.loop=false;
        mainTitleMusic.setAttribute('playsinline','');
        mainTitleMusic.autoplay=false;
        mainTitleMusic.volume=MAIN_MENU_VOLUME;
        if(!mainTitleMusic.src) mainTitleMusic.src='assets/main-title.mp3';
        mainTitleMusic.addEventListener('loadedmetadata',()=>seekMainTitleToStart(),{once:true});
        mainTitleMusic.addEventListener('ended',()=>{
          if(!musicEnabled) return;
          try{
            mainTitleStartPositionApplied=false;
            mainTitleMusic.currentTime=MAIN_TITLE_START;
            mainTitleMusic.play().catch(()=>{});
          }catch(_){}
        });
        mainTitleMusic.addEventListener('error',()=>{ setAudioStatusSafe('موسيقى الواجهة: تعذر تحميل الملف'); },{once:false});
      }
      mainTitleMusic.muted=!musicEnabled;
      seekMainTitleToStart();
      return mainTitleMusic;
    }catch(_){return null;}
  }

  function fadeMainTitleIn(restart=false, targetVolume=MAIN_MENU_VOLUME){
    const mm=ensureMainTitleMusic();
    if(!mm||!musicEnabled)return false;
    try{
      if(mainTitleFadeTimer)clearInterval(mainTitleFadeTimer);
      mm.muted=false;
      if(restart){
        mainTitleStartPositionApplied=false;
        try{mm.currentTime=MAIN_TITLE_START;}catch(_){}
      } else {
        seekMainTitleToStart();
      }
      if(mm.paused){
        const p=mm.play();
        if(p&&typeof p.then==='function')p.then(()=>setAudioStatusSafe('الصوت: موسيقى الواجهة تعمل')).catch(err=>{
          titleMusicGestureUnlocked=false;
          const msg=err&&err.name==='NotAllowedError' ? 'الصوت: سيبدأ تلقائيًا عند أول تفاعل مع اللعبة' : 'الموسيقى: تعذر تشغيل الملف';
          setAudioStatusSafe(msg);
        });
      }
      const from=Number.isFinite(mm.volume)?mm.volume:MAIN_MENU_VOLUME;
      const target=Math.max(0,Math.min(1,targetVolume));
      if(Math.abs(from-target)<0.002){mm.volume=target;return true;}
      const start=performance.now();
      mainTitleFadeTimer=setInterval(()=>{
        if(!mm){clearInterval(mainTitleFadeTimer);mainTitleFadeTimer=0;return;}
        const q=Math.min(1,(performance.now()-start)/450),s=q*q*(3-2*q);
        mm.volume=from+(target-from)*s;
        if(q>=1){clearInterval(mainTitleFadeTimer);mainTitleFadeTimer=0;}
      },25);
      return true;
    }catch(_){return false;}
  }

  function setMainTitleGameplayVolume(){
    const mm=ensureMainTitleMusic();
    if(!mm||!musicEnabled)return false;
    try{
      if(mm.paused){
        seekMainTitleToStart();
        const p=mm.play();
        if(p&&typeof p.catch==='function')p.catch(()=>{});
      }
      mm.volume=GAMEPLAY_MUSIC_VOLUME;
      return true;
    }catch(_){return false;}
  }

  function fadeMainTitleOut(){
    const mm=mainTitleMusic;
    if(!mm)return;
    try{
      if(mainTitleFadeTimer)clearInterval(mainTitleFadeTimer);
      const from=mm.volume, start=performance.now(), duration=700;
      mainTitleFadeTimer=setInterval(()=>{
        const q=Math.min(1,(performance.now()-start)/duration);
        mm.volume=from*(1-q*q*(3-2*q));
        if(q>=1){clearInterval(mainTitleFadeTimer);mainTitleFadeTimer=0;mm.pause();mm.currentTime=0;mm.volume=0;}
      },25);
    }catch(_){try{mm.pause();mm.currentTime=0;mm.volume=0;}catch(__){}}
  }

  function ensureVaultAudio(){
    try{
      if(!vaultAudio){
        vaultAudio=new Audio('assets/vault-open.mp3');
        vaultAudio.preload='auto';
        vaultAudio.volume=.92;
      }
      vaultAudio.muted=isMuted;
      return vaultAudio;
    }catch(_){return null;}
  }

  function ensureEscapeAudio(){
    try{
      if(!escapeAudio){
        escapeAudio=new Audio('assets/escape-run.mp3');
        escapeAudio.preload='auto';
        escapeAudio.volume=.95;
      }
      escapeAudio.muted=isMuted;
      return escapeAudio;
    }catch(_){return null;}
  }

  function stopResultMusicNow(){
    sirenStop(true);
    try{
      if(resultMusicFadeTimer)clearInterval(resultMusicFadeTimer);
      resultMusicFadeTimer=0;
      if(resultMusic){resultMusic.pause();resultMusic.currentTime=0;resultMusic.volume=0;}
      if(gameOverMusic){gameOverMusic.pause();gameOverMusic.currentTime=0;gameOverMusic.volume=0;}
    }catch(_){}
  }

  // ---- Failure-screen audio sequence ----
  // t=0   failure screen appears (silence)
  // t=1s  "you lose" (assets/you-lose.mp3) AND the losing horn (assets/losing-horn.mp3) start TOGETHER (mix)
  // when the mix finishes, the horn alone is played once more
  const LOSE_SFX_DELAY_MS=1000;    // delay before the mix starts
  const LOSE_SFX_VOLUME=0.8;       // "you lose" level (0..1)
  const LOSE_HORN_VOLUME=0.6;      // horn level while mixed with "you lose" (0..1)
  const LOSE_HORN_SOLO_VOLUME=0.7; // horn level when it is replayed alone (0..1)
  const LOSE_HORN_REPLAYS=1;       // how many times the horn is replayed alone after the mix
  let loseSfxEl=null, loseHornEl=null, loseTimers=[], sirenFadeTimer=0, loseHornPlays=0;
  function loseClearTimers(){ loseTimers.forEach(t=>clearTimeout(t)); loseTimers=[]; }
  function loseKill(el){ if(!el)return; try{el.pause();el.currentTime=0;}catch(_){} }
  function loseActive(){ return isGameOver && gameState==='FAILURE' && musicEnabled && !isMuted; }
  function sirenStop(fast){
    loseClearTimers();
    loseHornPlays=LOSE_HORN_REPLAYS;   // block any pending replay
    loseWaStopAll(!!fast);
    if(sirenFadeTimer){clearInterval(sirenFadeTimer);sirenFadeTimer=0;}
    const els=[loseSfxEl,loseHornEl].filter(el=>el&&!el.paused);
    if(!els.length)return;
    if(fast){ els.forEach(loseKill); return; }
    const v0=els.map(el=>el.volume), t0=performance.now();
    sirenFadeTimer=setInterval(()=>{
      const p=Math.min(1,(performance.now()-t0)/500);
      els.forEach((el,i)=>{ try{ el.volume=Math.max(0,v0[i]*(1-p)); }catch(_){} });
      if(p>=1){ clearInterval(sirenFadeTimer);sirenFadeTimer=0; els.forEach(loseKill); }
    },30);
  }
  function losePlay(el){
    const pr=el.play();
    if(pr&&typeof pr.catch==='function') pr.catch(err=>console.warn('lose audio failed',err));
  }
  function loseEnsure(){
    if(!loseSfxEl){ loseSfxEl=new Audio('assets/you-lose.mp3'); loseSfxEl.preload='auto'; loseSfxEl.loop=false; }
    if(!loseHornEl){ loseHornEl=new Audio('assets/losing-horn.mp3'); loseHornEl.preload='auto'; loseHornEl.loop=false; }
  }
  // Web Audio path: pre-decoded buffers = both sounds start on the exact same sample, no HTMLAudio latency.
  // Falls back to the HTMLAudio elements above when the buffers are not decoded yet.
  var loseSfxBuf=null, loseHornBuf=null;
  let loseWaNodes=[];
  function loseWaReady(){ return !!(audio && audio.ac && audio.ac.state==='running' && loseSfxBuf && loseHornBuf); }
  function loseWaPlay(buf,vol,offset,onEnd){
    const ac=audio.ac, src=ac.createBufferSource(), gn=ac.createGain();
    src.buffer=buf; gn.gain.value=vol;
    src.connect(gn).connect(audio.sfxBus||ac.destination);
    const node={src,gn,dead:false};
    src.onended=()=>{ node.dead=true; try{src.disconnect();gn.disconnect();}catch(_){} if(onEnd) onEnd(); };
    loseWaNodes.push(node);
    return {node,start:(when)=>src.start(when,offset||0)};
  }
  function loseWaStopAll(fast){
    const nodes=loseWaNodes; loseWaNodes=[];
    nodes.forEach(n=>{ if(n.dead) return; n.src.onended=null;
      try{
        if(fast||!audio||!audio.ac){ n.src.stop(); }
        else{ const t=audio.ac.currentTime; n.gn.gain.setValueAtTime(n.gn.gain.value,t); n.gn.gain.linearRampToValueAtTime(0,t+.5); n.src.stop(t+.52); }
      }catch(_){} });
  }
  let loseSfxDone=false, loseHornDone=false;
  function loseMaybeReplayHorn(){
    // runs when the mix has fully finished (both files ended) -> horn alone again
    if(!(loseSfxDone && loseHornDone)) return;
    if(!loseActive() || loseHornPlays>=LOSE_HORN_REPLAYS) return;
    loseHornPlays++;
    if(loseWaReady()){
      try{ const h=loseWaPlay(loseHornBuf,LOSE_HORN_SOLO_VOLUME,0.3,null); h.start(audio.ac.currentTime+0.01); return; }catch(err){ console.warn('horn replay (WA) failed',err); }
    }
    try{
      loseHornEl.muted=isMuted; loseHornEl.volume=LOSE_HORN_SOLO_VOLUME;
      try{ loseHornEl.currentTime=0; }catch(_){}
      loseHornDone=false;   // the replay ends the same way; loseHornPlays stops it from looping forever
      losePlay(loseHornEl);
    }catch(err){ console.warn('horn replay failed',err); }
  }
  function loseStartMix(){
    if(!loseActive()) return;
    if(loseWaReady()){
      try{
        loseSfxDone=false; loseHornDone=false; loseHornPlays=0;
        const a=loseWaPlay(loseSfxBuf,LOSE_SFX_VOLUME,0,()=>{ loseSfxDone=true; loseMaybeReplayHorn(); });
        const b=loseWaPlay(loseHornBuf,LOSE_HORN_VOLUME,0,()=>{ loseHornDone=true; loseMaybeReplayHorn(); });
        const t0=audio.ac.currentTime+0.02;     // same start time for both -> perfectly in sync
        a.start(t0); b.start(t0);
        return;
      }catch(err){ console.warn('lose mix (WA) failed, using HTMLAudio',err); loseWaStopAll(true); }
    }
    try{
      loseEnsure();
      loseSfxDone=false; loseHornDone=false; loseHornPlays=0;
      loseSfxEl.onended=()=>{ loseSfxDone=true; loseMaybeReplayHorn(); };
      loseHornEl.onended=()=>{ loseHornDone=true; loseMaybeReplayHorn(); };
      loseSfxEl.muted=isMuted; loseSfxEl.volume=LOSE_SFX_VOLUME;
      loseHornEl.muted=isMuted; loseHornEl.volume=LOSE_HORN_VOLUME;
      try{ loseSfxEl.currentTime=0; loseHornEl.currentTime=0; }catch(_){}
      // start both in the same tick so they stay in sync
      losePlay(loseSfxEl); losePlay(loseHornEl);
    }catch(err){ console.warn('lose mix failed',err); }
  }
  function sirenStart(){
    if(!musicEnabled||isMuted)return;
    sirenStop(true);
    loseHornPlays=0; loseSfxDone=false; loseHornDone=false;
    try{ loseEnsure(); }catch(_){}       // warm the files so the mix starts on time
    loseTimers.push(setTimeout(loseStartMix,LOSE_SFX_DELAY_MS));
  }


  function fadeGameOverMusicIn(){
    // the sequence timers (1s "you lose" -> 4s horn) are counted from the moment the failure screen appears
    if(isGameOver && gameState==='FAILURE') sirenStart();
  }

  function ensureResultMusic(){
    try{
      if(!resultMusic){
        resultMusic=new Audio('assets/win-rock.mp3');
        resultMusic.preload='auto';
        resultMusic.loop=false;
        resultMusic.volume=0;
      }
      resultMusic.muted=isMuted;
      return resultMusic;
    }catch(_){return null;}
  }

  function fadeResultMusicIn(){
    const rm=ensureResultMusic();
    if(!rm||!musicEnabled)return;
    try{
      if(resultMusicFadeTimer)clearInterval(resultMusicFadeTimer);
      rm.muted=false;
      rm.volume=0;
      // The victory audio file itself has been trimmed by 1.5 seconds.
      try{ rm.currentTime=0; }catch(_){}
      void rm.play();
      const target=.24;
      const start=performance.now();
      resultMusicFadeTimer=setInterval(()=>{
        if(!rm||rm.paused){clearInterval(resultMusicFadeTimer);resultMusicFadeTimer=0;return;}
        const p=Math.min(1,(performance.now()-start)/900);
        const s=p*p*(3-2*p);
        rm.volume=target*s;
        if(p>=1){clearInterval(resultMusicFadeTimer);resultMusicFadeTimer=0;}
      },30);
    }catch(_){}
  }

  function fadeResultMusicOut(done){
    sirenStop(false);
    const tracks=[resultMusic,gameOverMusic].filter(Boolean);
    if(!tracks.length){ if(typeof done==='function')done(); return; }
    try{
      if(resultMusicFadeTimer)clearInterval(resultMusicFadeTimer);
      resultMusicFadeTimer=0;
      const startVols=tracks.map(t=>Math.max(0,t.volume));
      if(startVols.every(v=>v<=.001)){
        tracks.forEach(t=>{try{t.pause();t.currentTime=0;t.volume=0;}catch(_){} });
        if(typeof done==='function')done();
        return;
      }
      const start=performance.now();
      resultMusicFadeTimer=setInterval(()=>{
        const p=Math.min(1,(performance.now()-start)/850);
        const s=p*p*(3-2*p);
        tracks.forEach((t,i)=>{try{t.volume=startVols[i]*(1-s);}catch(_){}});
        if(p>=1){
          clearInterval(resultMusicFadeTimer); resultMusicFadeTimer=0;
          tracks.forEach(t=>{try{t.pause();t.currentTime=0;t.volume=0;}catch(_){}});
          if(typeof done==='function')done();
        }
      },30);
    }catch(_){
      tracks.forEach(t=>{try{t.pause();t.currentTime=0;t.volume=0;}catch(_){}});
      if(typeof done==='function')done();
    }
  }

  function setGameplayMusicAfterResult(){
    try{
      if(audio?.ac?.state==='running' && music.finalGain){
        music.finalGain.gain.cancelScheduledValues(audio.ac.currentTime);
        music.finalGain.gain.setTargetAtTime(musicEnabled ? GAMEPLAY_LOCAL_MUSIC_GAIN : 0,audio.ac.currentTime,.08);
      }
      music.lastChaseState=false;
      if(musicEnabled && gameState==='PLAYING') setMainTitleGameplayVolume(GAMEPLAY_MUSIC_VOLUME);
    }catch(_){}
  }

  let vaultBuffer = null, escapeBuffer = null;   // (loseSfxBuf / loseHornBuf are declared with the failure audio block)
  function preloadAudioBuffers(){
    if(!audio || !audio.ac) return;
    try{
      // fetch() cannot read file:// assets inside an Android WebView, which silently
      // forced these two effects onto the slow HTMLAudio fallback (late playback).
      // XMLHttpRequest can, so the buffers really get pre-decoded.
      const loadBuf=(url,done)=>{
        try{
          const x=new XMLHttpRequest(); x.open('GET',url,true); x.responseType='arraybuffer';
          x.onload=()=>{ const buf=x.response; if(!buf||!buf.byteLength) return;
            try{ audio.ac.decodeAudioData(buf).then(done).catch(()=>{}); }catch(_){} };
          x.onerror=()=>{};
          x.send();
        }catch(_){}
      };
      loadBuf('assets/vault-open.mp3',b=>{ vaultBuffer=b; });
      loadBuf('assets/escape-run.mp3',b=>{ escapeBuffer=b; });
      loadBuf('assets/you-lose.mp3',b=>{ loseSfxBuf=b; });
      loadBuf('assets/losing-horn.mp3',b=>{ loseHornBuf=b; });
    }catch(_){}
  }

  let vanBeaconAudioNode = null;
  let vanBeaconGainNode = null;
  function updateVanBeaconSound(){
    if(!audio || !audio.ac || audio.ac.state !== 'running') return;
    const ac = audio.ac;
    const shouldPlay = (gameState === 'MENU' && musicEnabled && !isMuted);
    if(shouldPlay){
      if(!vanBeaconAudioNode){
        try{
          const osc1 = ac.createOscillator();
          const osc2 = ac.createOscillator();
          const filter = ac.createBiquadFilter();
          const gain = ac.createGain();
          osc1.type = 'sine';
          osc2.type = 'sine';
          const t = ac.currentTime;
          const lfo = ac.createOscillator();
          const lfoGain = ac.createGain();
          lfo.frequency.value = 1 / 3.6; // exact 3.6s smooth cycle
          lfoGain.gain.value = 55;
          lfo.connect(lfoGain);
          lfoGain.connect(osc1.frequency);
          lfoGain.connect(osc2.frequency);
          osc1.frequency.setValueAtTime(440, t);
          osc2.frequency.setValueAtTime(443, t);
          filter.type = 'lowpass';
          filter.frequency.value = 800;
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.linearRampToValueAtTime(0.038, t + 1.2); // Low-volume gentle ambient sound as requested
          osc1.connect(filter);
          osc2.connect(filter);
          filter.connect(gain);
          gain.connect(audio.sfxBus);
          osc1.start(t);
          osc2.start(t);
          lfo.start(t);
          vanBeaconAudioNode = { osc1, osc2, lfo, gain, filter };
          vanBeaconGainNode = gain;
        }catch(_){}
      }
    } else {
      if(vanBeaconAudioNode){
        try{
          const t = ac.currentTime;
          if(vanBeaconGainNode) vanBeaconGainNode.gain.linearRampToValueAtTime(0.0001, t + 0.25);
          const nodeToStop = vanBeaconAudioNode;
          setTimeout(()=>{
            try{
              nodeToStop.osc1.stop();
              nodeToStop.osc2.stop();
              nodeToStop.lfo.stop();
              nodeToStop.osc1.disconnect();
              nodeToStop.osc2.disconnect();
              nodeToStop.filter.disconnect();
              nodeToStop.gain.disconnect();
            }catch(_){}
          }, 300);
        }catch(_){}
        vanBeaconAudioNode = null;
        vanBeaconGainNode = null;
      }
    }
  }

  function ensureAudio(){
    try{
      if(!audio){
        audio=createAudio();
        preloadAudioBuffers();
      }
      if(audio&&audio.ac.state!=='running')audio.ac.resume().catch(()=>{});
      return !!audio;
    }catch(_){return false;}
  }

  function updateAudio(dt){try{
    if(world)setMusicChase(!!world.anyChase);
    if(music.started)crossfadeMusic(dt);
    updateVanBeaconSound();
    if(audio&&world?.guards?.length&&world.player){const near=Math.min(...world.guards.map(g=>dist(g,world.player)));if(near<250)playHeartbeat(near);}
  }catch(_){} }

  let heartbeatTimer=0;
  // V27 audio merge: V26 keeps the working ambient/chase BGM and footsteps; V19 supplies the other SFX.
  function playHeartbeat(near){if(!audio||isMuted)return;heartbeatTimer-=1/60;if(heartbeatTimer>0)return;heartbeatTimer=Math.max(.12,near/650);beep(92,.07,.12);setTimeout(()=>beep(118,.065,.09),75)}
  function beep(freq,dur,gain){if(!audio||audio.ac.state!=='running'||isMuted)return;try{const o=audio.ac.createOscillator(),g=audio.ac.createGain();o.frequency.value=freq;o.type='sine';g.gain.value=gain;o.connect(g).connect(audio.sfxBus);o.start();g.gain.exponentialRampToValueAtTime(.0001,audio.ac.currentTime+dur);o.stop(audio.ac.currentTime+dur+.02);}catch(_){}}
  function playSfx(kind){
    if(!ensureAudio()||isMuted)return;
    if(audio.ac.state!=='running'){
      audio.ac.resume().then(()=>playSfx(kind)).catch(()=>{});
      return;
    }
    try{
      const ac=audio.ac, t=ac.currentTime, bus=audio.sfxBus;
      const tone=(freq,dur,gain,type='sine',when=0,slideTo=null)=>{
        const o=ac.createOscillator(),gn=ac.createGain();o.type=type;o.frequency.setValueAtTime(freq,t+when);
        if(slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20,slideTo),t+when+dur);
        gn.gain.setValueAtTime(Math.max(.0001,gain),t+when);gn.gain.exponentialRampToValueAtTime(.0001,t+when+dur);
        o.connect(gn).connect(bus);o.start(t+when);o.stop(t+when+dur+.025);
      };
      if(kind==='key'){
        // Bright instantaneous reward chime: rising two-note arpeggio.
        tone(784,.16,.18,'sine',0,988);
        tone(1174,.23,.14,'triangle',.05,1568);
        return;
      }
      if(kind==='vault'){
        // Instant pre-decoded PCM audio buffer execution with 0ms latency
        if(vaultBuffer){
          try{
            const src=ac.createBufferSource();
            src.buffer=vaultBuffer;
            const gn=ac.createGain();
            gn.gain.value=0.95;
            src.connect(gn).connect(bus);
            src.start(t);
            return;
          }catch(_){}
        }
        const va=ensureVaultAudio();
        if(va && !isMuted){
          try{ va.currentTime=0; va.muted=false; void va.play(); return; }catch(_){}
        }
        // Safe synthesized fallback
        tone(58,.28,.20,'triangle',0,42);
        tone(118,.06,.12,'square',.22,92);
        tone(92,.06,.12,'square',.31,74);
        tone(70,.10,.11,'triangle',.42,52);
        tone(52,.18,.16,'sawtooth',.56,38);
        return;
      }
      if(kind==='escape'){
        if(escapeBuffer){
          try{
            const src=ac.createBufferSource();
            src.buffer=escapeBuffer;
            const gn=ac.createGain();
            gn.gain.value=0.95;
            src.connect(gn).connect(bus);
            src.start(t);
            return;
          }catch(_){}
        }
        const ea=ensureEscapeAudio();
        if(ea && !isMuted){
          try{ea.currentTime=0;ea.muted=false;void ea.play();return;}catch(_){}
        }
        tone(196,.12,.12,'sine',0,260);
        tone(392,.20,.10,'triangle',.08,523);
        return;
      }
      if(kind==='button'){
        tone(310,.055,.145,'square',0,260);
        tone(620,.045,.090,'triangle',.015,540);
        return;
      }
      const map={glass:[180,.15,.24,'triangle'],success:[740,.22,.16,'triangle'],alarm:[520,.16,.16,'square'],lockdown:[32,.42,.32,'sawtooth'],step:[66,.10,.22,'sine']};
      const [f,d,g,typ]=map[kind]||[160,.08,.08,'sine'];
      tone(f,d,g,typ,0);
    }catch(_){}
  }

  function playAlarmSiren(){
    playSfx('alarm');
    setTimeout(()=>playSfx('alarm'),180);
    setTimeout(()=>playSfx('alarm'),360);
  }

  let resultRainRaf=0;
  let resultRainResizeHandler=null;
  function stopResultRain(){
    if(resultRainRaf) cancelAnimationFrame(resultRainRaf);
    resultRainRaf=0;
    if(resultRainResizeHandler && typeof window.removeEventListener==='function'){
      window.removeEventListener('resize',resultRainResizeHandler);
    }
    resultRainResizeHandler=null;
    for(const id of ['successRainCanvas','failureRainCanvas']){
      const c=document.getElementById(id); if(c){const x=c.getContext('2d');x.clearRect(0,0,c.width,c.height);}
    }
  }

  function startResultRain(mode){
    stopResultRain();
    const canvasEl=document.getElementById(mode==='money'?'successRainCanvas':'failureRainCanvas');
    if(!canvasEl)return;
    const host=canvasEl.parentElement;
    const dpr=Math.min(2,window.devicePixelRatio||1);
    const resize=()=>{
      const width=Math.max(1,host.clientWidth||window.innerWidth);
      const height=Math.max(1,host.clientHeight||window.innerHeight);
      canvasEl.width=Math.floor(width*dpr);
      canvasEl.height=Math.floor(height*dpr);
    };
    resize();
    const ctx=canvasEl.getContext('2d');
    const count=mode==='money'?34:26;
    let items=null;
    const makeItems=(w,h)=>Array.from({length:count},(_,i)=>({
      x:Math.random()*w,
      // about 60% already inside the top of the screen so the effect is visible on the very first frame
      y:i%5<3 ? Math.random()*h*0.5-30 : -30-Math.random()*h*0.35,
      vy:(mode==='money'?465:150)+Math.random()*(mode==='money'?530:190),   // money fall speed x1.6
      vx:(Math.random()-.5)*25,
      rot:Math.random()*Math.PI*2,
      vr:(Math.random()-.5)*2.8,
      s:.7+Math.random()*.75,
      seed:i
    }));
    // Money pieces are drawn once into small offscreen sprites; each frame only blits them (much smoother than re-building gradients per frame).
    const makeMoneySprite=(it)=>{
      const k=it.seed%3;
      let half;
      if(k===0){ half=13*it.s*(it.seed%7===0?1.9:1)+3; }
      else { half=36*it.s*(it.seed%5===0?1.7:1)/2+4; }
      half=Math.ceil(half);
      const sp=document.createElement('canvas');
      sp.width=sp.height=Math.ceil(half*2*dpr);
      const sc=sp.getContext('2d');
      sc.setTransform(dpr,0,0,dpr,half*dpr,half*dpr);
      if(k===0){
        const r=13*it.s*(it.seed%7===0?1.9:1);
        const g=sc.createRadialGradient(-r*.3,-r*.3,r*.1,0,0,r);
        g.addColorStop(0,'#fff0a0');g.addColorStop(.6,'#ffc828');g.addColorStop(1,'#c98100');
        sc.fillStyle=g;sc.strokeStyle='#8a5700';sc.lineWidth=Math.max(1,r*.12);
        sc.beginPath();sc.arc(0,0,r,0,Math.PI*2);sc.fill();sc.stroke();
        sc.strokeStyle='rgba(120,70,0,.45)';sc.lineWidth=Math.max(1,r*.09);sc.beginPath();sc.arc(0,0,r*.72,0,Math.PI*2);sc.stroke();
        sc.fillStyle='#7a4607';sc.font='bold '+(r*1.05)+'px sans-serif';sc.textAlign='center';sc.textBaseline='middle';sc.fillText('$',0,r*.06);
      }else{
        const ww=36*it.s*(it.seed%5===0?1.7:1),hh=ww*.56;
        const g=sc.createLinearGradient(-ww/2,-hh/2,ww/2,hh/2);
        g.addColorStop(0,'#58c26a');g.addColorStop(1,'#2a8a43');
        sc.fillStyle=g;sc.strokeStyle='#17592a';sc.lineWidth=Math.max(1,ww*.045);
        sc.beginPath();roundedRectPath(sc,-ww/2,-hh/2,ww,hh,ww*.08);sc.fill();sc.stroke();
        sc.strokeStyle='rgba(230,255,230,.55)';sc.lineWidth=Math.max(1,ww*.03);
        sc.beginPath();roundedRectPath(sc,-ww*.42,-hh*.36,ww*.84,hh*.72,ww*.05);sc.stroke();
        sc.fillStyle='rgba(235,255,235,.85)';sc.beginPath();sc.arc(0,0,hh*.26,0,Math.PI*2);sc.fill();
        sc.fillStyle='#1d6a33';sc.font='bold '+(hh*.42)+'px sans-serif';sc.textAlign='center';sc.textBaseline='middle';sc.fillText('$',0,hh*.03);
      }
      it.sprite=sp;it.half=half;
    };
    let start=performance.now();
    function frame(now){
      if(!canvasEl.isConnected || (mode==='money' ? gameState!=='SUCCESS' : gameState!=='FAILURE')){
        resultRainRaf=0;
        return;
      }
      const w=Math.max(1,host.clientWidth||window.innerWidth),h=Math.max(1,host.clientHeight||window.innerHeight);
      if(!items){ resize(); items=makeItems(w,h); if(mode==='money') items.forEach(makeMoneySprite); }
      const dt=Math.min(.04,(now-start)/1000); start=now;
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
      for(const it of items){
        it.y+=it.vy*dt;it.x+=it.vx*dt;it.rot+=it.vr*dt;
        if(it.y>h+60){it.y=-40-Math.random()*140;it.x=Math.random()*w;}
        const alpha=Math.min(1,Math.max(0,(it.y+80)/120));
        if(mode==='money'){
          const cs=Math.cos(it.rot)*dpr,sn=Math.sin(it.rot)*dpr;
          ctx.setTransform(cs,sn,-sn,cs,it.x*dpr,it.y*dpr);
          ctx.globalAlpha=alpha;
          ctx.drawImage(it.sprite,-it.half,-it.half,it.half*2,it.half*2);
          continue;
        }
        ctx.save();ctx.translate(it.x,it.y);ctx.rotate(it.rot);ctx.globalAlpha=alpha;
        {
          // Wide, unmistakable handcuffs with two separated cuffs and a hollow braided-wire bridge.
          const s=1.54*it.s, rx=14.8*s, ry=11.5*s, gap=35*s;
          const metal='#c9d2d7', dark='#66717a', hi='#f1f5f6';
          ctx.lineCap='round';
          // Cuff bodies: thick outer ring + bright inner ring makes the opening obvious.
          ctx.strokeStyle=dark;ctx.lineWidth=7*s;
          ctx.beginPath();ctx.ellipse(-gap/2,0,rx,ry,0,0,Math.PI*2);ctx.stroke();
          ctx.beginPath();ctx.ellipse(gap/2,0,rx,ry,0,0,Math.PI*2);ctx.stroke();
          ctx.strokeStyle=metal;ctx.lineWidth=4.7*s;
          ctx.beginPath();ctx.ellipse(-gap/2,0,rx,ry,0,0,Math.PI*2);ctx.stroke();
          ctx.beginPath();ctx.ellipse(gap/2,0,rx,ry,0,0,Math.PI*2);ctx.stroke();
          ctx.strokeStyle=hi;ctx.lineWidth=2*s;
          ctx.beginPath();ctx.ellipse(-gap/2-1*s,-1*s,rx-2.5*s,ry-2.5*s,-.08,3.25,5.7);ctx.stroke();
          ctx.beginPath();ctx.ellipse(gap/2-1*s,-1*s,rx-2.5*s,ry-2.5*s,.08,3.65,6.1);ctx.stroke();

          // Ratchet/hinge blocks on the inner sides.
          ctx.fillStyle=metal;
          ctx.beginPath();roundedRectPath(ctx,-gap/2+rx-2*s,-5.5*s,11*s,11*s,2.5*s);ctx.fill();
          ctx.beginPath();roundedRectPath(ctx,gap/2-rx-9*s,-5.5*s,11*s,11*s,2.5*s);ctx.fill();
          ctx.fillStyle=hi;
          ctx.fillRect(-gap/2+rx+1*s,-3*s,4*s,2*s);
          ctx.fillRect(gap/2-rx-7*s,-3*s,4*s,2*s);

          // Hollow braided wire: three interlaced strands, intentionally spaced so the open air
          // inside the braid remains visible instead of looking like one solid metal bar.
          const left= -gap/2+rx+7*s, right=gap/2-rx-7*s, span=right-left;
          ctx.lineWidth=2.8*s;
          const braidY=[-3.8,0,3.8];
          braidY.forEach((off,j)=>{
            ctx.strokeStyle=j===1?metal:dark;
            ctx.beginPath();
            ctx.moveTo(left,off*s);
            for(let k=0;k<=10;k++) {
              const x=left+span*(k/10), y=off*s + Math.sin((k/10)*Math.PI*2 + j*Math.PI*2/3)*3.2*s;
              if(k===0)ctx.moveTo(x,y); else ctx.lineTo(x,y);
            }
            ctx.stroke();
          });
          // Small highlights on alternating braid crossings emphasize a hollow woven cable.
          ctx.fillStyle=hi;
          for(let k=1;k<10;k+=2){
            const x=left+span*(k/10), y=Math.sin((k/10)*Math.PI*2)*2.6*s;
            ctx.beginPath();ctx.arc(x,y,1.25*s,0,Math.PI*2);ctx.fill();
          }
        }
        ctx.restore();
      }
      ctx.globalAlpha=1;
      resultRainRaf=requestAnimationFrame(frame);
    }
    resultRainResizeHandler=resize;
    window.addEventListener('resize',resultRainResizeHandler,{passive:true});
    // Draw the first frame synchronously so the effect is present immediately after transition.
    frame(performance.now());
    if(!resultRainRaf) resultRainRaf=requestAnimationFrame(frame);
  }

  // Keyboard
  window.addEventListener('keydown',e=>{const k=e.key.toLowerCase();if(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(k)){e.preventDefault();input.keys.add(k)}if(k==='escape'&&gameState==='MENU')document.getElementById('howPanel').classList.add('hidden')});
  window.addEventListener('keyup',e=>input.keys.delete(e.key.toLowerCase()));

  canvas.addEventListener('pointerdown',e=>{if(gameState==='PLAYING'&&isMapFullyLoaded)ensureAudio();});

  const joystick=document.getElementById('joystick'),knob=document.getElementById('joystickKnob'),gameWrap=document.getElementById('gameWrap');
  let joyId=null;
  function positionFloatingJoystick(e){
    const gr=gameWrap.getBoundingClientRect(),radius=joystick.offsetWidth/2;
    const x=Math.max(radius,Math.min(gr.width-radius,e.clientX-gr.left));
    const y=Math.max(radius,Math.min(gr.height-radius,e.clientY-gr.top));
    joystick.style.left=x+'px';joystick.style.top=y+'px';joystick.style.right='auto';joystick.style.bottom='auto';joystick.classList.add('floating-active');
  }
  function beginJoystick(e,floating=false){
    if(gameState!=='PLAYING'||!isMapFullyLoaded)return;
    if(floating)positionFloatingJoystick(e);
    joyId=e.pointerId;try{joystick.setPointerCapture(e.pointerId)}catch(_){};joyMove(e);
  }
  function joyMove(e){
    if(e.pointerId!==joyId)return;
    const r=joystick.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;let dx=e.clientX-cx,dy=e.clientY-cy;
    const max=r.width*.34,m=Math.hypot(dx,dy);if(m>max){dx=dx/m*max;dy=dy/m*max}
    input.x=dx/max;input.y=dy/max;input.joystickActive=true;knob.style.transform=`translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px))`;
  }
  function joyEnd(e){
    if(e.pointerId!==joyId)return;joyId=null;input.x=input.y=0;input.joystickActive=false;knob.style.transform='translate(-50%,-50%)';
    if(joystickFloating)joystick.classList.remove('floating-active');
  }
  joystick.addEventListener('pointerdown',e=>beginJoystick(e,false));joystick.addEventListener('pointermove',joyMove);joystick.addEventListener('pointerup',joyEnd);joystick.addEventListener('pointercancel',joyEnd);
  gameWrap.addEventListener('pointerdown',e=>{
    if(joystickFloating&&gameState==='PLAYING'&&e.target!==joystick&&!joystick.contains(e.target)&&!e.target.closest?.('button'))beginJoystick(e,true);
  },{passive:true});

  let titleMusicGestureUnlocked=false;
  let gestureStartX=0;
  let gestureStartY=0;
  let gestureMovedFar=false;
  let gestureActive=false;

  document.addEventListener('pointerdown',e=>{
    gestureStartX=e.clientX;
    gestureStartY=e.clientY;
    gestureMovedFar=false;
    gestureActive=true;
    try{
      ensureAudio();
      // Instantaneous button SFX on first touch contact (zero delay)
      const btn=e.target.closest && e.target.closest('button, .control-choice, .ls-round-card, .ls-dot, .icon-btn');
      if(btn && !btn.disabled){
        try{ playSfx('button'); }catch(_){}
      }
      if(!titleMusicGestureUnlocked && musicEnabled && (gameState==='MENU' || gameState==='LEVELS')){
        const mm=ensureMainTitleMusic();
        if(mm && mm.src){
          titleMusicGestureUnlocked=true;
          try {
            mm.muted=false;
            mm.volume=(gameState==='PLAYING'?GAMEPLAY_MUSIC_VOLUME:MAIN_MENU_VOLUME);
            seekMainTitleToStart();
            const p=mm.play();
            if(p&&typeof p.catch==='function') p.catch(()=>{ titleMusicGestureUnlocked=false; });
          } catch(_) {
            titleMusicGestureUnlocked=false;
          }
          fadeMainTitleIn(false);
        }
      }
    }catch(_){ }
  },{passive:true});

  document.addEventListener('pointermove',e=>{
    if(!gestureActive) return;
    const dx=e.clientX-gestureStartX;
    const dy=e.clientY-gestureStartY;
    if((dx*dx + dy*dy) > 36){
      gestureMovedFar=true;
    }
  },{passive:true});

  document.addEventListener('pointerup',()=>{
    gestureActive=false;
    gestureMovedFar=false;
  },{passive:true});

  document.addEventListener('pointercancel',()=>{
    gestureActive=false;
    gestureMovedFar=false;
  },{passive:true});

  function handleStartButton(){
    level.stage=1; level.level=1; level.turn=1;
    // The start button is also a trusted user gesture; use it only as a silent autoplay fallback.
    try { titleMusicGestureUnlocked=true; fadeMainTitleIn(false); } catch (_) {}
    openLevelSelect();
  }
  document.getElementById('startBtn').addEventListener('click', handleStartButton);
  document.getElementById('howBtn').addEventListener('click',()=>document.getElementById('howPanel').classList.remove('hidden'));
  document.getElementById('closeHow').addEventListener('click',()=>document.getElementById('howPanel').classList.add('hidden'));
  document.getElementById('settingsBtn').addEventListener('click',()=>{
    document.getElementById('settingsPanel').classList.remove('hidden');
    applyControlLayout(controlLayout);
    updateMusicUi();
  });
  document.getElementById('closeSettings').addEventListener('click',()=>document.getElementById('settingsPanel').classList.add('hidden'));
  document.getElementById('closeControlSetup').addEventListener('click',()=>{
    document.getElementById('controlSetupPanel').classList.add('hidden');
    pendingRoundStart=null;
  });
  document.querySelectorAll('.control-choice').forEach(btn=>{
    btn.addEventListener('click',()=>{
      applyControlLayout(btn.dataset.layout);
      if(btn.closest('#controlSetupPanel')) confirmPendingRoundStart();
    });
  });
  document.getElementById('musicToggleBtn')?.addEventListener('click',()=>setMusicEnabled(!musicEnabled));
  document.getElementById('settingsMusicToggle')?.addEventListener('click',()=>setMusicEnabled(!musicEnabled));
  document.getElementById('floatingJoystickToggle')?.addEventListener('change',e=>applyJoystickMode(e.target.checked));
  applyControlLayout(controlLayout);
  applyJoystickMode(joystickFloating);
  updateMusicUi();
  function updateMuteUi(){
    const btn=document.getElementById('muteBtn');
    if(!btn)return;
    const icon=btn.querySelector('.btn-icon');
    const label=btn.querySelector('span:not(.btn-icon)');
    if(icon) icon.textContent=isMuted?'🔇':'🔊';
    if(label) label.textContent=isMuted?'تشغيل الصوت':'كتم الصوت';
    btn.setAttribute('aria-pressed',String(isMuted));
  }

  function setMasterMute(nextMuted){
    isMuted=!!nextMuted;
    if(isMuted) sirenStop(true);
    updateMuteUi();
    try{
      if(vaultAudio){ vaultAudio.muted=isMuted; if(isMuted){ try{vaultAudio.pause();}catch(_){} } }
      if(escapeAudio){ escapeAudio.muted=isMuted; if(isMuted){ try{escapeAudio.pause();}catch(_){} } }
      if(resultMusic){ resultMusic.muted=isMuted; if(isMuted){ try{resultMusic.pause();}catch(_){} } }
      if(gameOverMusic){ gameOverMusic.muted=isMuted; if(isMuted){ try{gameOverMusic.pause();}catch(_){} } }
      if(audio?.ac){
        const now=audio.ac.currentTime;
        audio.sfxBus.gain.cancelScheduledValues(now);
        audio.sfxBus.gain.setTargetAtTime(isMuted?0:1.0,now,.025);
        if(music.finalGain){
          music.finalGain.cancelScheduledValues(now);
          music.finalGain.setTargetAtTime(isMuted?0:GAMEPLAY_LOCAL_MUSIC_GAIN,now,.025);
        }
      }
      if(!isMuted){
        if(gameState==='MENU' || gameState==='LEVELS') {
          try{ titleMusicGestureUnlocked=true; fadeMainTitleIn(false); }catch(_){}
        } else if(gameState==='PLAYING') {
          try{ setMainTitleGameplayVolume(); }catch(_){}
          setMusicChase(!!world?.anyChase);
        }
        setAudioStatusSafe('الصوت: يعمل');
      }else{
        setAudioStatusSafe('الصوت: مكتوم');
      }
    }catch(_){ }
  }

  const muteBtn=document.getElementById('muteBtn');
  if(muteBtn) muteBtn.addEventListener('click',()=>setMasterMute(!isMuted));
  updateMuteUi();
  document.getElementById('restartBtn')?.addEventListener('click',()=>{if(gameState==='PLAYING')buildLevel()});
  function runAfterResultFade(action){
    if(resultTransitioning)return;
    resultTransitioning=true;
    // Go immediately: setState() already fades the result music out in the background. Waiting for the
    // 850ms fade before doing anything made every button feel laggy.
    try{action();}finally{ setTimeout(()=>{resultTransitioning=false;},450); }
  }
  document.getElementById('retryBtn').addEventListener('click',()=>runAfterResultFade(()=>startRaid()));
  document.getElementById('rewardContinueBtn')?.addEventListener('click',requestRewardContinue);
  document.getElementById('nextBtn').addEventListener('click',()=>{ if(gameState!=='SUCCESS'||resultTransitioning)return; runAfterResultFade(()=>advanceToNextLevel()); });
  document.getElementById('successLevelsBtn').addEventListener('click',()=>runAfterResultFade(()=>openLevelSelect()));
  document.getElementById('failureLevelsBtn').addEventListener('click',()=>runAfterResultFade(()=>openLevelSelect()));
  document.getElementById('levelsBtn').addEventListener('click',()=>{openLevelSelect()});
  document.getElementById('levelsBackBtn')?.addEventListener('click',()=>setState('MENU'));
  document.getElementById('stageBoardContainer')?.addEventListener('click', e => {
    const card = e.target.closest('.hotspot-card');
    if(card && card.dataset.round){
      selectLevel(currentViewingStage, Number(card.dataset.round), true);
      return;
    }
    const dot = e.target.closest('.hotspot-dot');
    if(dot && dot.dataset.stage){
      setViewingStage(Number(dot.dataset.stage));
      return;
    }
  });
  document.getElementById('lsPrevBtn')?.addEventListener('click', () => changeViewingStage(-1));
  document.getElementById('lsNextBtn')?.addEventListener('click', () => changeViewingStage(1));

  // Touch swipe support on stage board to change stage smoothly
  const stageBoardEl = document.getElementById('stageBoardContainer');
  if(stageBoardEl){
    let touchStartX = 0, touchStartY = 0;
    stageBoardEl.addEventListener('touchstart', e => {
      if(e.touches.length === 1){
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
    }, { passive: true });
    stageBoardEl.addEventListener('touchend', e => {
      if(e.changedTouches.length === 1){
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;
        if(Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5){
          if(dx > 0){
            changeViewingStage(-1);
          } else {
            changeViewingStage(1);
          }
        }
      }
    }, { passive: true });
  }

  let simAccumulator=0;
  const FIXED_DT=1/60;
  // On a slow device a long frame must not queue many extra simulation steps: that makes the next
  // frame even longer (a death spiral). Two steps max; the game then simply runs slightly slower.
  const MAX_CATCHUP_STEPS=2;
  // Thief and guards share one speed multiplier (same ratio, so the chase balance is unchanged): 1.08 * 1.30.
  const SPEED_BOOST=1.404;
  // Keep simulation at a stable 60Hz while avoiding duplicate full Canvas renders
  // on 90/120Hz displays. This reduces GPU/CPU pressure without changing gameplay timing.

  function startGameRenderLoop(){
    if(gameLoopActive) return;
    gameLoopActive=true;
    perfWarm=60; perfAcc=0; perfN=0;
    simAccumulator=0;
    lastFrame=performance.now();
    snapshotPrev();
    gameFrameRaf=requestAnimationFrame(frame);
  }

  function stopGameRenderLoop(){
    gameLoopActive=false;
    simAccumulator=0;
    if(gameFrameRaf){
      cancelAnimationFrame(gameFrameRaf);
      gameFrameRaf=0;
    }
  }

  // ---- smooth presentation -------------------------------------------------------------------------
  // The simulation runs at a fixed 60Hz. Drawing raw simulation positions makes motion judder whenever a
  // display frame falls between two sim steps (0, 1 or 2 steps per frame). So the thief, the guards (and
  // therefore the camera and the light that follow them) are drawn at the position interpolated between
  // the previous and the current sim step.
  let refreshMs=1000/60, refreshSamples=[], presentParity=0;
  function snapshotPrev(){
    const w=world; if(!w) return;
    const p=w.player; if(p){ p.px=p.x; p.py=p.y; }
    const gs=w.guards; if(gs) for(let i=0;i<gs.length;i++){ const g=gs[i]; g.px=g.x; g.py=g.y; }
  }
  function renderInterpolated(now){
    const w=world;
    const a=Math.min(1,simAccumulator/FIXED_DT);
    if(!w || gameState!=='PLAYING' || isGameOver || !(a>.001)){ draw(now); return; }
    const saved=[];
    const lerpEnt=(e)=>{
      if(e.px===undefined) return;
      const dx=e.x-e.px, dy=e.y-e.py;
      if(dx*dx+dy*dy>2304) return;               // teleport (spawn / relocation): never smear across the map
      saved.push(e,e.x,e.y);
      e.x=e.px+dx*a; e.y=e.py+dy*a;
    };
    if(w.player) lerpEnt(w.player);
    if(w.guards) for(let i=0;i<w.guards.length;i++) lerpEnt(w.guards[i]);
    try{ draw(now); }
    finally{ for(let i=0;i<saved.length;i+=3){ const e=saved[i]; e.x=saved[i+1]; e.y=saved[i+2]; } }
  }
  function frame(now){
    if(!gameLoopActive) return;
    const delta=now-lastFrame;
    monitorFramePerformance(delta);
    // Learn the display refresh interval (median of 30 samples) once.
    if(refreshSamples.length<30 && delta>3 && delta<40){
      refreshSamples.push(delta);
      if(refreshSamples.length===30){ refreshSamples.sort((x,y)=>x-y); refreshMs=refreshSamples[15]; }
    }
    const raw=Math.min(.20,Math.max(0,delta/1000));
    lastFrame=now; simAccumulator+=raw;
    let steps=0;
    while(simAccumulator>=FIXED_DT && steps<MAX_CATCHUP_STEPS){
      snapshotPrev();
      try{update(FIXED_DT,now)}catch(err){console.error('update',err)}
      simAccumulator-=FIXED_DT; steps++;
    }
    if(steps===MAX_CATCHUP_STEPS) simAccumulator=0;
    if(steps>0 && gameState==='PLAYING' && world){ try{updateHUD();}catch(err){console.error('HUD error',err);} }
    // 60/72/90Hz displays present every frame. Only 120Hz+ panels present every second frame (saves power/heat);
    // the old "skip if the gap looks slightly short" rule dropped random frames on 60Hz and caused stutter.
    presentParity^=1;
    if(refreshMs>9.5 || presentParity){
      try{ renderInterpolated(now); }catch(err){console.error('draw',err)}
    }
    gameFrameRaf=requestAnimationFrame(frame);
  }
  // Development invariants: these helpers are lexical functions inside this IIFE,
  // so validate them directly instead of looking for them on globalThis. The previous
  // globalThis check itself crashed the entire game before the render loop started.
  if (typeof canGuardStandAt !== 'function' ||
      typeof pickGuardDetour !== 'function' ||
      typeof findGridPath !== 'function') {
    throw new Error('Guard movement dependencies are missing');
  }
  renderMenuActorsOnce();
  renderLevelSelect();
  setState('MENU');
  // Pick the best resolution this phone can sustain right away, before the player reaches the first round.
  setTimeout(()=>requestAnimationFrame(()=>calibrateRenderQuality()),250);
  // Best-effort audible autoplay. Browsers may block it until a normal page interaction.
  // When the user disabled music, do not start a muted background stream at all.
  if(musicEnabled){
    try {
      const mm=ensureMainTitleMusic();
      if(mm){
        mm.autoplay=true;
        mm.muted=false;
        const p=mm.play();
        if(p&&typeof p.catch==='function') p.catch(()=>{ titleMusicGestureUnlocked=false; });
      }
    } catch(_) {}
  }
})();
