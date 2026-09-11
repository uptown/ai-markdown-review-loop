import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const mediaDir = path.join(rootDir, 'media');
const frameDir = mkdtempSync(path.join(tmpdir(), 'markdown-review-marketplace-'));

mkdirSync(mediaDir, { recursive: true });
mkdirSync(frameDir, { recursive: true });

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

function writeMedia(fileName, contents) {
  writeFileSync(path.join(mediaDir, fileName), contents);
}

function iconSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-labelledby="title desc">
  <title id="title">AI Markdown Review Loop icon</title>
  <desc id="desc">A Markdown document with a review comment.</desc>
  <defs>
    <linearGradient id="bg" x1="64" y1="48" x2="448" y2="464" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#111827"/>
      <stop offset="1" stop-color="#1f2937"/>
    </linearGradient>
    <linearGradient id="accent" x1="120" y1="112" x2="392" y2="400" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#a3e635"/>
      <stop offset="1" stop-color="#22c55e"/>
    </linearGradient>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="104" fill="url(#bg)"/>
  <path d="M158 124h138l58 58v206H158z" fill="#f8fafc"/>
  <path d="M296 124v58h58z" fill="#d1d5db"/>
  <path d="M190 214h100M190 252h132M190 290h92" stroke="#64748b" stroke-width="18" stroke-linecap="round"/>
  <path d="M172 346h182" stroke="url(#accent)" stroke-width="24" stroke-linecap="round"/>
  <circle cx="370" cy="342" r="58" fill="#84cc16"/>
  <path d="M342 336h56M342 366h32" stroke="#111827" stroke-width="18" stroke-linecap="round"/>
  <path d="M331 389l-12 36 42-24" fill="#84cc16"/>
