const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const PRESETS={'2.3':{speed:2.3,gainDb:-4},'2.5':{speed:2.5,gainDb:-6},'2.7':{speed:2.7,gainDb:-8}};
const state={preset:'2.5',files:[],history:[],ffmpeg:null,enginePromise:null,processed:Number(localStorage.getItem('cbProcessed')||0)};
$('#processedCount').textContent=state.processed;
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(window.__toastTimer);window.__toastTimer=setTimeout(()=>t.classList.remove('show'),3200)}
function updatePresetUI(){const p=PRESETS[state.preset];$('#activePresetLabel').textContent=`${p.speed}X / ${p.gainDb} DB`;}
$$('.preset').forEach(b=>b.onclick=()=>{state.preset=b.dataset.preset;$$('.preset').forEach(x=>x.classList.toggle('active',x===b));updatePresetUI();});

const input=$('#fileInput'),drop=$('#dropzone'),convertBtn=$('#convertBtn');
drop.onclick=()=>input.click();
drop.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();input.click();}};
drop.ondragover=e=>{e.preventDefault();drop.classList.add('dragging')};
drop.ondragleave=()=>drop.classList.remove('dragging');
drop.ondrop=e=>{e.preventDefault();drop.classList.remove('dragging');addFiles([...e.dataTransfer.files]);void warmEngine();};
input.onchange=()=>{addFiles([...input.files]);input.value='';void warmEngine();};
function validAudio(f){return /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(f.name)||f.type.startsWith('audio/')}
function addFiles(files){const valid=files.filter(validAudio);state.files.push(...valid);renderQueue();if(valid.length!==files.length)toast('Sebagian file bukan format audio yang didukung.');}
function renderQueue(){const q=$('#queue'),list=$('#queueList');q.hidden=!state.files.length;convertBtn.disabled=!state.files.length;$('#selectedCount').textContent=`${state.files.length} file${state.files.length===1?'':'s'} selected`;$('#queueSubtext').textContent=state.files.length?`${state.files.length} audio ready to convert`:'Ready to convert';list.innerHTML='';state.files.forEach((f,i)=>{const d=document.createElement('div');d.className='queue-item';d.innerHTML=`<span title="${escapeHtml(f.name)}">${escapeHtml(f.name)} <small>(${(f.size/1024/1024).toFixed(2)} MB)</small></span><button aria-label="Remove ${escapeHtml(f.name)}">×</button>`;d.querySelector('button').onclick=e=>{e.stopPropagation();state.files.splice(i,1);renderQueue()};list.appendChild(d)});}
function escapeHtml(value){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
$('#clearQueue').onclick=()=>{state.files=[];renderQueue()};

const FFMPEG_CACHE='cb-ffmpeg-engine-v1';
async function cachedBlobURL(url,mime){
  try{
    if('caches' in window){
      const cache=await caches.open(FFMPEG_CACHE);
      let response=await cache.match(url);
      if(!response){
        response=await fetch(url,{mode:'cors',cache:'force-cache'});
        if(!response.ok)throw new Error(`HTTP ${response.status}`);
        await cache.put(url,response.clone());
      }
      const blob=await response.blob();
      return URL.createObjectURL(new Blob([blob],{type:mime}));
    }
  }catch(err){
    console.warn('FFmpeg persistent cache fallback:',err);
  }
  const util=window.FFmpegUtil||{};
  if(!util.toBlobURL)throw new Error('FFmpeg utility tidak tersedia.');
  return util.toBlobURL(url,mime);
}

async function getEngine(){
  if(state.ffmpeg)return state.ffmpeg;
  if(state.enginePromise)return state.enginePromise;

  state.enginePromise=(async()=>{
    const {FFmpeg}=window.FFmpegWASM||{};
    if(!FFmpeg)throw new Error('Audio engine gagal dimuat. Refresh halaman dan coba lagi.');

    const ffmpeg=new FFmpeg();
    ffmpeg.on('progress',({progress})=>{
      $('#progressFill').style.width=`${Math.max(0,Math.min(100,progress*100))}%`;
    });

    $('#engineStatus').innerHTML='<span class="engine-dot"></span> Menyiapkan audio engine di background...';

    const workerURL='https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js';
    const coreBase='https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd';

    const [classWorkerURL,coreURL,wasmURL]=await Promise.all([
      cachedBlobURL(workerURL,'text/javascript'),
      cachedBlobURL(`${coreBase}/ffmpeg-core.js`,'text/javascript'),
      cachedBlobURL(`${coreBase}/ffmpeg-core.wasm`,'application/wasm')
    ]);

    await ffmpeg.load({classWorkerURL,coreURL,wasmURL});

    state.ffmpeg=ffmpeg;
    $('#engineStatus').innerHTML='<span class="engine-dot" style="background:#3ee2d5;box-shadow:0 0 8px rgba(62,226,213,.5)"></span> Audio engine ready · 48 kHz / Vorbis q5.';
    return ffmpeg;
  })();

  try{
    return await state.enginePromise;
  }catch(err){
    console.error('FFmpeg load error:',err);
    state.ffmpeg=null;
    state.enginePromise=null;
    $('#engineStatus').innerHTML='<span class="engine-dot"></span> Audio engine gagal dimuat.';
    throw new Error(`FFmpeg gagal dimuat: ${err?.message||err}`);
  }
}

async function warmEngine(){
  try{await getEngine()}catch(err){console.warn('Background FFmpeg preload gagal:',err)}
}

async function convertOne(file,p,index){const ffmpeg=await getEngine();const {fetchFile}=window.FFmpegUtil;const ext=(file.name.split('.').pop()||'bin').replace(/[^a-z0-9]/gi,'');const id=`${Date.now()}-${index}`;const inputName=`input-${id}.${ext}`;const outputName=`output-${id}.ogg`;await ffmpeg.writeFile(inputName,await fetchFile(file));const rate=Math.round(48000*p.speed);await ffmpeg.exec(['-y','-i',inputName,'-vn','-af',`aresample=48000,asetrate=${rate},aresample=48000,volume=${p.gainDb}dB`,'-ar','48000','-ac','2','-c:a','libvorbis','-q:a','5',outputName]);const data=await ffmpeg.readFile(outputName);await ffmpeg.deleteFile(inputName).catch(()=>{});await ffmpeg.deleteFile(outputName).catch(()=>{});const blob=new Blob([data.buffer],{type:'audio/ogg'});return{title:`${p.speed}x-${file.name.replace(/\.[^.]+$/,'')}.ogg`,speed:p.speed,gainDb:p.gainDb,size:blob.size,createdAt:Date.now(),url:URL.createObjectURL(blob)}}

convertBtn.onclick=async()=>{if(!state.files.length)return;const batch=[...state.files],p=PRESETS[state.preset];convertBtn.disabled=true;$('#progressBar').hidden=false;try{await getEngine();for(let i=0;i<batch.length;i++){$('#convertBtnText').textContent=`Processing ${i+1} of ${batch.length}`;$('#progressFill').style.width='0%';const result=await convertOne(batch[i],p,i);state.history.unshift(result);state.processed++;localStorage.setItem('cbProcessed',String(state.processed));$('#processedCount').textContent=state.processed;showResult(result);renderHistory();}state.files=[];renderQueue();toast('Semua audio selesai dikonversi.')}catch(err){console.error(err);toast(err.message||'Conversion gagal.')}finally{$('#convertBtnText').textContent='Convert to Chipmunk OGG';convertBtn.disabled=!state.files.length;$('#progressFill').style.width='100%';setTimeout(()=>{$('#progressBar').hidden=true;$('#progressFill').style.width='0%'},450)}};

function showResult(x){$('#resultPanel').hidden=false;$('#editedChip').textContent=`EDITED · ${x.gainDb} DB`;$('#resultSpeed').textContent=`${x.speed}X`;$('#currentResult').innerHTML=`<div class="result-card"><div class="track-row"><div class="track-icon">♫</div><div><strong>${escapeHtml(x.title)}</strong><div>OGG · CHIPMUNK ${x.speed}X · ${x.gainDb} DB · ${(x.size/1024/1024).toFixed(2)} MB</div></div></div><audio controls preload="metadata" src="${x.url}"></audio><a class="download-btn" href="${x.url}" download="${escapeHtml(x.title)}">⇩ &nbsp; Download Audio (.ogg)</a></div>`;$('#resultPanel').scrollIntoView({behavior:'smooth',block:'nearest'});}
function renderHistory(){const body=$('#historyBody');body.innerHTML='';$('#historyCount').textContent=`${state.history.length} ${state.history.length===1?'entry':'entries'}`;$('#emptyHistory').hidden=!!state.history.length;state.history.forEach((x,i)=>{const tr=document.createElement('tr');tr.innerHTML=`<td>${String(i+1).padStart(2,'0')}</td><td>${escapeHtml(x.title)}</td><td>${x.speed}x / ${x.gainDb} dB</td><td>${(x.size/1024/1024).toFixed(2)} MB</td><td>${new Date(x.createdAt).toLocaleString('id-ID',{dateStyle:'short',timeStyle:'short'})}</td><td><a class="table-action" title="Download" href="${x.url}" download="${escapeHtml(x.title)}">⇩</a></td>`;body.appendChild(tr)});}
$('#clearHistory').onclick=()=>{state.history.forEach(x=>URL.revokeObjectURL(x.url));state.history=[];renderHistory();$('#resultPanel').hidden=true;toast('History dibersihkan.');};

updatePresetUI();renderQueue();renderHistory();

// Mulai download + inisialisasi FFmpeg ketika browser sedang idle,
// sehingga waktu tunggu dipindahkan sebelum user menekan tombol Convert.
if('requestIdleCallback' in window){
  requestIdleCallback(()=>{void warmEngine()},{timeout:1800});
}else{
  setTimeout(()=>{void warmEngine()},700);
}
