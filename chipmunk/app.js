const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];

const PRESETS={
  '2.3':{speed:2.3,gainDb:-4},
  '2.5':{speed:2.5,gainDb:-6},
  '2.7':{speed:2.7,gainDb:-8}
};

const state={
  preset:'2.5',
  speed:2.5,
  gainDb:-6,
  gameSpeed:0.4,
  outputFormat:'ogg',
  files:[],
  history:[],
  processed:Number(localStorage.getItem('cbProcessed')||0),
  isConverting:false,
  batchIndex:0,
  batchTotal:1,
  audioContext:null
};

const input=$('#fileInput');
const drop=$('#dropzone');
const convertBtn=$('#convertBtn');
const downloadAllBtn=$('#downloadAllBtn');
const speedRange=$('#speedRange');
const speedInput=$('#speedInput');
const gameSpeedInput=$('#gameSpeedInput');
const gainRange=$('#gainRange');
const gainInput=$('#gainInput');
const gameSpeedDisplay=$('#gameSpeedDisplay');
const gameRelation=$('#gameRelation');
const settingsMode=$('#settingsMode');
const gainWarning=$('#gainWarning');
const formatChoices=$$('.format-choice');

$('#processedCount').textContent=state.processed;

function toast(msg){
  const t=$('#toast');
  t.textContent=msg;
  t.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer=setTimeout(()=>t.classList.remove('show'),4200);
}

function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

function escapeHtml(value){
  return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function safeBaseName(name){
  const raw=String(name)
    .replace(/\.[^.]+$/,'')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g,'_')
    .trim();
  return raw||'audio';
}

function formatMB(bytes){return `${(bytes/1024/1024).toFixed(2)} MB`;}

function setEngineStatus(text,ready=false){
  $('#engineStatus').innerHTML=`<span class="engine-dot"${ready?' style="background:#3ee2d5;box-shadow:0 0 8px rgba(62,226,213,.5)"':''}></span> ${text}`;
}

function clamp(value,min,max){return Math.min(max,Math.max(min,value));}
function roundTo(value,digits=2){const p=10**digits;return Math.round(value*p)/p;}
function formatDb(value){return `${value>0?"+":""}${Number(value).toFixed(Number(value)%1?1:0)} dB`;}
function inverseGameSpeed(speed){return roundTo(clamp(1/speed,0.25,4),2);}

function syncSettingsUI(){
  speedRange.value=String(state.speed);
  speedInput.value=Number(state.speed).toFixed(2);
  gainRange.value=String(state.gainDb);
  gainInput.value=String(state.gainDb);
  gameSpeedInput.value=Number(state.gameSpeed).toFixed(2);
  gameSpeedDisplay.textContent=`${Number(state.gameSpeed).toFixed(2)}×`;
  gameRelation.innerHTML=`Speed <b>${Number(state.speed).toFixed(2)}×</b> → set Roblox to <b>${Number(state.gameSpeed).toFixed(2)}×</b>`;
  $('#activePresetLabel').textContent=`${Number(state.speed).toFixed(2)}X / ${formatDb(state.gainDb).toUpperCase()}`;
  settingsMode.textContent=state.preset==='custom'?'CUSTOM':`PRESET ${state.preset}X`;
  gainWarning.hidden=state.gainDb<=0;
  $$('.preset').forEach(button=>button.classList.toggle('active',state.preset===button.dataset.preset));
}

function setSettings(speed,gainDb,mode='custom'){
  state.speed=roundTo(clamp(Number(speed)||1,0.25,4),2);
  state.gainDb=roundTo(clamp(Number(gainDb)||0,-24,12),1);
  state.gameSpeed=inverseGameSpeed(state.speed);
  state.preset=mode;
  syncSettingsUI();
}

function setFromGameSpeed(gameSpeed){
  const game=roundTo(clamp(Number(gameSpeed)||1,0.25,4),2);
  state.gameSpeed=game;
  state.speed=roundTo(clamp(1/game,0.25,4),2);
  state.preset='custom';
  syncSettingsUI();
}

