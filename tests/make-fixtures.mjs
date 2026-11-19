// Makes the synthetic test media in /tmp/ve-fixtures with FFmpeg, for a fresh
// machine. Photos of real faces (face.jpg, portrait.jpg and the like) can't be
// made here, so the face tests need those copied in by hand. talk.mp4 and
// speech.wav are stand-ins: voice-like bursts with pauses, not real words, which
// is all the tests need since they put the transcript words in by hand.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const FIX = '/tmp/ve-fixtures';
fs.mkdirSync(FIX, { recursive: true });
const ff = (out, args) => {
  if (fs.existsSync(`${FIX}/${out}`)) return;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, `${FIX}/${out}`]);
  console.log(r.status === 0 ? 'made' : 'FAILED', out, r.stderr?.toString().slice(0, 200) || '');
};
const v264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast'];
const PATTERN = "aevalsrc='0.5*sin(2*PI*440*t)*(gt(mod(t*1.7,1),0.72)+gt(mod(t*2.3+0.4,1),0.86))':s=48000:d=12.6";

ff('landscape.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:duration=6', ...v264, '-c:a', 'aac', '-shortest']);
ff('vertical.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=f=330:sample_rate=48000:duration=6', ...v264, '-c:a', 'aac', '-shortest']);
ff('pan.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=8', ...v264]);
ff('lecture90.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=90', '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*200*t)*lt(mod(t,4),2.5)':s=48000:d=90", ...v264, '-c:a', 'aac', '-shortest']);
ff('music.wav', ['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*110*t)*exp(-8*mod(t,0.5))+0.15*sin(2*PI*660*t)':s=48000:d=12"]);
ff('tone440.wav', ['-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:duration=4']);
ff('photo.png', ['-f', 'lavfi', '-i', 'mandelbrot=size=1200x1200', '-frames:v', '1']);
ff('pattern.wav', ['-f', 'lavfi', '-i', PATTERN]);
// two phones filming the same sound: camB starts 3.2 s into camA's sound
ff('camA.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-i', `${FIX}/pattern.wav`, '-map', '0:v', '-map', '1:a', '-t', '12.6', ...v264, '-c:a', 'aac']);
ff('camB.mp4', ['-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=30', '-ss', '3.2', '-i', `${FIX}/pattern.wav`, '-map', '0:v', '-map', '1:a', '-t', '9', ...v264, '-c:a', 'aac']);
// voice-like bursts with pauses under a little hiss
const VOICE = "aevalsrc='0.4*sin(2*PI*220*t)*sin(2*PI*3*t)*lt(mod(t,3),1.8)':s=48000:d=";
ff('pink.wav', ['-f', 'lavfi', '-i', 'anoisesrc=c=pink:a=0.3:r=48000:d=6']);
ff('speech.wav', ['-f', 'lavfi', '-i', VOICE + '12', '-f', 'lavfi', '-i', 'anoisesrc=c=pink:a=0.02:r=48000:d=12', '-filter_complex', 'amix=inputs=2:normalize=0']);
ff('talk.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=10', '-f', 'lavfi', '-i', VOICE + '10', '-f', 'lavfi', '-i', 'anoisesrc=c=pink:a=0.02:r=48000:d=10', '-filter_complex', '[1:a][2:a]amix=inputs=2:normalize=0[a]', '-map', '0:v', '-map', '[a]', ...v264, '-c:a', 'aac', '-shortest']);
