/** Local-only recorded format matrix. Requires ffmpeg and Playwright WebKit.
 * afconvert supplies Apple AAC/ALAC on macOS; mpv is an optional reference.
 * No installation, personal library, backend or native shell is used. */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import { webkit } from 'playwright'
const directory = mkdtempSync(join(tmpdir(), 'krobi-engine-media-'))
const run = (command, args) => execFileSync(command, args, { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })
const available = command => !spawnSync(command, ['--version'], { stdio: 'ignore' }).error
const mpv = available('mpv'), apple = available('afconvert')
const encoders = run('ffmpeg', ['-hide_banner', '-encoders']).toString()
const vorbis = encoders.includes('libvorbis') ? ['-c:a','libvorbis','-q:a','6'] : ['-c:a','vorbis','-strict','-2']
const formats = [
  { name:'MP3', ext:'mp3', rate:44100, args:['-c:a','libmp3lame','-b:a','320k'] },
  { name:'FLAC 44.1/16', ext:'flac', rate:44100, args:['-c:a','flac','-sample_fmt','s16'] },
  { name:'FLAC 96/24', ext:'flac', rate:96000, args:['-c:a','flac','-sample_fmt','s32','-bits_per_raw_sample','24'] },
  { name:'Opus', ext:'opus', rate:48000, args:['-c:a','libopus','-b:a','192k'] },
  { name:'Vorbis', ext:'ogg', rate:44100, args:vorbis },
  { name:'WAV', ext:'wav', rate:44100, args:['-c:a','pcm_s16le'] },
  { name:'AAC (afconvert)', forceNative:true, ext:'m4a', rate:44100, apple:'aac' },
  { name:'AAC (ffmpeg)', forceNative:true, ext:'m4a', rate:44100, args:['-c:a','aac','-b:a','256k'], extraFrames:344 },
  { name:'ALAC', ext:'m4a', rate:44100, apple:'alac' },
  // Raw ADTS has no priming metadata; preserve every decoded frame and fade the boundary.
  { name:'AAC (ADTS)', ext:'aac', rate:44100, args:['-c:a','aac','-b:a','256k'], informational:true },
]
let server, browser
const rows = []
try {
  for (const [index, format] of formats.entries()) {
    format.key = `f${index}`
    if (format.apple && !apple) { format.skipped = 'afconvert unavailable'; continue }
    for (const [part, start] of [['A',0],['B',format.rate * 10]]) {
      // Split a continuous source by sample before either independent encoding.
      const wav = join(directory, `${format.key}-${part}-source.wav`)
      run('ffmpeg', ['-v','error','-f','lavfi','-i',`sine=frequency=440:sample_rate=${format.rate}:duration=20`,'-af',`atrim=start_sample=${start}:end_sample=${start + format.rate * 10},asetpts=PTS-STARTPTS`,'-ac','2','-c:a','pcm_s24le',wav])
      const file = join(directory, `${format.key}-${part}.${format.ext}`)
      if (format.apple) {
        try { run('afconvert', ['-f','m4af','-d',format.apple, ...(format.apple === 'aac' ? ['-b','256000'] : []),wav,file]) }
        catch { format.skipped = 'afconvert codec unavailable (sandbox or OS)'; break }
      }
      else {
        run('ffmpeg', ['-v','error','-i',wav,...format.args,file])
        if (format.ext === 'ogg' && !encoders.includes('libvorbis')) {
          // ffmpeg's experimental Vorbis encoder rounds to 64 samples. Correct
          // its container end granule to the exact source length, with Ogg CRC.
          const data = readFileSync(file)
          for (let at = 0; at + 27 <= data.length;) {
            const count = data[at + 26]
            let length = 27 + count
            for (let i = 0; i < count; i++) length += data[at + 27 + i]
            if (data[at + 5] & 4) {
              data.writeBigInt64LE(BigInt(format.rate * 10),at + 6); data.fill(0,at + 22,at + 26)
              let crc = 0
              for (const byte of data.subarray(at,at + length)) {
                crc ^= byte << 24
                for (let bit = 0; bit < 8; bit++) crc = crc << 1 ^ (crc & 0x80000000 ? 0x04c11db7 : 0)
              }
              data.writeUInt32LE(crc >>> 0,at + 22)
            }
            at += length
          }
          writeFileSync(file,data)
        }
      }
    }
  }
  const longSource = join(directory,'long-source.wav')
  run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=300','-ac','2',longSource])
  run('ffmpeg',['-v','error','-i',longSource,'-c:a','libmp3lame','-b:a','320k',join(directory,'long.mp3')])
  run('ffmpeg',['-v','error','-i',longSource,'-c:a','aac','-b:a','256k',join(directory,'long.m4a')])
  let requests = 0, maxRangeBytes = 0
  server = await createServer({ configFile: resolve('renderer/vite.config.js'), cacheDir:join(directory,'vite-cache'), logLevel:'silent', optimizeDeps: { noDiscovery: true, include: ['mpg123-decoder','@wasm-audio-decoders/flac','ogg-opus-decoder','@wasm-audio-decoders/ogg-vorbis'] }, server: { host:'127.0.0.1', port:0, strictPort:false }, plugins:[{
    name:'local-engine-recording', configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url === '/verify-engine') { res.setHeader('Content-Type','text/html'); res.end('<button id="start">start</button>'); return }
        const match = /^\/engine-media\/(f\d+-[AB]\.(?:mp3|flac|opus|ogg|wav|m4a|aac)|long\.(?:mp3|m4a))$/.exec(req.url || '')
        if (!match) return next()
        const file = join(directory, match[1]), total = statSync(file).size
        const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '')
        const start = Number(range?.[1] || 0), end = Math.min(Number(range?.[2] || total - 1), start + 1048575, total - 1)
        if (start >= total) { res.statusCode = 416; res.end(); return }
        requests++; maxRangeBytes = Math.max(maxRangeBytes, end - start + 1)
        res.writeHead(206, { 'Content-Type':'application/octet-stream', 'Content-Range':`bytes ${start}-${end}/${total}`, 'Content-Length':end - start + 1, 'Accept-Ranges':'bytes', 'X-Cache':'HIT' })
        res.end(readFileSync(file).subarray(start,end + 1))
      })
    },
  }] })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await webkit.launch({ headless:true })
  const page = await browser.newPage()
  // Silent by construction: headless WebKit renders to the Mac's real output, so
  // every connection to a context's destination goes through a zero gain first.
  // The graph still renders (worklets keep running); nothing reaches the speakers.
  await page.addInitScript(() => {
    const connect = AudioNode.prototype.connect
    const mutes = new WeakMap()
    AudioNode.prototype.connect = function (target, ...rest) {
      if (target instanceof AudioDestinationNode) {
        let mute = mutes.get(target.context)
        if (!mute) { mute = target.context.createGain(); mute.gain.value = 0; connect.call(mute, target); mutes.set(target.context, mute) }
        return connect.call(this, mute, ...rest)
      }
      return connect.call(this, target, ...rest)
    }
    window.__krobiMuted = true
  })
  page.on('pageerror', error => console.error('WebKit:', error.message))
  await page.goto(`${origin}/verify-engine`)
  if (!(await page.evaluate(() => window.__krobiMuted === true))) throw new Error('refusing to run: the page is not muted')
  await page.evaluate(async () => {
    const { PlaybackEngine } = await import('/src/player/engine/PlaybackEngine.ts')
    const { getAudioGraph } = await import('/src/stems/audioGraph.ts')
    window.prepare = async (srcA, srcB) => {
      window.engine?.dispose(); window.tap?.disconnect()
      const engine = window.engine = new PlaybackEngine()
      window.recording = []; window.events = []; window.finished = false; window.peakRingBytes = 0; window.peakResidentBytes = 0; window.peakDecodedBytes = 0
      for (const name of ['playing','waiting','ended','boundary','error','seeked','firstByte']) engine.addEventListener(name, event => window.events.push({ name, at:performance.now(), detail:event.detail, error:engine.error }))
      document.querySelector('#start').onclick = async () => {
        await engine.activate()
        const context = getAudioGraph().context
        if (!window.tapInstalled) {
          const code = `class Tap extends AudioWorkletProcessor { process(inputs) { if (inputs[0]?.[0]) { const pcm = inputs[0][0].slice(); this.port.postMessage({frame:currentFrame, pcm}, [pcm.buffer]); } return true; } } registerProcessor('record-engine', Tap)`
          const url = URL.createObjectURL(new Blob([code], { type:'application/javascript' }))
          await context.audioWorklet.addModule(url); URL.revokeObjectURL(url); window.tapInstalled = true
        }
        const tap = window.tap = new AudioWorkletNode(context, 'record-engine')
        tap.port.onmessage = ({ data }) => window.recording.push(data)
        engine.outputNode.connect(tap); tap.connect(context.destination)
        window.rate = context.sampleRate; window.startedAt = performance.now()
        engine.src = srcA; engine.load(); engine.setNext({ key:'B', src:srcB })
        let count = 0
        engine.addEventListener('ended', () => {
          if (++count === 1) { engine.src = srcB; engine.load() }
          else { engine.pause(); window.finished = true }
        })
        await engine.play()
        clearInterval(window.byteTimer)
        window.byteTimer = setInterval(() => {
          window.peakRingBytes = Math.max(window.peakRingBytes,engine.bufferedBytes)
          window.peakDecodedBytes = Math.max(window.peakDecodedBytes,engine.decodedBytes)
          window.peakResidentBytes = Math.max(window.peakResidentBytes,engine.residentBytes)
        }, 2)
      }
    }
  })
  const url = (format, part) => `/engine-media/${format.key}-${part}.${format.ext}`
  const cases = formats.map(format => [format,format])
  for (const [index,name] of [[6,'AAC (M4A, WebCodecs)'],[7,'AAC (ffmpeg M4A, WebCodecs)']]) {
    const streaming = { ...formats[index], name, webCodecs:true, forceNative:false, extraFrames:0 }
    cases.push([streaming,streaming])
  }
  const fallback = { ...formats[7], name:'AAC (nativePCM fallback, AudioDecoder undefined)', webCodecs:false, forceNative:true, extraFrames:344 }
  cases.push([fallback,fallback])
  for (const [a,b] of [[0,1],[1,3],[0,6],[5,2],[3,0],[9,5],[5,9]]) cases.push([formats[a],formats[b]])
  for (const [a,b] of cases) {
    const row = { format:a === b ? a.name : `${a.name} → ${b.name}`, expectedAFrames:441000 + (a.extraFrames || 0), documentedExtraFrames:a.extraFrames || 0 }
    rows.push(row)
    if (a.skipped || b.skipped) { row.skipped = a.skipped || b.skipped; continue }
    await page.evaluate(force => {
      window.__savedAudioDecoder ??= window.AudioDecoder
      window.AudioDecoder = force ? undefined : window.__savedAudioDecoder
    },a.forceNative === true || b.forceNative === true)
    await page.evaluate(([srcA,srcB]) => window.prepare(srcA,srcB), [url(a,'A'),url(b,'B')])
    await page.click('#start')
    await page.waitForFunction(() => window.finished || window.engine.error, undefined, { timeout:45000 })
    await page.waitForTimeout(150)
    Object.assign(row, await page.evaluate(() => {
      clearInterval(window.byteTimer)
      const boundary = window.events.find(e => e.name === 'boundary'), playing = window.events.find(e => e.name === 'playing'), ends = window.events.filter(e => e.name === 'ended')
      if (window.engine.error || !boundary || !playing || ends.length !== 2) return { error:window.engine.error || 'Missing boundary', events:window.events }
      const split = boundary.detail.audioFrame, samples = new Map()
      for (const block of window.recording) for (let i = 0; i < block.pcm.length; i++) if (Math.abs(block.frame + i - split) <= 2048) samples.set(block.frame + i,block.pcm[i])
      let run = 0, quiet = 0, maxJump = 0, normalStep = 0
      for (let frame = split - 1024; frame < split + 1024; frame++) {
        if (!samples.has(frame) || !samples.has(frame - 1)) throw new Error('Missing recorded samples')
        const sample = samples.get(frame), jump = Math.abs(sample - samples.get(frame - 1))
        run = Math.abs(sample) < 1e-7 ? run + 1 : 0; quiet = Math.max(quiet,run)
        if (Math.abs(frame - split) <= 64) maxJump = Math.max(maxJump,jump)
        else normalStep = Math.max(normalStep,jump)
      }
      return { outputRate:window.rate, trackAOutputFrames:ends[0].detail.audioFrame - playing.detail.audioFrame, trackBOutputFrames:ends[1].detail.audioFrame - split,
        insertedGapFrames:boundary.detail.ms * window.rate / 1000, quietGapFrames:Math.max(0,quiet - 1), maxBoundaryJump:maxJump, normalMaxStep:normalStep, clickPass:maxJump <= 2 * normalStep,
        ttfaMs:playing.at - window.startedAt, peakRingBytes:window.peakRingBytes, peakDecodedBytes:Math.max(window.peakDecodedBytes,window.engine.peakDecodedBytes), peakResidentBytes:Math.max(window.peakResidentBytes,window.engine.peakResidentBytes), releasedDecodedBytes:window.engine.decodedBytes, decoderLocation:window.engine.decoderLocation }
    }))
    if (a === b && !row.error) {
      Object.assign(row, await page.evaluate(async src => {
        window.engine.dispose()
        const { PlaybackEngine } = await import('/src/player/engine/PlaybackEngine.ts')
        const engine = window.engine = new PlaybackEngine(); engine.src = src
        const wait = name => new Promise((resolve,reject) => { engine.addEventListener(name,resolve,{ once:true }); engine.addEventListener('error',() => reject(engine.error),{ once:true }) })
        const ready = wait('canplay'); engine.load(); await ready
        const started = performance.now(), sought = wait('seeked'); engine.currentTime = 5; await sought
        const seekMs = performance.now() - started; engine.dispose(); return { seekMs }
      },url(a,'A')))
    }
    if (mpv) {
      try {
        const output = join(directory,'reference.wav')
        run('mpv',['--no-config','--no-video','--gapless-audio=yes','--ao=pcm',`--ao-pcm-file=${output}`,join(directory,`${a.key}-A.${a.ext}`),join(directory,`${b.key}-B.${b.ext}`)])
        const pcm = run('ffmpeg',['-v','error','-i',output,'-f','f32le','-ac','1','-ar','44100','pipe:1'])
        let quiet = 0, longest = 0
        for (let frame = 440000; frame < Math.min(pcm.length / 4,442500); frame++) { quiet = Math.abs(pcm.readFloatLE(frame * 4)) < 1e-7 ? quiet + 1 : 0; longest = Math.max(longest,quiet) }
        row.mpvGapFrames = Math.max(0,longest - 1); rmSync(output,{ force:true })
      } catch { row.mpvReference = 'reference render failed' }
    } else row.mpvReference = 'mpv not installed, reference skipped'
    const expected = Math.round(10 * (row.outputRate || 44100)) + Math.round((a.extraFrames || 0) * (row.outputRate || 44100) / 44100)
    row.expectedAFrames = expected
    row.pass = !row.error && (a.informational || Math.abs(row.trackAOutputFrames - expected) <= 1) && row.insertedGapFrames === 0 && (a.informational || b.informational || row.quietGapFrames <= (a.extraFrames || 0)) && row.clickPass && row.releasedDecodedBytes === 0 && row.peakRingBytes <= 2 * 30 * (row.outputRate || 44100) * 2 * 4 && row.peakDecodedBytes <= 600 * 1024 * 1024
    if (a.webCodecs || b.webCodecs) row.pass &&= ['worker','main'].includes(row.decoderLocation) && row.peakDecodedBytes === 0
    if (a.forceNative || b.forceNative) row.pass &&= row.decoderLocation === 'native' && row.peakDecodedBytes > 0
    if (a.informational) row.note = 'ADTS has no priming metadata; untrimmed frames and intrinsic silence are reported; boundary fade and clickPass are required'
    if (a.extraFrames) row.note = 'Accepted WebKit ffmpeg AAC remainder: +344 frames at 44.1 kHz'
  }
  await page.evaluate(() => { window.AudioDecoder = window.__savedAudioDecoder })
  for (const ext of ['mp3','m4a']) {
    const memory = await page.evaluate(async ext => {
      window.engine.dispose(); window.tap?.disconnect(); window.recording = []
      const { PlaybackEngine } = await import('/src/player/engine/PlaybackEngine.ts')
      const engine = window.engine = new PlaybackEngine()
      const wait = name => new Promise((resolve,reject) => { engine.addEventListener(name,resolve,{ once:true }); engine.addEventListener('error',() => reject(engine.error),{ once:true }) })
      engine.src = `/engine-media/long.${ext}`
      const ready = wait('playing'), loaded = performance.now(); engine.load(); await engine.play(); await ready
      const ttfaMs = performance.now() - loaded
      await new Promise(resolve => setTimeout(resolve,1500))
      const seeked = wait('seeked'), started = performance.now(); engine.currentTime = 150; await seeked
      const seekMs = performance.now() - started
      await new Promise(resolve => setTimeout(resolve,250))
      const result = { format:`Memory: 5-minute ${ext.toUpperCase()}`, ttfaMs, seekMs, decoderLocation:engine.decoderLocation, outputRate:engine.outputNode.context.sampleRate, peakRingBytes:engine.bufferedBytes, peakDecodedBytes:engine.peakDecodedBytes, peakResidentBytes:engine.peakResidentBytes }
      engine.dispose(); result.releasedBytes = engine.residentBytes
      return result
    },ext)
    memory.pass = memory.peakRingBytes <= 2 * 30 * memory.outputRate * 2 * 4 && memory.peakDecodedBytes <= 600 * 1024 * 1024 && memory.releasedBytes === 0
    if (ext === 'm4a') memory.pass &&= ['worker','main'].includes(memory.decoderLocation) && memory.peakDecodedBytes === 0 && memory.ttfaMs < 300 && memory.seekMs < 300
    rows.push(memory)
  }
  console.log(JSON.stringify({ rows, requests, maxRangeBytes, mpv:mpv ? 'rendered' : 'mpv not installed, reference skipped' },null,2))
  if (rows.some(row => row.skipped || !row.pass) || maxRangeBytes > 262144) process.exitCode = 1
} catch (error) {
  console.log(JSON.stringify({ rows:rows.length ? rows : [...formats.map(f => ({ format:f.name, skipped:f.skipped || 'WebKit did not launch' })), ...['AAC (M4A, WebCodecs)','AAC (ffmpeg M4A, WebCodecs)','AAC (nativePCM fallback, AudioDecoder undefined)','Memory: 5-minute MP3','Memory: 5-minute M4A','AAC (ADTS) → WAV','WAV → AAC (ADTS)','MP3 → FLAC 44.1/16','FLAC 44.1/16 → Opus','MP3 → AAC (afconvert)','WAV → FLAC 96/24','Opus → MP3'].map(format => ({ format, skipped:'WebKit did not launch' }))], error:String(error), mpv:mpv ? 'available' : 'mpv not installed, reference skipped' },null,2))
  process.exitCode = 1
} finally {
  await browser?.close(); await server?.close(); rmSync(directory,{ recursive:true, force:true })
}