$$('.preset').forEach(button=>{
  button.onclick=()=>{
    if(state.isConverting)return;
    const key=button.dataset.preset;
    const p=PRESETS[key];
    setSettings(p.speed,p.gainDb,key);
  };
});

speedRange.addEventListener('input',()=>{if(!state.isConverting)setSettings(speedRange.value,state.gainDb,'custom');});
speedInput.addEventListener('change',()=>{if(!state.isConverting)setSettings(speedInput.value,state.gainDb,'custom');});
gameSpeedInput.addEventListener('change',()=>{if(!state.isConverting)setFromGameSpeed(gameSpeedInput.value);});
gainRange.addEventListener('input',()=>{if(!state.isConverting)setSettings(state.speed,gainRange.value,'custom');});
gainInput.addEventListener('change',()=>{if(!state.isConverting)setSettings(state.speed,gainInput.value,'custom');});

function updateFormatUI(){
  formatChoices.forEach(button=>{
    button.classList.toggle('active',button.dataset.format===state.outputFormat);
    button.disabled=state.isConverting;
  });
  const label=$('#convertBtnText');
  if(label&&!state.isConverting){
    label.textContent=`Convert to Chipmunk ${state.outputFormat.toUpperCase()}`;
  }
}

function setOutputFormat(format){
  if(state.isConverting)return;
  state.outputFormat=format==='flac'?'flac':'ogg';
  updateFormatUI();
  if(state.outputFormat==='flac'){
    setEngineStatus('Menyiapkan FLAC lossless encoder...');
    void ensureFlacEncoder()
      .then(()=>setEngineStatus('Audio engine ready · FLAC lossless / 48 kHz.',true))
      .catch(err=>{
        console.warn('FLAC preload failed:',err);
        setEngineStatus('FLAC encoder akan dicoba lagi saat Convert.');
      });
  }else{
    setEngineStatus('Menyiapkan OGG Vorbis encoder...');
    void ensureVorbisEncoder()
      .then(()=>setEngineStatus('Audio engine ready · OGG Vorbis q5 / 48 kHz.',true))
      .catch(err=>{
        console.warn('Vorbis preload failed:',err);
        setEngineStatus('OGG encoder akan dicoba lagi saat Convert.');
      });
  }
}

formatChoices.forEach(button=>{
  button.addEventListener('click',()=>setOutputFormat(button.dataset.format));
});

function validAudio(file){
  return /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(file.name)||(file.type&&file.type.startsWith('audio/'));
}

function addFiles(files){
  const valid=files.filter(validAudio);
  const seen=new Set(state.files.map(file=>`${file.name}|${file.size}|${file.lastModified}`));
  for(const file of valid){
    const key=`${file.name}|${file.size}|${file.lastModified}`;
    if(!seen.has(key)){
      state.files.push(file);
      seen.add(key);
    }
  }
  renderQueue();
  if(valid.length!==files.length){
    toast(`${files.length-valid.length} file dilewati karena format tidak didukung.`);
  }
}

function renderQueue(){
  const queue=$('#queue');
  const list=$('#queueList');

  queue.hidden=!state.files.length;
  const nativeCount=input.files?input.files.length:0;
  convertBtn.disabled=(!state.files.length&&!nativeCount)||state.isConverting;
  $('#selectedCount').textContent=`${state.files.length} file${state.files.length===1?'':'s'} selected`;
  $('#queueSubtext').textContent=state.files.length
    ?`${state.files.length} audio ready · diproses satu per satu agar stabil`
    :'Ready to convert';

  list.innerHTML='';

  state.files.forEach((file,index)=>{
    const row=document.createElement('div');
    row.className='queue-item';
    row.innerHTML=`<span title="${escapeHtml(file.name)}">${escapeHtml(file.name)} <small>(${formatMB(file.size)})</small></span><button aria-label="Remove ${escapeHtml(file.name)}" ${state.isConverting?'disabled':''}>×</button>`;
    row.querySelector('button').onclick=e=>{
      e.stopPropagation();
      if(state.isConverting)return;
      state.files.splice(index,1);
      renderQueue();
    };
    list.appendChild(row);
  });
}

