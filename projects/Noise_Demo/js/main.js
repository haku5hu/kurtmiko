// main.js - WebAudio demo with two noise channels and modular LFOs
let audioCtx = null
let analyser = null
let dataArray = null
let rafId = null
const canvas = document.getElementById('analyser')
const canvasCtx = canvas && canvas.getContext('2d')

let noiseBuffer = null
const noiseSources = [null, null]
const filters = [null, null]
const filter2s = [null, null] // second filter per channel
const gains = [null, null]
let masterGain = null
let workletReady = false

// LFO structure per channel: [[lfo0, lfo1], [lfo0, lfo1]]
const lfos = [[],[]]

// Visualization canvases per LFO (populated from DOM)
const lfoCanvases = {}

// Store base gain values per channel for multiplicative modulation
const baseGains = [0.5, 0.5]

// Store Filter 2 parameter base values for modulation
const filter2BaseParams = [
  {freq: 2000, q: 1, gain: 0},
  {freq: 2000, q: 1, gain: 0}
]

function createNoiseBuffer(duration = 2){
  const sampleRate = audioCtx.sampleRate
  const length = Math.floor(sampleRate * duration)
  const buffer = audioCtx.createBuffer(1, length, sampleRate)
  const data = buffer.getChannelData(0)
  for(let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
  return buffer
}

// exponential mapping for LFO frequency slider: slider 0..1000 -> freq [minHz..maxHz]
function sliderToFreq(sliderVal, minHz = 0.01, maxHz = 20){
  const t = sliderVal / 1000
  return minHz * Math.pow(maxHz / minHz, t)
}

function freqToSlider(freq, minHz = 0.01, maxHz = 20){
  const t = Math.log(freq / minHz) / Math.log(maxHz / minHz)
  return Math.max(0, Math.min(1000, Math.round(t * 1000)))
}

function createLFO(ch, index, opts = {}){
  // opts: {wave:'sine'|'square'|'sawtooth'|'triangle'|'sample', freqHz, depth}
  const lfo = {ch, index, wave: opts.wave || 'sine', freqHz: opts.freqHz || 1, depth: opts.depth || 0, dest: 'none'}

  // depthGain scales -1..1 LFO output into units (e.g. Hz or gain)
  lfo.depthGain = null
  lfo.source = null
  lfo.workletNode = null
  lfo.analyser = null
  lfo.monitorGain = null

  function makeOscillator(freq, type){
    const osc = audioCtx.createOscillator()
    osc.type = type
    osc.frequency.value = freq
    const depthGain = audioCtx.createGain()
    depthGain.gain.value = lfo.depth
    osc.connect(depthGain)

    // monitor chain for visualization
    const monitorGain = audioCtx.createGain()
    monitorGain.gain.value = 1
    osc.connect(monitorGain)
    const analyserNode = audioCtx.createAnalyser()
    analyserNode.fftSize = 128
    monitorGain.connect(analyserNode)

    osc.start()
    return {source: osc, depthGain, monitorGain, analyserNode}
  }

  function makeConstantSample(){
    const cs = audioCtx.createConstantSource()
    cs.offset.value = 0
    const depthGain = audioCtx.createGain()
    depthGain.gain.value = lfo.depth
    cs.connect(depthGain)

    const monitorGain = audioCtx.createGain()
    monitorGain.gain.value = 1
    cs.connect(monitorGain)
    const analyserNode = audioCtx.createAnalyser()
    analyserNode.fftSize = 128
    monitorGain.connect(analyserNode)

    cs.start()
    return {source: cs, depthGain, monitorGain, analyserNode}
  }

  async function makeWorkletSample(){
    if(!workletReady) return null
    try{
      const wn = new AudioWorkletNode(audioCtx, 'sample-hold')
      wn.port.postMessage({freq: lfo.freqHz})
      const depthGain = audioCtx.createGain()
      depthGain.gain.value = lfo.depth
      wn.connect(depthGain)

      const monitorGain = audioCtx.createGain()
      monitorGain.gain.value = 1
      wn.connect(monitorGain)
      const analyserNode = audioCtx.createAnalyser()
      analyserNode.fftSize = 128
      monitorGain.connect(analyserNode)

      return {source: wn, depthGain, monitorGain, analyserNode}
    }catch(e){
      console.warn('Worklet not ready, falling back to ConstantSource', e)
      return null
    }
  }

  function setupSource(){
    // clean old
    if(lfo.source){
      try{ lfo.source.stop && lfo.source.stop() }catch(e){}
      try{ lfo.source.disconnect() }catch(e){}
    }

    if(lfo.wave === 'sample' && workletReady){
      makeWorkletSample().then(s=>{
        if(s){
          lfo.source = s.source
          lfo.depthGain = s.depthGain
          lfo.monitorGain = s.monitorGain
          lfo.analyser = s.analyserNode
          updateLfoDestination(lfo)
        }else{
          // fallback to constant source
          const s = makeConstantSample()
          lfo.source = s.source
          lfo.depthGain = s.depthGain
          lfo.monitorGain = s.monitorGain
          lfo.analyser = s.analyserNode
          updateLfoDestination(lfo)
        }
      })
    }else if(lfo.wave === 'sample'){
      // fallback: use constant source
      const s = makeConstantSample()
      lfo.source = s.source
      lfo.depthGain = s.depthGain
      lfo.monitorGain = s.monitorGain
      lfo.analyser = s.analyserNode
    }else{
      const s = makeOscillator(lfo.freqHz, lfo.wave)
      lfo.source = s.source
      lfo.depthGain = s.depthGain
      lfo.monitorGain = s.monitorGain
      lfo.analyser = s.analyserNode
    }
  }

  lfo.setWave = (wave)=>{
    lfo.wave = wave
    if(!audioCtx) return
    setupSource()
    // reattach destination if present
    updateLfoDestination(lfo)
  }

  lfo.setFreq = (freqHz)=>{
    lfo.freqHz = freqHz
    if(!audioCtx) return
    if(lfo.source && lfo.source.frequency) lfo.source.frequency.value = freqHz
    if(lfo.source && lfo.source.port && lfo.wave === 'sample'){
      // worklet node
      lfo.source.port.postMessage({freq: freqHz})
    }
  }

  lfo.setDepth = (d)=>{
    lfo.depth = d
    if(lfo.depthGain){
      if(lfo.dest === 'gain'){
        // scale depth for gain destination: map 0..2000 to -1..2
        const scaledDepth = (d / 2000) * 3 - 1
        lfo.depthGain.gain.value = scaledDepth
      }else{
        // for HP or other destinations, use depth as-is
        lfo.depthGain.gain.value = d
      }
    }
  }

  lfo.setDest = (dest)=>{
    lfo.dest = dest
    updateLfoDestination(lfo)
  }

  lfo.getAnalyser = ()=> lfo.analyser

  lfo.disconnect = ()=>{
    try{ lfo.depthGain && lfo.depthGain.disconnect() }catch(e){}
  }

  // initialize source nodes (only when audioCtx exists)
  if(audioCtx) setupSource()

  return lfo
}

function updateLfoDestination(lfo){
  // disconnect existing
  try{ lfo.depthGain && lfo.depthGain.disconnect() }catch(e){}
  const ch = lfo.ch
  if(lfo.dest === 'hp' && filters[ch]){
    // additive: depth adds to HP frequency (Hz)
    lfo.depthGain.gain.value = lfo.depth
    try{ lfo.depthGain.connect(filters[ch].frequency) }catch(e){}
  }else if(lfo.dest === 'gain' && gains[ch]){
    // multiplicative: LFO (-1..1) * depth scales the gain
    // depth is 0..2000, but for gain modulation we want to scale it to -1..2 range
    // so: depthGain.gain.value = (depth / 2000) * 3 - 1
    const scaledDepth = (lfo.depth / 2000) * 3 - 1
    lfo.depthGain.gain.value = scaledDepth
    try{ lfo.depthGain.connect(gains[ch].gain) }catch(e){}
  }else if(lfo.dest === 'f2freq' && filter2s[ch]){
    // additive: depth adds to filter2 frequency (Hz)
    lfo.depthGain.gain.value = lfo.depth
    try{ lfo.depthGain.connect(filter2s[ch].frequency) }catch(e){}
  }else if(lfo.dest === 'f2q' && filter2s[ch]){
    // additive: depth adds to filter2 Q (resonance)
    lfo.depthGain.gain.value = lfo.depth / 30  // normalize depth to reasonable Q range
    try{ lfo.depthGain.connect(filter2s[ch].Q) }catch(e){}
  }else if(lfo.dest === 'f2gain' && filter2s[ch]){
    // additive: depth adds to filter2 gain (in dB)
    lfo.depthGain.gain.value = lfo.depth / 2000 * 12  // scale to ±12dB range
    try{ lfo.depthGain.connect(filter2s[ch].gain) }catch(e){}
  }
  // update routing badge
  updateRoutingBadge(lfo)
}

function updateRoutingBadge(lfo){
  const badge = document.getElementById(`lfo${lfo.ch===0?'A':'B'}${lfo.index+1}-badge`)
  if(!badge) return
  if(lfo.dest === 'none'){
    badge.textContent = '—'
    badge.classList.remove('active')
  }else if(lfo.dest === 'hp'){
    badge.textContent = 'HP'
    badge.classList.add('active')
  }else if(lfo.dest === 'gain'){
    badge.textContent = 'Gain'
    badge.classList.add('active')
  }else if(lfo.dest === 'f2freq'){
    badge.textContent = 'F2ƒ'
    badge.classList.add('active')
  }else if(lfo.dest === 'f2q'){
    badge.textContent = 'F2Q'
    badge.classList.add('active')
  }else if(lfo.dest === 'f2gain'){
    badge.textContent = 'F2G'
    badge.classList.add('active')
  }
}

function initAudio(){
  if(audioCtx) return
  audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  masterGain = audioCtx.createGain()
  masterGain.gain.value = 0.9
  analyser = audioCtx.createAnalyser()
  analyser.fftSize = 2048
  masterGain.connect(analyser)
  analyser.connect(audioCtx.destination)
  dataArray = new Uint8Array(analyser.fftSize)
  noiseBuffer = createNoiseBuffer(2)

  // Load AudioWorklet for sample-and-hold if available
  audioCtx.audioWorklet.addModule('js/sample-hold-processor.js')
    .then(()=>{ workletReady = true })
    .catch(e=>{ console.warn('AudioWorklet not available, using fallback S&H', e) })

  // create LFO objects for both channels
  for(let ch=0; ch<2; ch++){
    lfos[ch] = []
    // store base gain
    baseGains[ch] = Number(document.getElementById(ch===0? 'gainA':'gainB').value)
    for(let i=0;i<2;i++){
      const prefix = (ch===0? 'lfoA': 'lfoB') + (i+1)
      // find initial wave selection if present
      const waveSel = document.getElementById(prefix + '-wave')
      const wave = waveSel ? waveSel.value : (i===0? 'sine':'sine')
      const freqEl = document.getElementById(prefix + '-freq')
      const freqHz = freqEl ? sliderToFreq(Number(freqEl.value)) : (i===0?1:0.25)
      const depthEl = document.getElementById(prefix + '-depth')
      const depth = depthEl ? Number(depthEl.value) : 0
      const l = createLFO(ch, i, {wave, freqHz, depth})
      lfos[ch][i] = l
      // populate canvas ref
      const cv = document.getElementById(prefix + '-canvas')
      if(cv) lfoCanvases[`${ch}-${i}`] = cv.getContext('2d')
    }
  }

  // Enable Kill Switch
  document.getElementById('btn-kill').disabled = false

  // start animation
  draw()
}

// Helper to show/hide filter2 control rows based on filter type
function updateFilter2ControlVisibility(ch){
  const typeId = ch===0? 'filter2A-type':'filter2B-type'
  const typeSelect = document.getElementById(typeId)
  if(!typeSelect) return
  const type = typeSelect.value
  const prefix = ch===0? 'filter2A':'filter2B'
  
  // Which controls to show/hide
  const showFreq = type !== 'none'
  const showQ = ['bandpass','notch','allpass','peaking'].includes(type)
  const showGain = ['peaking','lowshelf','highshelf'].includes(type)
  
  document.getElementById(`${prefix}-freq-row`).style.display = showFreq ? '' : 'none'
  document.getElementById(`${prefix}-q-row`).style.display = showQ ? '' : 'none'
  document.getElementById(`${prefix}-gain-row`).style.display = showGain ? '' : 'none'
}

function startChannel(i){
  if(!audioCtx) initAudio()
  if(noiseSources[i]) return // already running
  const src = audioCtx.createBufferSource()
  src.buffer = noiseBuffer
  src.loop = true
  const filt = audioCtx.createBiquadFilter()
  filt.type = 'highpass'
  const hpVal = Number(document.getElementById(i===0? 'hpA':'hpB').value)
  filt.frequency.value = hpVal
  src.connect(filt)
  
  // get filter2 type from select element
  const filter2TypeSelectId = i===0? 'filter2A-type':'filter2B-type'
  const filter2Type = document.getElementById(filter2TypeSelectId).value
  
  let prevNode = filt
  if(filter2Type !== 'none'){
    const filt2 = audioCtx.createBiquadFilter()
    filt2.type = filter2Type
    
    // get values from UI controls
    const freqVal = Number(document.getElementById(i===0? 'filter2A-freq':'filter2B-freq').value)
    const qVal = Number(document.getElementById(i===0? 'filter2A-q':'filter2B-q').value)
    const gainVal = Number(document.getElementById(i===0? 'filter2A-gain':'filter2B-gain').value)
    
    // apply frequency (all types have it)
    filt2.frequency.value = freqVal
    filter2BaseParams[i].freq = freqVal
    
    // apply Q if applicable
    if(['bandpass','notch','allpass','peaking'].includes(filter2Type)){
      filt2.Q.value = qVal
      filter2BaseParams[i].q = qVal
    }
    
    // apply gain if applicable
    if(['peaking','lowshelf','highshelf'].includes(filter2Type)){
      filt2.gain.value = gainVal
      filter2BaseParams[i].gain = gainVal
    }
    
    prevNode.connect(filt2)
    filter2s[i] = filt2
    prevNode = filt2
  }
  
  const g = audioCtx.createGain()
  const gainVal = Number(document.getElementById(i===0? 'gainA':'gainB').value)
  g.gain.value = gainVal
  prevNode.connect(g)
  g.connect(masterGain)
  src.start()
  noiseSources[i] = src
  filters[i] = filt
  gains[i] = g
  // attach LFO destinations for this channel
  for(let lf=0; lf<2; lf++){
    const l = lfos[i][lf]
    if(l && l.dest) updateLfoDestination(l)
  }
}

function stopChannel(i){
  const src = noiseSources[i]
  if(src){ try{ src.stop() }catch(e){}; try{ src.disconnect() }catch(e){}; noiseSources[i]=null }
  if(filters[i]){ try{ filters[i].disconnect() }catch(e){}; filters[i]=null }
  if(filter2s[i]){ try{ filter2s[i].disconnect() }catch(e){}; filter2s[i]=null }
  if(gains[i]){ try{ gains[i].disconnect() }catch(e){}; gains[i]=null }
  // ensure LFOs disconnected from params
  for(let lf=0; lf<2; lf++){
    const l = lfos[i][lf]
    if(l) try{ l.depthGain.disconnect() }catch(e){}
  }
}

function startNoise(){
  if(!audioCtx) initAudio()
  // start channels individually
  for(let i=0;i<2;i++){
    const enabled = document.getElementById(i===0? 'enableA':'enableB').checked
    if(enabled) startChannel(i)
  }
}

function stopNoise(){
  for(let i=0;i<2;i++) stopChannel(i)
}

function killAudio(){
  // Stop all noise
  for(let i=0;i<2;i++) stopChannel(i)
  // Close the audio context
  if(audioCtx && audioCtx.state !== 'closed'){
    audioCtx.close()
  }
  // Reset state
  audioCtx = null
  analyser = null
  dataArray = null
  noiseBuffer = null
  lfos[0] = []
  lfos[1] = []
  lfoCanvases = {}
  if(rafId) cancelAnimationFrame(rafId)
  rafId = null
  // Reset UI
  document.getElementById('btn-init').disabled = false
  document.getElementById('btn-kill').disabled = true
  document.getElementById('enableA').checked = false
  document.getElementById('enableB').checked = false
}

function drawLFOs(){
  // draw each LFO's analyser to its canvas
  for(let ch=0; ch<2; ch++){
    for(let lf=0; lf<2; lf++){
      const ctx = lfoCanvases[`${ch}-${lf}`]
      const l = lfos[ch] && lfos[ch][lf]
      if(!ctx || !l || !l.getAnalyser()) continue
      const an = l.getAnalyser()
      const buf = new Uint8Array(an.frequencyBinCount)
      an.getByteTimeDomainData(buf)
      const w = ctx.canvas.width, h = ctx.canvas.height
      // clear background to black
      ctx.fillStyle = '#000'
      ctx.fillRect(0,0,w,h)
      // draw grey grid lines (vertical dividers)
      ctx.strokeStyle = '#333'
      ctx.lineWidth = 1
      for(let i=1; i<8; i++){
        const x = (i * w) / 8
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
      }
      // draw horizontal centre line (amplitude midpoint)
      ctx.beginPath()
      ctx.moveTo(0, h/2)
      ctx.lineTo(w, h/2)
      ctx.stroke()
      // draw white waveform
      ctx.lineWidth = 1
      ctx.strokeStyle = '#fff'
      ctx.beginPath()
      const slice = w / buf.length
      let x = 0
      for(let i=0;i<buf.length;i++){
        const v = buf[i] / 128.0
        const y = v * h/2
        if(i===0) ctx.moveTo(x,y)
        else ctx.lineTo(x,y)
        x += slice
      }
      ctx.stroke()
    }
  }
}

function draw(){
  if(analyser && canvasCtx){
    analyser.getByteTimeDomainData(dataArray)
    // clear background to black
    canvasCtx.fillStyle = '#000'
    canvasCtx.fillRect(0,0,canvas.width,canvas.height)
    // draw grey grid lines (vertical dividers)
    canvasCtx.strokeStyle = '#333'
    canvasCtx.lineWidth = 1
    for(let i=1; i<16; i++){
      const x = (i * canvas.width) / 16
      canvasCtx.beginPath()
      canvasCtx.moveTo(x, 0)
      canvasCtx.lineTo(x, canvas.height)
      canvasCtx.stroke()
    }
    // draw horizontal centre line (amplitude midpoint)
    canvasCtx.beginPath()
    canvasCtx.moveTo(0, canvas.height/2)
    canvasCtx.lineTo(canvas.width, canvas.height/2)
    canvasCtx.stroke()
    // draw white waveform
    canvasCtx.lineWidth = 2
    canvasCtx.strokeStyle = '#fff'
    canvasCtx.beginPath()
    const sliceWidth = canvas.width * 1.0 / dataArray.length
    let x = 0
    for(let i=0;i<dataArray.length;i++){
      const v = dataArray[i] / 128.0
      const y = v * canvas.height/2
      if(i===0) canvasCtx.moveTo(x,y)
      else canvasCtx.lineTo(x,y)
      x += sliceWidth
    }
    canvasCtx.lineTo(canvas.width, canvas.height/2)
    canvasCtx.stroke()
  }
  drawLFOs()
  rafId = requestAnimationFrame(draw)
}

document.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('btn-init').addEventListener('click', initAudio)
  document.getElementById('btn-kill').addEventListener('click', killAudio)

  // enable toggles should start/stop channels immediately when playing
  document.getElementById('enableA').addEventListener('change', (e)=>{
    const isPlaying = document.getElementById('btn-kill').disabled === false
    if(isPlaying){
      if(e.target.checked) startChannel(0)
      else stopChannel(0)
    }
  })
  document.getElementById('enableB').addEventListener('change', (e)=>{
    const isPlaying = document.getElementById('btn-kill').disabled === false
    if(isPlaying){
      if(e.target.checked) startChannel(1)
      else stopChannel(1)
    }
  })

  // filter2 type changes should restart the channel and toggle control visibility
  document.getElementById('filter2A-type').addEventListener('change', (e)=>{
    updateFilter2ControlVisibility(0)
    const isPlaying = document.getElementById('btn-kill').disabled === false
    const isEnabled = document.getElementById('enableA').checked
    if(isPlaying && isEnabled){
      stopChannel(0)
      startChannel(0)
    }
  })
  document.getElementById('filter2B-type').addEventListener('change', (e)=>{
    updateFilter2ControlVisibility(1)
    const isPlaying = document.getElementById('btn-kill').disabled === false
    const isEnabled = document.getElementById('enableB').checked
    if(isPlaying && isEnabled){
      stopChannel(1)
      startChannel(1)
    }
  })

  function bindControl(id, displayId, cb, opts){
    const el = document.getElementById(id)
    const disp = document.getElementById(displayId)
    if(!el || !disp) return
    const update = ()=>{
      let v = el.value
      if(opts && opts.isFreq){
        const freq = sliderToFreq(Number(v), opts.minHz, opts.maxHz)
        disp.textContent = freq.toFixed(3)
        if(cb) cb(freq)
      }else{
        disp.textContent = (el.type==='range' && el.step && Number(el.step) < 1) ? Number(v).toFixed(2) : v
        if(cb) cb(Number(v))
      }
    }
    el.addEventListener('input', update)
    update()
  }

  bindControl('hpA','hpA-val', v=>{ if(filters[0]) filters[0].frequency.value = v })
  bindControl('hpB','hpB-val', v=>{ if(filters[1]) filters[1].frequency.value = v })
  bindControl('gainA','gainA-val', v=>{ if(gains[0]) gains[0].gain.value = v; baseGains[0]=v })
  bindControl('gainB','gainB-val', v=>{ if(gains[1]) gains[1].gain.value = v; baseGains[1]=v })

  // Filter 2 parameter bindings
  bindControl('filter2A-freq','filter2A-freq-val', v=>{ 
    if(filter2s[0]) filter2s[0].frequency.value = v
    filter2BaseParams[0].freq = v
  })
  bindControl('filter2B-freq','filter2B-freq-val', v=>{ 
    if(filter2s[1]) filter2s[1].frequency.value = v
    filter2BaseParams[1].freq = v
  })
  bindControl('filter2A-q','filter2A-q-val', v=>{ 
    if(filter2s[0]) filter2s[0].Q.value = v
    filter2BaseParams[0].q = v
  })
  bindControl('filter2B-q','filter2B-q-val', v=>{ 
    if(filter2s[1]) filter2s[1].Q.value = v
    filter2BaseParams[1].q = v
  })
  bindControl('filter2A-gain','filter2A-gain-val', v=>{ 
    if(filter2s[0]) filter2s[0].gain.value = v
    filter2BaseParams[0].gain = v
  })
  bindControl('filter2B-gain','filter2B-gain-val', v=>{ 
    if(filter2s[1]) filter2s[1].gain.value = v
    filter2BaseParams[1].gain = v
  })

  // LFO bindings
  function bindLFOControls(prefix, ch, lfIndex){
    // freq: slider 0..1000 -> exponential 0.01..20 Hz
    bindControl(`${prefix}-freq`, `${prefix}-freq-val`, v=>{
      const l = lfos[ch] && lfos[ch][lfIndex]
      if(l) l.setFreq(v)
    }, {isFreq:true, minHz:0.01, maxHz:20})

    bindControl(`${prefix}-depth`, `${prefix}-depth-val`, v=>{
      const l = lfos[ch] && lfos[ch][lfIndex]
      if(l) l.setDepth(v)
    })

    const waveSel = document.getElementById(`${prefix}-wave`)
    if(waveSel){
      waveSel.addEventListener('change', ()=>{
        const l = lfos[ch] && lfos[ch][lfIndex]
        if(l) l.setWave(waveSel.value)
      })
    }

    const destSel = document.getElementById(`${prefix}-dest`)
    if(destSel){
      destSel.addEventListener('change', ()=>{
        const l = lfos[ch] && lfos[ch][lfIndex]
        if(l) l.setDest(destSel.value)
      })
    }
  }

  // initialize LFO controls (also set slider positions to map to default freq)
  ['lfoA1','lfoA2','lfoB1','lfoB2'].forEach(prefix=>{
    const freqEl = document.getElementById(prefix + '-freq')
    if(freqEl){
      // if current value looks like a frequency (<=100), map it to slider scale
      const cur = Number(freqEl.value)
      if(cur > 0 && cur <= 100){
        const slider = freqToSlider(cur)
        freqEl.value = slider
      }
    }
  })

  bindLFOControls('lfoA1', 0, 0)
  bindLFOControls('lfoA2', 0, 1)
  bindLFOControls('lfoB1', 1, 0)
  bindLFOControls('lfoB2', 1, 1)

  // waveform selects: set default options if not present
  ;['lfoA1','lfoA2','lfoB1','lfoB2'].forEach(prefix=>{
    const sel = document.getElementById(prefix + '-wave')
    if(sel){
      // noop; options defined in HTML
    }
  })

  // Initialize routing badges
  for(let ch=0; ch<2; ch++){
    for(let lf=0; lf<2; lf++){
      const l = lfos[ch] && lfos[ch][lf]
      if(l) updateRoutingBadge(l)
    }
  }

  // Initialize filter2 control visibility
  updateFilter2ControlVisibility(0)
  updateFilter2ControlVisibility(1)
  
  // convert visible range sliders into dial UI widgets
  initKnobs()
})