</svg>`;
}

function heroSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" role="img" aria-labelledby="title desc">
  <title id="title">Comment, hand off, and review revised Markdown</title>
  <desc id="desc">Illustrated workflow: add a targeted comment, give a compact JSON task file to an external coding agent, then inspect its source changes and done or blocked results. This is not a live screenshot.</desc>
  <rect width="1280" height="720" fill="#0b1120"/>
  <g font-family="Inter, Arial, sans-serif">
    <text x="64" y="68" fill="#a3e635" font-size="18" font-weight="700" letter-spacing="2">AI MARKDOWN REVIEW LOOP</text>
    <text x="64" y="132" fill="#f8fafc" font-size="46" font-weight="800">Comment. Send. Review the changes.</text>
    <text x="64" y="176" fill="#cbd5e1" font-size="23">A small JSON task file for the coding agent you choose.</text>

    <rect x="64" y="220" width="352" height="384" rx="18" fill="#172334" stroke="#34475e"/>
    <text x="88" y="259" fill="#a3e635" font-size="17" font-weight="700">01  COMMENT</text>
    <text x="88" y="306" fill="#f8fafc" font-size="28" font-weight="700">Retry policy</text>
    <rect x="88" y="331" width="302" height="43" rx="6" fill="#365314"/>
    <text x="102" y="359" fill="#ecfccb" font-size="20">Retry failed requests.</text>
    <path d="M116 389v17h18" fill="none" stroke="#a3e635" stroke-width="2"/>
    <rect x="134" y="392" width="256" height="114" rx="10" fill="#0c1422" stroke="#84cc16"/>
    <text x="152" y="425" fill="#f8fafc" font-size="18">Define the retry limit</text>
    <text x="152" y="455" fill="#f8fafc" font-size="18">and final failure message.</text>
    <text x="152" y="485" fill="#94a3b8" font-size="14">Your request · rv_retry</text>
    <text x="88" y="566" fill="#cbd5e1" font-size="17">One request, one target.</text>

    <rect x="448" y="220" width="352" height="384" rx="18" fill="#172334" stroke="#34475e"/>
    <text x="472" y="259" fill="#7dd3fc" font-size="17" font-weight="700">02  HAND OFF</text>
    <text x="472" y="303" fill="#f8fafc" font-size="24" font-weight="700">Compact task JSON</text>
    <text x="472" y="332" fill="#94a3b8" font-size="15">.spec.md.ai-review.json · abbreviated</text>
    <g font-family="Courier-New" font-style="normal" font-size="17" fill="#bae6fd">
      <text x="472" y="371">{</text>
      <text x="488" y="397">&#x200B;&quot;schemaVersion&quot;: 3,</text>
      <text x="488" y="423">&#x200B;&quot;document&quot;: &quot;spec.md&quot;,</text>
      <text x="488" y="449">&#x200B;&quot;items&quot;: [{</text>
      <text x="505" y="475">&#x200B;&quot;id&quot;: &quot;rv_retry&quot;,</text>
      <text x="505" y="501">&#x200B;&quot;status&quot;: &quot;pending&quot;&#x200B;</text>
      <text x="488" y="527">}] }</text>
    </g>
    <text x="472" y="566" fill="#cbd5e1" font-size="17">Agent edits spec.md directly.</text>

    <rect x="832" y="220" width="384" height="384" rx="18" fill="#172334" stroke="#34475e"/>
    <text x="856" y="259" fill="#c4b5fd" font-size="17" font-weight="700">03  REVIEW THE CHANGES</text>
    <text x="856" y="306" fill="#f8fafc" font-size="28" font-weight="700">Revised Markdown</text>
    <rect x="856" y="331" width="336" height="109" rx="8" fill="#16332a"/>
    <text x="872" y="360" fill="#dcfce7" font-size="18">Retry up to three times.</text>
    <text x="872" y="390" fill="#dcfce7" font-size="18">Then show the failure reason</text>
    <text x="872" y="420" fill="#dcfce7" font-size="18">and a retry action.</text>
    <rect x="856" y="465" width="64" height="28" rx="14" fill="#3f6212"/>
    <text x="871" y="484" fill="#ecfccb" font-size="14" font-weight="700">Done</text>
    <text x="932" y="485" fill="#cbd5e1" font-size="15">Agent result for revision 1</text>
    <text x="856" y="524" fill="#94a3b8" font-size="16">Blocked items explain what is needed.</text>
    <text x="856" y="566" fill="#cbd5e1" font-size="17">Inspect the source. Reopen if needed.</text>

    <text x="64" y="656" fill="#e2e8f0" font-size="21">Comment → Task JSON → Agent edit → Your review</text>
    <text x="64" y="691" fill="#8292a8" font-size="14">Illustrated workflow · external file-capable agent required · no built-in model calls</text>
  </g>
</svg>`;
}