drop.addEventListener('click',event=>{
  if(state.isConverting)return;
  if(event.target.closest('label[for="fileInput"]'))return;
  input.click();
});

drop.onkeydown=e=>{
  if(!state.isConverting&&(e.key==='Enter'||e.key===' ')){
    e.preventDefault();
    input.click();
  }
};
drop.ondragover=e=>{
  e.preventDefault();
  if(!state.isConverting)drop.classList.add('dragging');
};
drop.ondragleave=()=>drop.classList.remove('dragging');
drop.ondrop=e=>{
  e.preventDefault();
  drop.classList.remove('dragging');
  if(state.isConverting)return;
  addFiles([...e.dataTransfer.files]);
};
function syncFilesFromInput(){
  if(state.isConverting)return;
  const picked=[...(input.files||[])];
  if(!picked.length)return;
  state.files=[];
  addFiles(picked);
}

input.addEventListener('change',syncFilesFromInput);
input.addEventListener('input',syncFilesFromInput);

$('#clearQueue').onclick=()=>{
  if(state.isConverting)return;
  state.files=[];
  input.value='';
  renderQueue();
};

function loadScript(url,test){
  return new Promise((resolve,reject)=>{
    if(test())return resolve();

    const existing=[...document.scripts].find(s=>s.src===url);
    if(existing)existing.remove();

    const script=document.createElement('script');
    script.src=url;
    script.async=true;
    script.onload=()=>test()?resolve():reject(new Error(`Library dari ${url} termuat tetapi API tidak tersedia.`));
    script.onerror=()=>{
      script.remove();
      reject(new Error(`Gagal memuat ${url}`));
    };
    document.head.appendChild(script);
  });
}

async function ensureVorbisEncoder(){
  if(typeof window.OggVorbisEncoder==='function')return;

  const sources=[
    'https://cdn.jsdelivr.net/gh/higuma/ogg-vorbis-encoder-js@master/lib/OggVorbisEncoder.js',
    'https://higuma.github.io/ogg-vorbis-encoder-js/lib/OggVorbisEncoder.js'
  ];

  let lastError=null;
  for(const src of sources){
    try{
      await loadScript(src,()=>typeof window.OggVorbisEncoder==='function');
      if(typeof window.OggVorbisEncoder==='function')return;
    }catch(err){
      console.warn('Vorbis source failed:',src,err);
      lastError=err;
    }
  }

  throw lastError||new Error('OGG Vorbis encoder gagal dimuat.');
}

async function ensureFlacEncoder(){
  if(window.Flac&&typeof window.Flac.create_libflac_encoder==='function')return window.Flac;

  const sources=[
    'https://cdn.jsdelivr.net/npm/libflacjs@5.6.0/dist/libflac.js',
    'https://unpkg.com/libflacjs@5.6.0/dist/libflac.js'
  ];

  let lastError=null;
  for(const src of sources){
    try{
      await loadScript(src,()=>!!(window.Flac&&typeof window.Flac.create_libflac_encoder==='function'));
      if(window.Flac&&typeof window.Flac.create_libflac_encoder==='function')return window.Flac;
    }catch(err){
      console.warn('FLAC source failed:',src,err);
      lastError=err;
    }
  }

  throw lastError||new Error('FLAC encoder gagal dimuat.');
}

async function ensureJSZip(){
  if(window.JSZip)return window.JSZip;

  const sources=[
    'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'
  ];

  let lastError=null;
  for(const src of sources){
    try{
      await loadScript(src,()=>!!window.JSZip);
      if(window.JSZip)return window.JSZip;
    }catch(err){
      console.warn('JSZip source failed:',src,err);
      lastError=err;
    }
  }

  throw lastError||new Error('ZIP library gagal dimuat.');
}

