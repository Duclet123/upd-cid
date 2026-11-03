const MDT_SCREENSHOT_FIELDS={
  reports:[['reportNo','Report ID'],['title','Title'],['eventDate','Date'],['mdtOfficer','Authoring officer'],['mdtLocation','Location'],['summary','Report text',true]],
  citizens:[['citizenId','Citizen ID'],['fullName','Full name'],['phone','Phone'],['dob','Date of birth'],['gender','Gender'],['notes','Notes',true]]
};

function mdtScreenshotDate(value){
  const text=String(value||'').trim();
  let iso=text;
  const numeric=text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if(numeric)iso=numeric[3]+'-'+numeric[2].padStart(2,'0')+'-'+numeric[1].padStart(2,'0');
  const written=text.match(/^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if(written){
    const month='JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ').indexOf(written[1].toUpperCase())+1;
    iso=written[3]+'-'+String(month).padStart(2,'0')+'-'+written[2].padStart(2,'0');
  }
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))return '';
  const date=new Date(iso+'T00:00:00Z');
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===iso?iso:'';
}

function parseMdtScreenshot(text){
  const lines=String(text||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const after=label=>{
    const index=lines.findIndex(line=>label.test(line));
    return index<0?'':lines[index+1]||'';
  };
  const header=lines.find(line=>/\bRECORD\b.*\bREP-[A-Z0-9-]+/i.test(line));
  const reportIds=[...new Set((text.match(/\bREP-[A-Z0-9]+-[A-Z0-9]+\b/gi)||[]).map(id=>id.toUpperCase()))];
  const blank={col:'',raw:text,refs:'',photoLinks:'',summary:'',notes:''};
  if(/citizen\s+identity/i.test(text)){
    const idIndex=lines.findIndex((line,i)=>/^(?=[A-Z0-9]{8}$)(?=.*[A-Z])(?=.*\d)[A-Z0-9]+$/.test(line)&&/^[A-Z][A-Z .'-]+$/.test(lines[i-1]||''));
    const dob=lines.find(line=>/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(line));
    const phoneIndex=lines.findIndex(line=>/^PHONE\b/i.test(line));
    const phone=phoneIndex<0?'':lines.slice(phoneIndex+1,phoneIndex+6).find(line=>/^\+?[0-9][0-9 -]{6,16}$/.test(line))||'';
    const notes=lines.filter(line=>/weapon license|driver license|^valid$|^revoked$|motel|building| - manager| - employee/i.test(line)).join('\n');
    return {...blank,col:'citizens',citizenId:lines[idIndex]||'',fullName:lines[idIndex-1]||'',dob:mdtScreenshotDate(dob),phone,gender:lines.find(line=>/^(Female|Male|Other)$/i.test(line))||'',notes,refs:reportIds.join(', ')};
  }
  if(header){
    const titleStart=lines.indexOf(header)+1;
    const locationIndex=lines.findIndex(line=>/primary location/i.test(line));
    const officerIndex=lines.findIndex(line=>/authoring officer/i.test(line));
    const dateIndex=lines.findIndex(line=>/date of report/i.test(line));
    const headerEnd=Math.max(titleStart,locationIndex+1,officerIndex+1,dateIndex+1);
    let bodyStart=lines.findIndex((line,index)=>index>headerEnd&&line.length>=25&&/[Α-Ωα-ω]{3}/.test(line));
    if(bodyStart<0)bodyStart=lines.findIndex((line,index)=>index>headerEnd&&line.length>=55&&line.split(/\s+/).length>=8);
    const section=lines.findIndex((line,index)=>index>bodyStart&&/involved officers|attached citizens|photographic evidence/i.test(line));
    const date=lines.map(mdtScreenshotDate).find(Boolean)||'';
    const citizenSection=lines.findIndex(line=>/attached citizens|involved citizens/i.test(line));
    const remaining=citizenSection<0?[]:lines.slice(citizenSection+1);
    const nextSection=remaining.findIndex(line=>/involved officers|photographic evidence|attached files|da presence/i.test(line));
    const refs=remaining.slice(0,nextSection<0?undefined:nextSection).join(' ').match(/\b(?=[A-Z0-9]{8}\b)(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]+\b/g)||[];
    return {...blank,col:'reports',reportNo:reportIds[0]||'',title:lines.slice(titleStart,locationIndex<0?titleStart+2:locationIndex).filter(line=>!/(classified|amend|delete)/i.test(line)).join(' '),mdtLocation:after(/primary location/i),mdtOfficer:officerIndex<0?'':lines.slice(officerIndex+1,officerIndex+4).find(line=>/^[A-Z][a-z]+(?: [A-Z][a-z]+)+$/.test(line))||'',eventDate:date,summary:bodyStart<0?'':lines.slice(bodyStart,section>bodyStart?section:undefined).join('\n'),refs:[...new Set(refs)].join(', ')};
  }
  return blank;
}

function mergeMdtScreenshotText(first,second){
  const before=String(first||'').trim().split('\n'),after=String(second||'').trim().split('\n');
  if(!first)return second;
  if(!second)return first;
  const normalize=line=>line.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  for(let size=Math.min(before.length,after.length);size>0;size--){
    if(before.slice(-size).map(normalize).join('\n')===after.slice(0,size).map(normalize).join('\n'))return [...before,...after.slice(size)].join('\n');
  }
  return first+'\n\n'+second;
}

let mdtOcrLibrary;
function loadMdtOcr(){
  if(window.Tesseract)return Promise.resolve(window.Tesseract);
  if(!mdtOcrLibrary)mdtOcrLibrary=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    script.onload=()=>window.Tesseract?resolve(window.Tesseract):reject(Error('OCR library unavailable.'));
    script.onerror=()=>reject(Error('Could not load OCR. Check your connection and try again.'));
    document.head.appendChild(script);
  }).catch(error=>{mdtOcrLibrary=null;throw error;});
  return mdtOcrLibrary;
}

function createMdtScreenshotImport(){
  return {
    props:{saveBatch:Function,canEdit:Function},
    data(){return {open:false,processing:false,saving:false,stop:false,files:[],drafts:[],selected:null,progress:'',error:'',result:'',urls:[]};},
    computed:{
      fields(){return MDT_SCREENSHOT_FIELDS[this.selected?.col]||[];},
      ready(){return this.drafts.filter(draft=>draft.reviewed&&!draft.saved&&this.canEdit(draft.col));},
      canAttachContinuation(){
        const previous=this.drafts[this.drafts.indexOf(this.selected)-1];
        return this.selected&&!this.selected.col&&previous?.col==='reports'&&!previous.saved;
      }
    },
    beforeUnmount(){this.stop=true;this.urls.forEach(url=>URL.revokeObjectURL(url));},
    methods:{
      queue(event){
        this.files=[...event.target.files].sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
        this.error='';event.target.value='';
      },
      async scan(){
        if(!this.files.length||this.processing)return;
        this.processing=true;this.stop=false;this.error='';this.result='';
        let worker,processed=0;
        try{
          this.progress='Loading Greek and English OCR…';
          const ocr=await loadMdtOcr();
          worker=await ocr.createWorker(['eng','ell'],1,{logger:message=>{
            if(message.status==='recognizing text')this.progress=this.currentFile+' · '+Math.round(message.progress*100)+'%';
          }});
          await worker.setParameters({tessedit_pageseg_mode:11});
          let previous=null;
          for(let index=0;index<this.files.length&&!this.stop;index++){
            const file=this.files[index];
            this.currentFile=(index+1)+' / '+this.files.length+' · '+file.name;
            this.progress=this.currentFile;
            const url=URL.createObjectURL(file);this.urls.push(url);
            let data,scanError='';
            try{({data}=await worker.recognize(file));}catch(error){scanError=error.message||'Could not read this image.';}
            const draft=parseMdtScreenshot(data?.text||'');
            draft.pages=[{url,name:file.name}];draft.confidence=data?.confidence??0;draft.scanError=scanError;
            draft.reviewed=false;draft.saved=false;draft.error='';
            const sameReport=draft.col==='reports'&&draft.reportNo&&previous?.reportNo===draft.reportNo&&!previous.saved;
            if(sameReport){
              previous.summary=mergeMdtScreenshotText(previous.summary,draft.summary);
              previous.raw=mergeMdtScreenshotText(previous.raw,draft.raw);
              previous.refs=[...new Set([previous.refs,draft.refs].flatMap(value=>value.split(', ')).filter(Boolean))].join(', ');
              for(const [key] of MDT_SCREENSHOT_FIELDS.reports)if(!previous[key]&&draft[key])previous[key]=draft[key];
              previous.pages.push(...draft.pages);previous.reviewed=false;
            }else{
              this.drafts.push(draft);previous=this.drafts.at(-1);
              if(!this.selected)this.selected=previous;
            }
            processed++;
          }
          this.progress=this.stop?'Scan stopped. Drafts already read are available.':'Scan complete. Review each draft before saving.';
          this.files=this.files.slice(processed);
        }catch(error){this.error=error.message||'OCR failed.';}
        finally{try{await worker?.terminate();}catch{}this.processing=false;}
      },
      attachContinuation(){
        const index=this.drafts.indexOf(this.selected);
        const previous=this.drafts[index-1];
        if(!previous||previous.col!=='reports'||previous.saved||this.selected.col)return;
        previous.summary=mergeMdtScreenshotText(previous.summary,this.selected.raw);
        previous.raw=mergeMdtScreenshotText(previous.raw,this.selected.raw);
        previous.pages.push(...this.selected.pages);previous.reviewed=false;
        this.drafts.splice(index,1);this.selected=previous;
      },
      reviewAndNext(){
        this.selected.reviewed=true;
        const index=this.drafts.indexOf(this.selected);
        this.selected=this.drafts.slice(index+1).find(draft=>!draft.saved&&!draft.reviewed)||
          this.drafts.find(draft=>!draft.saved&&!draft.reviewed)||this.selected;
      },
      async save(){
        if(!this.ready.length||this.saving||this.processing)return;
        this.saving=true;this.error='';
        try{this.result=await this.saveBatch(this.ready);}
        catch(error){this.error=error.message||'Unable to save drafts.';}
        finally{this.saving=false;}
      },
      close(){if(!this.processing&&!this.saving)this.open=false;}
    },
    template:`
      <button type="button" class="btn text-base" @click="open=true"><i class="fa-solid fa-images mr-2"></i>Import screenshots</button>
      <Teleport to="body">
        <div v-if="open" class="fixed inset-0 z-[105] bg-black/80 flex items-center justify-center p-2 md:p-5" @keydown.esc.stop="close">
          <section role="dialog" aria-modal="true" aria-label="Import MDT screenshots" class="hud w-full max-w-7xl max-h-[94vh] overflow-auto p-4 md:p-6 space-y-4">
            <header class="flex items-center justify-between gap-3"><h2 class="text-lg font-bold text-white">Import MDT screenshots</h2><button class="record-action" :disabled="processing||saving" @click="close">Close</button></header>
            <p class="text-sm text-slate-400">Choose multiple screenshots. Files are read in filename order in this browser. Review the drafts before saving.</p>
            <div class="flex flex-wrap items-center gap-3">
              <input type="file" accept="image/png,image/jpeg,image/webp" multiple @change="queue" :disabled="processing||saving" aria-label="MDT screenshots" class="text-sm max-w-full">
              <button class="btn" @click="scan" :disabled="processing||saving||!files.length">Read {{ files.length||'' }} screenshots</button>
              <button v-if="processing" class="record-action" @click="stop=true">Stop after current image</button>
            </div>
            <p role="status" class="text-sm text-slate-300">{{ progress }}</p><p v-if="error" role="alert" class="text-red-300">{{ error }}</p>
            <div v-if="drafts.length" class="grid md:grid-cols-[minmax(14rem,1fr)_minmax(0,3fr)] gap-4">
              <nav class="space-y-2 max-h-[60vh] overflow-auto" aria-label="Import drafts">
                <button v-for="(draft,index) in drafts" :key="index" class="block w-full text-left p-3 rounded-lg border" :class="draft===selected?'border-purple-500 bg-purple-950/30':'border-purple-950'" @click="selected=draft">
                  <span class="block font-bold">{{ draft.reportNo||draft.citizenId||draft.pages[0].name }}</span>
                  <span class="text-xs text-slate-400">{{ draft.saved?'Saved':draft.reviewed?'Reviewed':draft.col||'Needs classification' }}</span>
                  <span v-if="draft.error||!draft.col||(draft.col&&MDT_SCREENSHOT_FIELDS[draft.col].some(([key])=>key!=='notes'&&!draft[key]))" class="ml-2 text-red-400" aria-label="Needs attention">❗</span>
                </button>
              </nav>
              <div v-if="selected" class="grid xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4 items-start min-w-0">
                <div class="space-y-3 min-w-0">
                <fieldset :disabled="selected.saved||saving" class="space-y-4">
                  <label class="block text-sm">Registry<select v-model="selected.col" @change="selected.reviewed=false" class="inp mt-1"><option value="">Choose registry</option><option value="reports">MDT Reports</option><option value="citizens">Citizen Registry</option></select></label>
                  <p v-if="selected.scanError||selected.confidence<80" class="text-red-300 text-sm">❗ {{ selected.scanError||'Low OCR confidence. Compare with the screenshot.' }}</p>
                  <p v-if="selected.col&&!canEdit(selected.col)" class="text-red-300 text-sm">❗ Edit permission is required for this registry.</p>
                  <button v-if="canAttachContinuation" type="button" class="record-action" @click="attachContinuation">Attach as continuation of previous report</button>
                  <div class="grid sm:grid-cols-2 gap-3">
                    <label v-for="[key,label,multiline] in fields" :key="key" :class="multiline?'sm:col-span-2':''" class="text-sm">
                      {{ label }} <span v-if="key!=='notes'&&!selected[key]" class="text-red-400" aria-label="Missing value">❗</span>
                      <textarea v-if="multiline" v-model="selected[key]" class="inp mt-1" rows="6"></textarea>
                      <input v-else v-model.trim="selected[key]" :type="['dob','eventDate'].includes(key)?'date':'text'" class="inp mt-1">
                    </label>
                  </div>
                  <label v-if="selected.col" class="block text-sm">{{ selected.col==='reports'?'Attached Citizen IDs':'Related Report IDs' }}<input v-model="selected.refs" class="inp mt-1" placeholder="Separate IDs with commas"></label>
                  <label v-if="selected.col==='reports'" class="block text-sm">Photo links<textarea v-model="selected.photoLinks" class="inp mt-1" rows="2" placeholder="One image URL per line"></textarea></label>
                  <label v-if="selected.col" class="flex gap-2 items-center text-sm"><input type="checkbox" v-model="selected.reviewed"> I reviewed this draft against the screenshots</label>
                  <button v-if="selected.col&&canEdit(selected.col)&&!selected.saved" type="button" class="record-action" @click="reviewAndNext">Mark reviewed &amp; next</button>
                </fieldset>
                <p v-if="selected.error" role="alert" class="text-red-300 text-sm">❗ {{ selected.error }}</p>
                </div>
                <details open class="text-sm min-w-0"><summary class="cursor-pointer text-tc">Source screenshots ({{ selected.pages.length }}) and OCR text</summary><div class="flex flex-wrap gap-3 mt-2"><a v-for="page in selected.pages" :key="page.url" :href="page.url" target="_blank" rel="noopener"><img :src="page.url" :alt="page.name" class="max-h-56 max-w-full rounded"></a></div><pre class="whitespace-pre-wrap break-words max-h-64 overflow-auto text-xs text-slate-400 mt-3">{{ selected.raw }}</pre></details>
              </div>
            </div>
            <footer class="sticky bottom-0 bg-panel border-t border-purple-950 py-3 flex flex-wrap items-center gap-3"><button class="btn" @click="save" :disabled="processing||saving||!ready.length">{{ saving?'Saving…':'Save reviewed drafts ('+ready.length+')' }}</button><p role="status" class="text-sm">{{ result }}</p></footer>
          </section>
        </div>
      </Teleport>`,
    setup(){return {MDT_SCREENSHOT_FIELDS};}
  };
}
