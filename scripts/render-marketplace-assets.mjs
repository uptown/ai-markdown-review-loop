import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const mediaDir = path.join(rootDir, 'media');
const frameDir = path.join(rootDir, '.test-out', 'marketplace-frames');

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
  <desc id="desc">A Markdown document with anchored AI review comments.</desc>
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
  <title id="title">AI Markdown Review Loop marketplace hero</title>
  <desc id="desc">VS Code Markdown review preview with inline comments, thread history, and AI agent handoff.</desc>
  <defs>
    <linearGradient id="chrome" x1="0" y1="0" x2="1280" y2="720" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#172033"/>
      <stop offset="1" stop-color="#0f172a"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="20" stdDeviation="22" flood-color="#020617" flood-opacity="0.45"/>
    </filter>
  </defs>
  <rect width="1280" height="720" fill="#0b1020"/>
  <rect x="44" y="42" width="1192" height="636" rx="28" fill="url(#chrome)" filter="url(#shadow)"/>
  <rect x="44" y="42" width="1192" height="54" rx="28" fill="#111827"/>
  <circle cx="82" cy="69" r="8" fill="#ef4444"/>
  <circle cx="110" cy="69" r="8" fill="#f59e0b"/>
  <circle cx="138" cy="69" r="8" fill="#84cc16"/>
  <text x="170" y="76" fill="#e5e7eb" font-size="21" font-family="Inter, Arial, sans-serif" font-weight="700">AI Markdown Review Loop</text>
  <text x="62" y="142" fill="#f8fafc" font-size="43" font-family="Inter, Arial, sans-serif" font-weight="800">Review Markdown where the document lives</text>
  <text x="64" y="182" fill="#cbd5e1" font-size="22" font-family="Inter, Arial, sans-serif">Inline threads, anchor-safe edits, and AI agent handoff for docs that keep changing.</text>

  <rect x="66" y="220" width="344" height="390" rx="14" fill="#111827" stroke="#334155"/>
  <text x="90" y="258" fill="#93c5fd" font-size="18" font-family="SFMono-Regular, Menlo, monospace">docs/launch-plan.md</text>
  <text x="90" y="302" fill="#d1d5db" font-size="18" font-family="SFMono-Regular, Menlo, monospace">## Agent Handoff</text>
  <text x="90" y="338" fill="#d1d5db" font-size="18" font-family="SFMono-Regular, Menlo, monospace">- Review threads first</text>
  <text x="90" y="374" fill="#d1d5db" font-size="18" font-family="SFMono-Regular, Menlo, monospace">- Preserve anchors</text>
  <rect x="88" y="398" width="286" height="38" rx="8" fill="#14532d"/>
  <text x="104" y="423" fill="#dcfce7" font-size="17" font-family="SFMono-Regular, Menlo, monospace">- Apply safe patches only</text>
  <text x="90" y="474" fill="#94a3b8" font-size="16" font-family="SFMono-Regular, Menlo, monospace">&lt;!-- ai-review-anchors:{...} --&gt;</text>

  <rect x="438" y="220" width="438" height="390" rx="14" fill="#18212f" stroke="#475569"/>
  <text x="466" y="263" fill="#f8fafc" font-size="31" font-family="Inter, Arial, sans-serif" font-weight="800">Agent Handoff</text>
  <text x="466" y="312" fill="#e5e7eb" font-size="23" font-family="Inter, Arial, sans-serif">Feedback exports put open threads first.</text>
  <rect x="466" y="344" width="320" height="46" rx="9" fill="#3f6212"/>
  <text x="484" y="375" fill="#ecfccb" font-size="22" font-family="Inter, Arial, sans-serif">This criterion is not testable</text>
  <circle cx="806" cy="367" r="22" fill="#84cc16"/>
  <text x="797" y="376" fill="#111827" font-size="25" font-family="Inter, Arial, sans-serif" font-weight="900">1</text>
  <rect x="490" y="424" width="354" height="134" rx="13" fill="#111827" stroke="#64748b"/>
  <rect x="514" y="448" width="54" height="28" rx="14" fill="#581c87" stroke="#c084fc"/>
  <text x="531" y="468" fill="#f3e8ff" font-size="15" font-family="Inter, Arial, sans-serif" font-weight="700">AI</text>
  <rect x="584" y="448" width="116" height="28" rx="14" fill="#0f3d68" stroke="#38bdf8"/>
  <text x="602" y="468" fill="#bae6fd" font-size="15" font-family="Inter, Arial, sans-serif">suggestion</text>
  <text x="514" y="511" fill="#e5e7eb" font-size="20" font-family="Inter, Arial, sans-serif">Needs a measurable done condition.</text>
  <rect x="514" y="528" width="132" height="34" rx="7" fill="#15803d"/>
  <text x="535" y="551" fill="#f0fdf4" font-size="16" font-family="Inter, Arial, sans-serif" font-weight="700">Apply Patch</text>

  <rect x="904" y="220" width="288" height="390" rx="14" fill="#111827" stroke="#334155"/>
  <text x="932" y="260" fill="#f8fafc" font-size="25" font-family="Inter, Arial, sans-serif" font-weight="800">Review Threads</text>
  <rect x="932" y="292" width="232" height="78" rx="10" fill="#172554" stroke="#38bdf8"/>
  <text x="950" y="323" fill="#dbeafe" font-size="17" font-family="Inter, Arial, sans-serif" font-weight="700">Located · AI</text>
  <text x="950" y="350" fill="#bfdbfe" font-size="16" font-family="Inter, Arial, sans-serif">Patch ready</text>
  <rect x="932" y="392" width="232" height="78" rx="10" fill="#1f2937" stroke="#475569"/>
  <text x="950" y="423" fill="#e5e7eb" font-size="17" font-family="Inter, Arial, sans-serif" font-weight="700">You replied</text>
  <text x="950" y="450" fill="#cbd5e1" font-size="16" font-family="Inter, Arial, sans-serif">Continue with AI</text>
  <rect x="932" y="492" width="232" height="78" rx="10" fill="#202c1a" stroke="#84cc16"/>
  <text x="950" y="523" fill="#ecfccb" font-size="17" font-family="Inter, Arial, sans-serif" font-weight="700">Accepted</text>
  <text x="950" y="550" fill="#d9f99d" font-size="16" font-family="Inter, Arial, sans-serif">History linked</text>

  <rect x="66" y="632" width="230" height="34" rx="17" fill="#84cc16"/>
  <text x="88" y="655" fill="#111827" font-size="16" font-family="Inter, Arial, sans-serif" font-weight="800">Drag to comment</text>
  <rect x="316" y="632" width="235" height="34" rx="17" fill="#2563eb"/>
  <text x="339" y="655" fill="#eff6ff" font-size="16" font-family="Inter, Arial, sans-serif" font-weight="800">Reply and hand off</text>
  <rect x="571" y="632" width="248" height="34" rx="17" fill="#9333ea"/>
  <text x="594" y="655" fill="#f5f3ff" font-size="16" font-family="Inter, Arial, sans-serif" font-weight="800">Preserve review state</text>