async function warmLibraries(){
  setEngineStatus('Menyiapkan browser audio engine...');
  try{
    if(state.outputFormat==='flac'){
      await ensureFlacEncoder();
      setEngineStatus('Audio engine ready · FLAC lossless / 48 kHz.',true);
    }else{
      await ensureVorbisEncoder();
      setEngineStatus('Audio engine ready · OGG Vorbis q5 / 48 kHz.',true);
    }
  }catch(err){
    console.warn('Encoder preload failed:',err);
    setEngineStatus('Encoder belum termuat. Akan dicoba lagi saat Convert.');
  }
}

function getAudioContext(){
  if(state.audioContext&&state.audioContext.state!=='closed')return state.audioContext;

  const AudioCtx=window.AudioContext||window.webkitAudioContext;
  if(!AudioCtx)throw new Error('Browser ini tidak mendukung Web Audio API. Gunakan Chrome, Edge, atau Brave terbaru.');

  try{
    state.audioContext=new AudioCtx({sampleRate:48000});
  }catch(_){
    state.audioContext=new AudioCtx();
  }
  return state.audioContext;
}

async function decodeAudio(file){
  const ctx=getAudioContext();
  const raw=await file.arrayBuffer();
  try{
    return await ctx.decodeAudioData(raw.slice(0));
  }catch(err){
    throw new Error(`Format audio tidak dapat didecode browser: ${file.name}`);
  }
}

async function renderChipmunk(decoded,preset){
  const sampleRate=48000;
  const channels=Math.max(1,Math.min(2,decoded.numberOfChannels||2));
  const outputDuration=Math.max(0.01,decoded.duration/preset.speed);
  const frames=Math.max(1,Math.ceil(outputDuration*sampleRate));

  const OfflineCtx=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  if(!OfflineCtx)throw new Error('OfflineAudioContext tidak tersedia pada browser ini.');

  const offline=new OfflineCtx(channels,frames,sampleRate);
  const source=offline.createBufferSource();
  const gain=offline.createGain();

  source.buffer=decoded;
  source.playbackRate.value=preset.speed;
  gain.gain.value=Math.pow(10,preset.gainDb/20);

  source.connect(gain);
  gain.connect(offline.destination);
  source.start(0);

  return await offline.startRendering();
}

function setFileProgress(fraction){
  const f=Math.max(0,Math.min(1,fraction));
  const overall=((state.batchIndex+f)/Math.max(1,state.batchTotal))*100;
  $('#progressFill').style.width=`${Math.max(0,Math.min(100,overall))}%`;
}

async function encodeVorbis(audioBuffer){
  await ensureVorbisEncoder();

  const channels=Math.max(1,Math.min(2,audioBuffer.numberOfChannels));
  const encoder=new window.OggVorbisEncoder(48000,channels,0.5);
  const total=audioBuffer.length;
  const chunkSize=16384;

  try{
    for(let start=0;start<total;start+=chunkSize){
      const end=Math.min(total,start+chunkSize);
      const channelChunks=[];

      for(let ch=0;ch<channels;ch++){
        channelChunks.push(audioBuffer.getChannelData(ch).subarray(start,end));
      }

      encoder.encode(channelChunks);
      setFileProgress(0.55+0.45*(end/total));

      if(start%(chunkSize*8)===0)await sleep(0);
    }

    return encoder.finish('audio/ogg');
  }catch(err){
    try{encoder.cancel();}catch(_){ }
    throw err;
  }
}

