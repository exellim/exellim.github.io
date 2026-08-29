const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];

const PRESETS={
  '2.3':{speed:2.3,gainDb:-4},
  '2.5':{speed:2.5,gainDb:-6},
  '2.7':{speed:2.7,gainDb:-8}
};

const state={
  preset:'2.5',
  files:[],
  history:[],
  ffmpeg:null,
  enginePromise:null,
  processed:Number(localStorage.getItem('cbProcessed')||0),
  isConverting:false,
  batchIndex:0,
  batchTotal:1
};

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
  const raw=String(name).replace(/\.[^.]+$/,'').replace(/[<>:"/\\|?*\x00-\x1F]/g,'_').trim();
  return raw||'audio';
}

function formatMB(bytes){return `${(bytes/1024/1024).toFixed(2)} MB`;}

function updatePresetUI(){
  const p=PRESETS[state.preset];
  $('#activePresetLabel').textContent=`${p.speed}X / ${p.gainDb} DB`;
}

$$('.preset').forEach(b=>b.onclick=()=>{
  if(state.isConverting)return;
  state.preset=b.dataset.preset;
  $$('.preset').forEach(x=>x.classList.toggle('active',x===b));
  updatePresetUI();
});

const input=$('#fileInput');
const drop=$('#dropzone');
const convertBtn=$('#convertBtn');
const downloadAllBtn=$('#downloadAllBtn');

drop.onclick=()=>{if(!state.isConverting)input.click();};
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
  void warmEngine();
};
input.onchange=()=>{
  if(state.isConverting)return;
  addFiles([...input.files]);
  input.value='';
  void warmEngine();
};

function validAudio(f){
  return /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(f.name)||(f.type&&f.type.startsWith('audio/'));
}

function addFiles(files){
  const valid=files.filter(validAudio);
  state.files.push(...valid);
  renderQueue();
  if(valid.length!==files.length)toast(`${files.length-valid.length} file dilewati karena format tidak didukung.`);
}

function renderQueue(){
  const q=$('#queue');
  const list=$('#queueList');
  q.hidden=!state.files.length;
  convertBtn.disabled=!state.files.length||state.isConverting;
  $('#selectedCount').textContent=`${state.files.length} file${state.files.length===1?'':'s'} selected`;
  $('#queueSubtext').textContent=state.files.length?`${state.files.length} audio ready · diproses satu per satu agar stabil`:'Ready to convert';
  list.innerHTML='';

  state.files.forEach((f,i)=>{
    const d=document.createElement('div');
    d.className='queue-item';
    d.innerHTML=`<span title="${escapeHtml(f.name)}">${escapeHtml(f.name)} <small>(${formatMB(f.size)})</small></span><button aria-label="Remove ${escapeHtml(f.name)}" ${state.isConverting?'disabled':''}>×</button>`;
    const remove=d.querySelector('button');
    remove.onclick=e=>{
      e.stopPropagation();
      if(state.isConverting)return;
      state.files.splice(i,1);
      renderQueue();
    };
    list.appendChild(d);
  });
}

$('#clearQueue').onclick=()=>{
  if(state.isConverting)return;
  state.files=[];
  renderQueue();
};

function setEngineStatus(text,ready=false){
  $('#engineStatus').innerHTML=`<span class="engine-dot"${ready?' style="background:#3ee2d5;box-shadow:0 0 8px rgba(62,226,213,.5)"':''}></span> ${text}`;
}

function loadScript(url){
  return new Promise((resolve,reject)=>{
    const existing=[...document.scripts].find(s=>s.src===url);
    if(existing){
      if((window.FFmpeg&&window.FFmpeg.createFFmpeg)||window.JSZip)return resolve();
      existing.remove();
    }
    const s=document.createElement('script');
    s.src=url;
    s.async=true;
    s.onload=()=>resolve();
    s.onerror=()=>{
      s.remove();
      reject(new Error(`Gagal memuat ${url}`));
    };
    document.head.appendChild(s);
  });
}

async function ensureFFmpegLibrary(){
  if(window.FFmpeg&&window.FFmpeg.createFFmpeg&&window.FFmpeg.fetchFile)return;
  const sources=[
    'https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js',
    'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js'
  ];
  let lastError=null;
  for(const src of sources){
    try{
      await loadScript(src);
      if(window.FFmpeg&&window.FFmpeg.createFFmpeg&&window.FFmpeg.fetchFile)return;
    }catch(err){lastError=err;}
  }
  throw lastError||new Error('Library FFmpeg gagal dimuat dari semua server cadangan.');
}

function updateFFmpegProgress({ratio}){
  const r=Number.isFinite(ratio)?Math.max(0,Math.min(1,ratio)):0;
  const overall=((state.batchIndex+r)/Math.max(1,state.batchTotal))*100;
  $('#progressFill').style.width=`${Math.max(0,Math.min(100,overall))}%`;
}

async function createEngineFrom(corePath){
  const api=window.FFmpeg;
  const ffmpeg=api.createFFmpeg({
    log:false,
    corePath
  });
  if(typeof ffmpeg.setProgress==='function')ffmpeg.setProgress(updateFFmpegProgress);
  await ffmpeg.load();
  return ffmpeg;
}

