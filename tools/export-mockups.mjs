// Turn the design-canvas artboards into standalone HTML files that open in any browser.
//
//   node tools/export-mockups.mjs design/canvas design/mockups
//
// An artboard is an .dc.html file that only renders inside the online canvas. This
// keeps its <helmet> (fonts, base styles) and its markup, and drops the canvas runtime.
// Artboards that only show an uploaded image (/_blob/...) are skipped: those images are
// already saved in design/renders.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [srcDir, outDir] = process.argv.slice(2);
if (!srcDir || !outDir) {
  console.error('usage: node export-mockups.mjs <canvas-dir> <out-dir>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

for (const name of readdirSync(srcDir).filter((f) => f.endsWith('.dc.html')).sort()) {
  const src = readFileSync(join(srcDir, name), 'utf8');
  if (src.includes('/_blob/')) continue;
  const title = (src.match(/<title>(.*?)<\/title>/s) || [, name])[1];
  const helmet = (src.match(/<helmet>(.*?)<\/helmet>/s) || [, ''])[1].trim();
  const body = (src.match(/<\/helmet>(.*?)<\/x-dc>/s) || [, ''])[1].trim();
  if (!body) {
    console.log(`skip ${name}: no markup found`);
    continue;
  }
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
${helmet}
</head>
<body>
${body}
</body>
</html>
`;
  const out = name.replace('.dc.html', '.html');
  writeFileSync(join(outDir, out), html, 'utf8');
  console.log(out);
}