async function encodeFlac(audioBuffer){
  const Flac=await ensureFlacEncoder();
  const sampleRate=48000;
  const channels=Math.max(1,Math.min(2,audioBuffer.numberOfChannels));
  const bitsPerSample=16;
  const compressionLevel=5;
  const totalSamples=audioBuffer.length;
  const chunks=[];

  const encoder=Flac.create_libflac_encoder(
    sampleRate,
    channels,
    bitsPerSample,
    compressionLevel,
    totalSamples,
    false
  );

  if(!encoder)throw new Error('FLAC encoder tidak dapat dibuat.');

  const writeCallback=(buffer,bytes)=>{
    const view=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer);
    chunks.push(view.slice(0,bytes||view.length));
  };
  const metadataCallback=()=>{};

  try{
    const initStatus=Flac.init_encoder_stream(
      encoder,
      writeCallback,
      metadataCallback,
      false,
      0
    );

    if(initStatus!==0)throw new Error(`FLAC encoder init gagal (status ${initStatus}).`);

    const blockFrames=16384;
    for(let start=0;start<totalSamples;start+=blockFrames){
      const end=Math.min(totalSamples,start+blockFrames);
      const frameCount=end-start;
      const pcm=new Int32Array(frameCount*channels);

      for(let i=0;i<frameCount;i++){
        for(let ch=0;ch<channels;ch++){
          const data=audioBuffer.getChannelData(ch);
          const value=Math.max(-1,Math.min(1,data[start+i]||0));
          pcm[i*channels+ch]=value<0
            ?Math.round(value*32768)
            :Math.round(value*32767);
        }
      }

      const ok=Flac.FLAC__stream_encoder_process_interleaved(
        encoder,
        pcm,
        frameCount
      );

      if(ok!==true)throw new Error('FLAC encoding gagal saat memproses PCM.');

      setFileProgress(0.55+0.45*(end/totalSamples));
      if(start%(blockFrames*8)===0)await sleep(0);
    }

    const finished=Flac.FLAC__stream_encoder_finish(encoder);
    if(finished!==true)throw new Error('FLAC encoder gagal melakukan finalisasi.');

    return new Blob(chunks,{type:'audio/flac'});
  }finally{
    try{Flac.FLAC__stream_encoder_delete(encoder);}catch(_){ }
  }
}

async function convertOne(file,preset){
  setFileProgress(0.03);
  const decoded=await decodeAudio(file);

  setFileProgress(0.18);
  const rendered=await renderChipmunk(decoded,preset);

  setFileProgress(0.55);

  const format=preset.outputFormat==='flac'?'flac':'ogg';
  const blob=format==='flac'
    ?await encodeFlac(rendered)
    :await encodeVorbis(rendered);

  setFileProgress(1);

  if(!blob||!blob.size)throw new Error(`Output ${format.toUpperCase()} kosong: ${file.name}`);

  const title=`${preset.speed}x-${safeBaseName(file.name)}.${format}`;

  return{
    title,
    originalName:file.name,
    speed:preset.speed,
    gainDb:preset.gainDb,
    gameSpeed:preset.gameSpeed,
    format,
    size:blob.size,
    createdAt:Date.now(),
    blob,
    url:URL.createObjectURL(blob)
  };
}