</svg>`;
}

function demoFrame(step) {
  const steps = [
    ['Open Review Beside', 'Read source and rendered review together.', '#38bdf8'],
    ['Drag-select feedback', 'Attach a comment to the exact Markdown span.', '#84cc16'],
    ['Discuss in place', 'Reply with You/AI attribution and keep the thread open.', '#c084fc'],
    ['Apply or hand off', 'Apply reliable patches or continue the exact thread with AI.', '#22c55e']
  ];
  const [title, subtitle, color] = steps[step - 1];
  const composer = step >= 2;
  const overlay = step >= 3;
  const patch = step >= 4;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540" role="img" aria-labelledby="title desc">
  <title id="title">AI Markdown Review Loop demo step ${step}</title>
  <desc id="desc">${title}: ${subtitle}</desc>
  <rect width="960" height="540" fill="#0f172a"/>
  <rect x="28" y="28" width="904" height="484" rx="22" fill="#111827" stroke="#334155"/>
  <rect x="28" y="28" width="904" height="48" rx="22" fill="#1f2937"/>
  <text x="54" y="60" fill="#e5e7eb" font-size="19" font-family="Inter, Arial, sans-serif" font-weight="800">${title}</text>
  <text x="690" y="60" fill="${color}" font-size="17" font-family="Inter, Arial, sans-serif" font-weight="800">Step ${step}/4</text>
  <rect x="54" y="100" width="326" height="360" rx="12" fill="#0b1220" stroke="#334155"/>
  <text x="78" y="132" fill="#93c5fd" font-size="15" font-family="SFMono-Regular, Menlo, monospace">source.md</text>
  <text x="78" y="172" fill="#e5e7eb" font-size="17" font-family="SFMono-Regular, Menlo, monospace">## Review Loop</text>
  <text x="78" y="210" fill="#d1d5db" font-size="16" font-family="SFMono-Regular, Menlo, monospace">1. Feedback stays attached.</text>
  <text x="78" y="246" fill="#d1d5db" font-size="16" font-family="SFMono-Regular, Menlo, monospace">2. AI can continue threads.</text>
  <text x="78" y="282" fill="#d1d5db" font-size="16" font-family="SFMono-Regular, Menlo, monospace">3. Safe patches can apply.</text>
  <text x="78" y="340" fill="#94a3b8" font-size="14" font-family="SFMono-Regular, Menlo, monospace">.&lt;filename&gt;.ai-review.json</text>
  <rect x="404" y="100" width="328" height="360" rx="12" fill="#18212f" stroke="#475569"/>
  <text x="430" y="146" fill="#f8fafc" font-size="28" font-family="Inter, Arial, sans-serif" font-weight="800">Review Loop</text>
  <text x="430" y="196" fill="#e5e7eb" font-size="19" font-family="Inter, Arial, sans-serif">1. Feedback stays attached.</text>
  <rect x="428" y="218" width="254" height="34" rx="8" fill="${step >= 2 ? '#365314' : '#1f2937'}" stroke="${step >= 2 ? '#84cc16' : '#334155'}"/>
  <text x="442" y="241" fill="#f8fafc" font-size="19" font-family="Inter, Arial, sans-serif">2. AI can continue threads.</text>
  <text x="430" y="292" fill="#e5e7eb" font-size="19" font-family="Inter, Arial, sans-serif">3. Safe patches can apply.</text>
  ${composer ? `<rect x="462" y="272" width="220" height="84" rx="10" fill="#243447" stroke="#84cc16"/><text x="482" y="304" fill="#e5e7eb" font-size="17" font-family="Inter, Arial, sans-serif">Comment on selected text</text><rect x="584" y="318" width="76" height="28" rx="7" fill="#15803d"/><text x="603" y="338" fill="#f0fdf4" font-size="14" font-family="Inter, Arial, sans-serif" font-weight="700">Save</text>` : ''}
  ${overlay ? `<rect x="486" y="248" width="286" height="174" rx="13" fill="#111827" stroke="#64748b"/><rect x="508" y="270" width="42" height="24" rx="12" fill="#581c87" stroke="#c084fc"/><text x="521" y="288" fill="#f3e8ff" font-size="13" font-family="Inter, Arial, sans-serif" font-weight="800">AI</text><text x="508" y="326" fill="#f8fafc" font-size="17" font-family="Inter, Arial, sans-serif">Needs owner before handoff.</text><rect x="508" y="352" width="116" height="30" rx="7" fill="#374151"/><text x="526" y="372" fill="#e5e7eb" font-size="14" font-family="Inter, Arial, sans-serif">Reply</text>${patch ? `<rect x="636" y="352" width="116" height="30" rx="7" fill="#15803d"/><text x="654" y="372" fill="#f0fdf4" font-size="14" font-family="Inter, Arial, sans-serif">Apply Patch</text>` : ''}` : ''}
  <rect x="756" y="100" width="148" height="360" rx="12" fill="#0b1220" stroke="#334155"/>
  <text x="776" y="136" fill="#f8fafc" font-size="18" font-family="Inter, Arial, sans-serif" font-weight="800">Threads</text>
  <rect x="776" y="160" width="108" height="58" rx="9" fill="${step >= 2 ? '#172554' : '#1f2937'}" stroke="${step >= 2 ? '#38bdf8' : '#334155'}"/>
  <text x="790" y="185" fill="#dbeafe" font-size="14" font-family="Inter, Arial, sans-serif">${step >= 2 ? 'Located' : 'None yet'}</text>
  <text x="790" y="205" fill="#bfdbfe" font-size="13" font-family="Inter, Arial, sans-serif">${step >= 2 ? 'AI thread' : 'Drag text'}</text>
  <rect x="776" y="238" width="108" height="58" rx="9" fill="${patch ? '#14532d' : '#1f2937'}" stroke="${patch ? '#84cc16' : '#334155'}"/>
  <text x="790" y="263" fill="#dcfce7" font-size="14" font-family="Inter, Arial, sans-serif">${patch ? 'Accepted' : 'Open'}</text>
  <text x="790" y="283" fill="#bbf7d0" font-size="13" font-family="Inter, Arial, sans-serif">${patch ? 'History' : 'Reply'}</text>
  <text x="54" y="492" fill="#cbd5e1" font-size="20" font-family="Inter, Arial, sans-serif">${subtitle}</text>
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
  run('magick', ['-delay', '140', '-loop', '0', ...framePngs, path.join(mediaDir, 'review-loop-demo.gif')]);
  run('ffmpeg', [
    '-y',
    '-framerate',
    '1',
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