async function getEngine(){
  if(state.ffmpeg)return state.ffmpeg;
  if(state.enginePromise)return state.enginePromise;

  state.enginePromise=(async()=>{
    setEngineStatus('Menyiapkan audio engine...');
    await ensureFFmpegLibrary();

    const cores=[
      'https://cdn.jsdelivr.net/npm/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js',
      'https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js'
    ];

    let lastError=null;
    for(let i=0;i<cores.length;i++){
      try{
        setEngineStatus(`Menyiapkan audio engine${i?' (server cadangan)':''}...`);
        const engine=await createEngineFrom(cores[i]);
        state.ffmpeg=engine;
        setEngineStatus('Audio engine ready · 48 kHz stereo / Vorbis q5.',true);
        return engine;
      }catch(err){
        console.warn('FFmpeg core source failed:',cores[i],err);
        lastError=err;
      }
    }
    throw lastError||new Error('Audio engine tidak dapat dimuat.');
  })();

  try{
    return await state.enginePromise;
  }catch(err){
    console.error('FFmpeg load error:',err);
    state.ffmpeg=null;
    state.enginePromise=null;
    setEngineStatus('Audio engine gagal dimuat. Coba refresh jika koneksi CDN sedang bermasalah.');
    throw err;
  }
}

async function resetEngine(){
  const old=state.ffmpeg;
  state.ffmpeg=null;
  state.enginePromise=null;
  if(old&&typeof old.exit==='function'){
    try{old.exit();}catch(_){ }
  }
  await sleep(150);
}

async function warmEngine(){
  try{await getEngine();}
  catch(err){console.warn('Background FFmpeg preload gagal:',err);}
}

async function convertOne(file,p,index){
  const ffmpeg=await getEngine();
  const {fetchFile}=window.FFmpeg;
  const ext=(file.name.split('.').pop()||'bin').replace(/[^a-z0-9]/gi,'')||'bin';
  const token=`${Date.now()}-${index}-${Math.random().toString(36).slice(2,7)}`;
  const inputName=`input-${token}.${ext}`;
  const outputName=`output-${token}.ogg`;

  try{
    ffmpeg.FS('writeFile',inputName,await fetchFile(file));
    const rate=Math.round(48000*p.speed);
    const filter=`aresample=48000,asetrate=${rate},aresample=48000,volume=${p.gainDb}dB`;

    await ffmpeg.run(
      '-y','-i',inputName,
      '-vn',
      '-af',filter,
      '-ar','48000',
      '-ac','2',
      '-c:a','libvorbis',
      '-q:a','5',
      outputName
    );

    const data=ffmpeg.FS('readFile',outputName);
    const blob=new Blob([data.slice ? data.slice() : data],{type:'audio/ogg'});
    const title=`${p.speed}x-${safeBaseName(file.name)}.ogg`;

    return{
      title,
      originalName:file.name,
      speed:p.speed,
      gainDb:p.gainDb,
      size:blob.size,
      createdAt:Date.now(),
      blob,
      url:URL.createObjectURL(blob)
    };
  }finally{
    try{ffmpeg.FS('unlink',inputName);}catch(_){ }
    try{ffmpeg.FS('unlink',outputName);}catch(_){ }
  }
}

async function convertOneWithRetry(file,p,index){
  let firstError=null;
  for(let attempt=0;attempt<2;attempt++){
    try{
      return await convertOne(file,p,index);
    }catch(err){
      console.error(`Conversion attempt ${attempt+1} failed for ${file.name}:`,err);
      if(attempt===0){
        firstError=err;
        setEngineStatus(`Memulihkan engine untuk ${escapeHtml(file.name)}...`);
        await resetEngine();
        try{await getEngine();}catch(loadErr){throw loadErr;}
      }else{
        throw err||firstError;
      }
    }
  }
}