convertBtn.onclick=async()=>{
  if(state.isConverting)return;

  if(!state.files.length&&input.files&&input.files.length){
    state.files=[...input.files].filter(validAudio);
    renderQueue();
  }

  if(!state.files.length){
    toast('Pilih minimal satu file audio terlebih dahulu.');
    return;
  }

  const batch=[...state.files];
  const preset={
    speed:state.speed,
    gainDb:state.gainDb,
    gameSpeed:state.gameSpeed,
    outputFormat:state.outputFormat
  };
  const failed=[];
  let successCount=0;

  state.isConverting=true;
  input.disabled=true;
  state.batchTotal=batch.length;
  state.batchIndex=0;

  renderQueue();
  $$('.preset').forEach(b=>b.disabled=true);
  formatChoices.forEach(b=>b.disabled=true);
  $('#clearQueue').disabled=true;
  $('#progressBar').hidden=false;
  $('#progressFill').style.width='0%';

  try{
    if(preset.outputFormat==='flac'){
      await ensureFlacEncoder();
      setEngineStatus('Audio engine ready · FLAC lossless / 48 kHz.',true);
    }else{
      await ensureVorbisEncoder();
      setEngineStatus('Audio engine ready · OGG Vorbis q5 / 48 kHz.',true);
    }

    for(let i=0;i<batch.length;i++){
      state.batchIndex=i;
      const file=batch[i];
      $('#convertBtnText').textContent=`Converting ${i+1} / ${batch.length}`;
      setEngineStatus(`Processing ${i+1}/${batch.length} · ${escapeHtml(file.name)}`,true);

      try{
        const result=await convertOne(file,preset);
        state.history.unshift(result);
        state.processed++;
        successCount++;
        localStorage.setItem('cbProcessed',String(state.processed));
        $('#processedCount').textContent=state.processed;
        showResult(result,false);
        renderHistory();
      }catch(err){
        console.error('File conversion failed:',file.name,err);
        failed.push(file);
      }

      state.batchIndex=i+1;
      $('#progressFill').style.width=`${((i+1)/batch.length)*100}%`;
      await sleep(20);
    }

    state.files=failed;
    renderQueue();

    if(successCount&&failed.length===0){
      toast(`${successCount} lagu berhasil dikonversi. Download satu per satu atau gunakan Download All ZIP.`);
      setEngineStatus(`Selesai · ${successCount} lagu berhasil dikonversi.`,true);
    }else if(successCount){
      toast(`${successCount} berhasil, ${failed.length} gagal didecode. File gagal tetap di queue.`);
      setEngineStatus(`${successCount} berhasil · ${failed.length} file tidak didukung browser.`,true);
    }else{
      toast('Tidak ada lagu yang berhasil. Coba file MP3/WAV/OGG lain atau gunakan Chrome/Edge terbaru.');
      setEngineStatus('Tidak ada file yang berhasil didecode.');
    }
  }catch(err){
    console.error('Batch setup failed:',err);
    state.files=batch;
    renderQueue();
    toast(`Audio engine belum siap: ${err?.message||err}`);
    setEngineStatus('Audio engine belum siap. Coba refresh halaman.');
  }finally{
    state.isConverting=false;
    input.disabled=false;
    state.batchIndex=0;
    state.batchTotal=1;
    $$('.preset').forEach(b=>b.disabled=false);
    formatChoices.forEach(b=>b.disabled=false);
    $('#clearQueue').disabled=false;
    $('#convertBtnText').textContent=state.files.length?'Retry / Convert Queue':`Convert to Chipmunk ${state.outputFormat.toUpperCase()}`;
    renderQueue();

    setTimeout(()=>{
      $('#progressBar').hidden=true;
      $('#progressFill').style.width='0%';
    },700);
  }
};