// Knob helper: convert each input[type=range] into an interactive dial
function initKnobs(){
  const ranges = Array.from(document.querySelectorAll('input[type=range]'))
  ranges.forEach(range=>{
    // wrap only if not already processed
    if(range.dataset.knob === '1') return
    range.dataset.knob = '1'
    // create knob element
    const wrapper = document.createElement('div')
    wrapper.className = 'dial-wrapper'
    const knob = document.createElement('div')
    knob.className = 'knob'
    // numeric display
    const val = document.createElement('div')
    val.className = 'value'
    val.textContent = range.value
    // hide native slider visually but keep it in DOM for keyboard
    range.classList.add('hidden-range')

    // label fetch: try to find the nearest label span/display
    // insert wrapper before the range
    range.parentNode.insertBefore(wrapper, range)
    wrapper.appendChild(knob)
    wrapper.appendChild(range)
    wrapper.appendChild(val)

    function updateKnobFromRange(){
      const min = Number(range.min || 0)
      const max = Number(range.max || 100)
      const v = Number(range.value)
      const t = (v - min) / (max - min || 1)
      // map t to angle -135 .. 135 (270 degree arc)
      const angle = -135 + t * 270
      knob.style.transform = `rotate(${angle}deg)`
      // update numeric display (keep as previously formatted if nearby span exists)
      const displaySpan = wrapper.querySelector('.value')
      if(displaySpan) displaySpan.textContent = (range.step && Number(range.step) < 1) ? Number(v).toFixed(3) : v
    }

    // pointer drag handling
    let dragging = false
    let startY = 0
    let startVal = 0
    const min = Number(range.min || 0)
    const max = Number(range.max || 100)
    const sensitivity = (max - min) / 150 // pixels to full range

    knob.addEventListener('pointerdown', (ev)=>{
      ev.preventDefault()
      knob.setPointerCapture(ev.pointerId)
      dragging = true
      startY = ev.clientY
      startVal = Number(range.value)
    })
    window.addEventListener('pointerup', ()=>{ dragging = false })
    window.addEventListener('pointermove', (ev)=>{
      if(!dragging) return
      const dy = ev.clientY - startY
      let delta = -dy * sensitivity
      const newVal = Math.max(min, Math.min(max, startVal + delta))
      range.value = newVal
      range.dispatchEvent(new Event('input', {bubbles:true}))
    })

    // wheel support
    knob.addEventListener('wheel', (e)=>{
      e.preventDefault()
      const step = Number(range.step) || 1
      const dir = e.deltaY > 0 ? -1 : 1
      let nv = Number(range.value) + dir * step
      nv = Math.max(min, Math.min(max, nv))
      range.value = nv
      range.dispatchEvent(new Event('input', {bubbles:true}))
    })

    // react to input events
    range.addEventListener('input', updateKnobFromRange)
    updateKnobFromRange()
  })
}