convertBtn.onclick=async()=>{
  if(!state.files.length||state.isConverting)return;

  const batch=[...state.files];
  const p=PRESETS[state.preset];
  const failed=[];
  let successCount=0;

  state.isConverting=true;
  state.batchTotal=batch.length;
  state.batchIndex=0;
  renderQueue();
  $$('.preset').forEach(b=>b.disabled=true);
  $('#clearQueue').disabled=true;
  $('#progressBar').hidden=false;
  $('#progressFill').style.width='0%';

  try{
    await getEngine();

    for(let i=0;i<batch.length;i++){
      state.batchIndex=i;
      const file=batch[i];
      $('#convertBtnText').textContent=`Converting ${i+1} / ${batch.length}`;
      setEngineStatus(`Processing ${i+1}/${batch.length} · ${escapeHtml(file.name)}`,true);

      try{
        const result=await convertOneWithRetry(file,p,i);
        state.history.unshift(result);
        state.processed++;
        successCount++;
        localStorage.setItem('cbProcessed',String(state.processed));
        $('#processedCount').textContent=state.processed;
        showResult(result,false);
        renderHistory();
      }catch(err){
        failed.push(file);
        console.error('File skipped after retry:',file.name,err);
      }

      state.batchIndex=i+1;
      $('#progressFill').style.width=`${((i+1)/batch.length)*100}%`;
      await sleep(30);
    }

    state.files=failed;
    renderQueue();

    if(successCount&&failed.length===0){
      toast(`${successCount} lagu berhasil dikonversi. Gunakan Download All ZIP atau download satu per satu.`);
      setEngineStatus(`Selesai · ${successCount} lagu berhasil dikonversi.`,true);
    }else if(successCount&&failed.length){
      toast(`${successCount} berhasil, ${failed.length} gagal. File gagal tetap di queue untuk dicoba ulang.`);
      setEngineStatus(`${successCount} berhasil · ${failed.length} perlu dicoba ulang.`,true);
    }else{
      toast('Tidak ada lagu yang berhasil. File tetap di queue untuk dicoba ulang.');
      setEngineStatus('Conversion gagal. Coba ulang atau refresh halaman.');
    }
  }catch(err){
    console.error('Batch conversion error:',err);
    state.files=batch;
    renderQueue();
    toast(`Engine belum siap: ${err?.message||err}`);
  }finally{
    state.isConverting=false;
    state.batchIndex=0;
    state.batchTotal=1;
    $('#convertBtnText').textContent=state.files.length?'Retry / Convert Queue':'Convert to Chipmunk OGG';
    $$('.preset').forEach(b=>b.disabled=false);
    $('#clearQueue').disabled=false;
    renderQueue();
    setTimeout(()=>{
      $('#progressBar').hidden=true;
      $('#progressFill').style.width='0%';
    },700);
  }
};

function showResult(x,scroll=true){
  $('#resultPanel').hidden=false;
  $('#editedChip').textContent=`EDITED · ${x.gainDb} DB`;
  $('#resultSpeed').textContent=`${x.speed}X`;
  $('#currentResult').innerHTML=`<div class="result-card"><div class="track-row"><div class="track-icon">♫</div><div><strong>${escapeHtml(x.title)}</strong><div>OGG · CHIPMUNK ${x.speed}X · ${x.gainDb} DB · ${formatMB(x.size)}</div></div></div><audio controls preload="metadata" src="${x.url}"></audio><a class="download-btn" href="${x.url}" download="${escapeHtml(x.title)}">⇩ &nbsp; Download Audio (.ogg)</a></div>`;
  if(scroll)$('#resultPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
}

function updateDownloadAllButton(){
  const count=state.history.length;
  if(!downloadAllBtn)return;
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

  state.history.forEach((x,i)=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${String(i+1).padStart(2,'0')}</td><td>${escapeHtml(x.title)}</td><td>${x.speed}x / ${x.gainDb} dB</td><td>${formatMB(x.size)}</td><td>${new Date(x.createdAt).toLocaleString('id-ID',{dateStyle:'short',timeStyle:'short'})}</td><td><a class="table-action" title="Download" href="${x.url}" download="${escapeHtml(x.title)}">⇩</a></td>`;
    body.appendChild(tr);
  });
  updateDownloadAllButton();
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
      await loadScript(src);
      if(window.JSZip)return window.JSZip;
    }catch(err){lastError=err;}
  }
  throw lastError||new Error('ZIP library gagal dimuat.');
}

function uniqueZipName(name,used){
  if(!used.has(name)){used.add(name);return name;}
  const dot=name.lastIndexOf('.');
  const base=dot>=0?name.slice(0,dot):name;
  const ext=dot>=0?name.slice(dot):'';
  let n=2;
  let candidate='';
  do{candidate=`${base} (${n++})${ext}`;}while(used.has(candidate));
  used.add(candidate);
  return candidate;
}

if(downloadAllBtn){
  downloadAllBtn.onclick=async()=>{
    if(!state.history.length||downloadAllBtn.disabled)return;
    const oldText=downloadAllBtn.textContent;
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
      const blob=await zip.generateAsync({type:'blob',compression:'STORE',streamFiles:true},metadata=>{
        downloadAllBtn.textContent=`Creating ZIP ${Math.round(metadata.percent)}%`;
      });
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;
      a.download=`central-blox-chipmunk-${new Date().toISOString().slice(0,10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      toast(`${state.history.length} hasil conversion dikemas dalam ZIP.`);
    }catch(err){
      console.error('ZIP error:',err);
      toast(`Gagal membuat ZIP: ${err?.message||err}`);
    }finally{
      downloadAllBtn.disabled=!state.history.length;
      downloadAllBtn.style.opacity=state.history.length?'1':'.35';
      downloadAllBtn.textContent=state.history.length?`⇩ Download All ZIP (${state.history.length})`:oldText;
    }
  };
}

$('#clearHistory').onclick=()=>{
  if(state.isConverting)return;
  state.history.forEach(x=>URL.revokeObjectURL(x.url));
  state.history=[];
  renderHistory();
  $('#resultPanel').hidden=true;
  toast('History dibersihkan.');
};

updatePresetUI();
renderQueue();
renderHistory();

if('requestIdleCallback' in window){
  requestIdleCallback(()=>{void warmEngine();},{timeout:1800});
}else{
  setTimeout(()=>{void warmEngine();},700);
}