function showResult(item,scroll=true){
  $('#resultPanel').hidden=false;
  $('#editedChip').textContent=`EDITED · ${item.gainDb} DB`;
  $('#resultSpeed').textContent=`${Number(item.speed).toFixed(2)}X`;
  const resultGame=$('#resultGameSpeed');
  if(resultGame)resultGame.textContent=`GAME ${Number(item.gameSpeed).toFixed(2)}X`;
  const resultFormat=$('#resultFormat');
  const formatLabel=item.format==='flac'?'FLAC LOSSLESS':'OGG VORBIS';
  if(resultFormat)resultFormat.textContent=item.format.toUpperCase();
  $('#currentResult').innerHTML=`<div class="result-card"><div class="track-row"><div class="track-icon">♫</div><div><strong>${escapeHtml(item.title)}</strong><div>${formatLabel} · CONVERTER ${Number(item.speed).toFixed(2)}X · ROBLOX ${Number(item.gameSpeed).toFixed(2)}X · ${formatDb(item.gainDb)} · ${formatMB(item.size)}</div></div></div><audio controls preload="metadata" src="${item.url}"></audio><a class="download-btn" href="${item.url}" download="${escapeHtml(item.title)}">⇩ &nbsp; Download Audio (.${item.format})</a></div>`;
  if(scroll)$('#resultPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
}

function updateDownloadAllButton(){
  if(!downloadAllBtn)return;
  const count=state.history.length;
  downloadAllBtn.disabled=!count;
  downloadAllBtn.style.opacity=count?'1':'.35';
  downloadAllBtn.style.cursor=count?'pointer':'not-allowed';
  downloadAllBtn.textContent=count?`⇩ Download All ZIP (${count})`:'⇩ Download All ZIP';
}

function renderHistory(){
  const body=$('#historyBody');
  body.innerHTML='';
  $('#historyCount').textContent=`${state.history.length} ${state.history.length===1?'entry':'entries'}`;
  $('#emptyHistory').hidden=!!state.history.length;

  state.history.forEach((item,index)=>{
    const row=document.createElement('tr');
    row.innerHTML=`<td>${String(index+1).padStart(2,'0')}</td><td>${escapeHtml(item.title)}</td><td><strong>${item.format.toUpperCase()} · ${Number(item.speed).toFixed(2)}x</strong> converter<br><span>${Number(item.gameSpeed).toFixed(2)}x Roblox · ${formatDb(item.gainDb)}</span></td><td>${formatMB(item.size)}</td><td>${new Date(item.createdAt).toLocaleString('id-ID',{dateStyle:'short',timeStyle:'short'})}</td><td><a class="table-action" title="Download" href="${item.url}" download="${escapeHtml(item.title)}">⇩</a></td>`;
    body.appendChild(row);
  });

  updateDownloadAllButton();
}

function uniqueZipName(name,used){
  if(!used.has(name)){
    used.add(name);
    return name;
  }

  const dot=name.lastIndexOf('.');
  const base=dot>=0?name.slice(0,dot):name;
  const ext=dot>=0?name.slice(dot):'';
  let n=2;
  let candidate='';

  do{
    candidate=`${base} (${n++})${ext}`;
  }while(used.has(candidate));

  used.add(candidate);
  return candidate;
}

if(downloadAllBtn){
  downloadAllBtn.onclick=async()=>{
    if(!state.history.length||downloadAllBtn.disabled)return;

    downloadAllBtn.disabled=true;
    downloadAllBtn.style.opacity='.65';
    downloadAllBtn.textContent='Creating ZIP...';

    try{
      const JSZip=await ensureJSZip();
      const zip=new JSZip();
      const used=new Set();

      for(const item of [...state.history].reverse()){
        zip.file(uniqueZipName(item.title,used),item.blob);
      }

      const blob=await zip.generateAsync({
        type:'blob',
        compression:'STORE',
        streamFiles:true
      },metadata=>{
        downloadAllBtn.textContent=`Creating ZIP ${Math.round(metadata.percent)}%`;
      });

      const url=URL.createObjectURL(blob);
      const link=document.createElement('a');
      link.href=url;
      link.download=`central-blox-chipmunk-${new Date().toISOString().slice(0,10)}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);

      toast(`${state.history.length} hasil conversion berhasil dimasukkan ke ZIP.`);
    }catch(err){
      console.error('ZIP error:',err);
      toast(`Gagal membuat ZIP: ${err?.message||err}`);
    }finally{
      updateDownloadAllButton();
    }
  };
}

$('#clearHistory').onclick=()=>{
  if(state.isConverting)return;

  state.history.forEach(item=>URL.revokeObjectURL(item.url));
  state.history=[];
  renderHistory();
  $('#resultPanel').hidden=true;
  toast('History dibersihkan.');
};

syncSettingsUI();
updateFormatUI();
renderQueue();
renderHistory();

if('requestIdleCallback' in window){
  requestIdleCallback(()=>{void warmLibraries();},{timeout:1500});
}else{
  setTimeout(()=>{void warmLibraries();},500);
}

window.addEventListener('error',event=>{
  console.error('Runtime error:',event.error||event.message);
  const status=document.querySelector('#engineStatus');
  if(status && !state.isConverting){
    status.innerHTML='<span class="engine-dot"></span> Terjadi error pada halaman. Refresh sekali jika kontrol tidak merespons.';
  }
});