function demoFrame(step) {
  const steps = [
    ['Comment on the document', 'Select the content and describe the change you want.', '#a3e635'],
    ['Send the task file to your agent', 'One colocated JSON file carries the requests and brief guidance.', '#7dd3fc'],
    ['The agent edits your Markdown', 'Save source changes first, then record done or blocked with a short result.', '#a3e635'],
    ['Review the revised document', 'Inspect the changes. Reopen work or add comments for the next round.', '#c4b5fd']
  ];
  const [title, subtitle, accent] = steps[step - 1];
  const revised = step >= 3;
  const result = step >= 3;
  const taskTitle = step === 1 ? 'Your comment' : 'Task file';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540" role="img" aria-labelledby="title desc">
  <title id="title">${title}</title>
  <desc id="desc">Illustrated workflow, step ${step} of 4: ${subtitle}</desc>
  <rect width="960" height="540" fill="#0b1120"/>
  <g font-family="Inter, Arial, sans-serif">
    <text x="40" y="44" fill="${accent}" font-size="14" font-weight="700" letter-spacing="1.5">AI MARKDOWN REVIEW LOOP</text>
    <text x="850" y="44" fill="#94a3b8" font-size="16">${step} / 4</text>
    <text x="40" y="94" fill="#f8fafc" font-size="34" font-weight="800">${title}</text>
    <rect x="40" y="125" width="438" height="315" rx="16" fill="#172334" stroke="#34475e"/>
    <text x="64" y="160" fill="#93c5fd" font-size="16">spec.md${revised ? ' · revised source' : ''}</text>
    <text x="64" y="208" fill="#f8fafc" font-size="27" font-weight="700">Retry policy</text>
    <rect x="64" y="233" width="390" height="${revised ? '112' : '44'}" rx="7" fill="${revised ? '#16332a' : '#365314'}"/>
    <text x="80" y="262" fill="#ecfccb" font-size="21">${revised ? 'Retry up to three times.' : 'Retry failed requests.'}</text>
    ${revised ? `<text x="80" y="295" fill="#dcfce7" font-size="20">Then show the failure reason</text><text x="80" y="328" fill="#dcfce7" font-size="20">and a retry action.</text>` : ''}
    <text x="64" y="397" fill="#94a3b8" font-size="16">${revised ? 'The source is the work to review.' : 'Select a specific target for your request.'}</text>

    <rect x="502" y="125" width="418" height="315" rx="16" fill="#172334" stroke="${accent}"/>
    <text x="526" y="160" fill="${accent}" font-size="16" font-weight="700">${taskTitle}${step >= 2 ? ' · abbreviated' : ''}</text>
    <text x="526" y="204" fill="#f8fafc" font-size="22" font-weight="700">Define the retry behavior</text>
    <text x="526" y="241" fill="#e2e8f0" font-size="18">Specify the retry limit and the</text>
    <text x="526" y="269" fill="#e2e8f0" font-size="18">message after the final failure.</text>
    <text x="526" y="315" fill="#94a3b8" font-size="15">rv_retry · revision 1</text>
    <rect x="526" y="340" width="${result ? '69' : '90'}" height="29" rx="14" fill="${result ? '#3f6212' : '#164e63'}"/>
    <text x="542" y="360" fill="${result ? '#ecfccb' : '#cffafe'}" font-size="15" font-weight="700">${result ? 'Done' : 'Pending'}</text>
    <text x="526" y="404" fill="#cbd5e1" font-size="16">${result ? 'Defined three retries and a failure action.' : 'Guidance and target travel with the request.'}</text>
    <text x="40" y="480" fill="#e2e8f0" font-size="20">${subtitle}</text>
    <text x="40" y="515" fill="#8292a8" font-size="13">Illustrated workflow · use an external agent with workspace file access</text>
  </g>
</svg>`;
}

writeMedia('marketplace-icon.svg', iconSvg());
writeMedia('marketplace-hero.svg', heroSvg());
writeMedia('review-loop-demo-poster.svg', demoFrame(4));

const framePngs = [];
for (let step = 1; step <= 4; step += 1) {
  const svgPath = path.join(frameDir, `review-loop-demo-${String(step).padStart(2, '0')}.svg`);
  const pngPath = path.join(frameDir, `review-loop-demo-${String(step).padStart(2, '0')}.png`);
  writeFileSync(svgPath, demoFrame(step));
  framePngs.push(pngPath);
  run('magick', ['-background', 'none', '-density', '144', svgPath, '-resize', '960x540!', pngPath]);
}

run('magick', ['-background', 'none', '-density', '192', path.join(mediaDir, 'marketplace-icon.svg'), '-resize', '512x512!', path.join(mediaDir, 'marketplace-icon.png')]);
run('magick', ['-background', '#0b1020', '-density', '144', path.join(mediaDir, 'marketplace-hero.svg'), '-resize', '1280x720!', path.join(mediaDir, 'marketplace-hero.png')]);
run('magick', ['-background', '#0f172a', '-density', '144', path.join(mediaDir, 'review-loop-demo-poster.svg'), '-resize', '960x540!', path.join(mediaDir, 'review-loop-demo-poster.png')]);

if (framePngs.every((file) => existsSync(file))) {
  run('magick', ['-delay', '250', '-loop', '0', ...framePngs, path.join(mediaDir, 'review-loop-demo.gif')]);
  run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-framerate',
    '2/5',
    '-pattern_type',
    'glob',
    '-i',
    path.join(frameDir, 'review-loop-demo-*.png'),
    '-vf',
    'fps=24,format=yuv420p,scale=960:540',
    '-movflags',
    '+faststart',
    path.join(mediaDir, 'review-loop-demo.mp4')
  ]);
}

rmSync(frameDir, { recursive: true, force: true });
