import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args:['--enable-unsafe-webgpu','--use-gl=angle','--use-angle=swiftshader','--autoplay-policy=no-user-gesture-required'] }).catch(e=>{console.log('launch fail',e.message);process.exit(1)});
const p = await b.newPage();
await p.goto('http://localhost:8765/');
const r = await p.evaluate(async () => {
  const out = {ua: navigator.userAgent};
  const c = document.createElement('canvas'); out.webgl2 = !!c.getContext('webgl2');
  out.webgpu = !!navigator.gpu; try { out.adapter = !!(await navigator.gpu?.requestAdapter()); } catch(e){ out.adapter = e.message }
  const vcodecs = {avc:'avc1.640028', vp9:'vp09.00.40.08', vp8:'vp8', av1:'av01.0.08M.08', hevc:'hvc1.1.6.L120.B0'};
  for (const [k,codec] of Object.entries(vcodecs)) {
    try { out['enc_'+k] = (await VideoEncoder.isConfigSupported({codec, width:1920, height:1080, bitrate: 8e6, framerate:30})).supported } catch(e){ out['enc_'+k]='err '+e.message }
    try { out['dec_'+k] = (await VideoDecoder.isConfigSupported({codec, codedWidth:1920, codedHeight:1080})).supported } catch(e){ out['dec_'+k]='err '+e.message }
  }
  for (const [k,codec] of Object.entries({aac:'mp4a.40.2', opus:'opus'})) {
    try { out['aenc_'+k] = (await AudioEncoder.isConfigSupported({codec, sampleRate:48000, numberOfChannels:2, bitrate:192000})).supported } catch(e){ out['aenc_'+k]='err '+e.message }
  }
  const v = document.createElement('video'); out.canPlayMp4H264 = v.canPlayType('video/mp4; codecs="avc1.42E01E"'); out.canPlayWebmVp9 = v.canPlayType('video/webm; codecs="vp9"');
  out.alphaEnc = (await VideoEncoder.isConfigSupported({codec:'vp09.00.40.08', width:640, height:480, alpha:'keep'})).supported;
  return out;
});
console.log(JSON.stringify(r,null,1)); await b.close();
