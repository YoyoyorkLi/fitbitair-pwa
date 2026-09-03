// Build a single self-contained HTML file from the real PWA sources.
//
//     node build-preview.mjs [out.html]
//
// This exists so the shareable preview cannot drift from the app. It does not
// reimplement anything: it inlines public/styles.css, public/charts.js,
// public/app.js and public/demo.json into one file. If a chart looks wrong in
// the preview, it is wrong in the PWA, and vice versa.
//
// The only transform is turning the two ES modules into one inline script:
// charts.js becomes an object literal named `ch`, and app.js has its imports
// stripped. Supabase is dropped entirely — a static file has no /api/config,
// so app.js falls through to the demo fixture on its own.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), "utf8");
const out = process.argv[2] || join(here, "preview.html");

const css = read("public/styles.css");
const html = read("public/index.html");
const charts = read("public/charts.js");
const app = read("public/app.js");
const demo = read("public/demo.json");

// everything charts.js exports, so the wrapper can hand it back as one object
const names = [...charts.matchAll(/^export\s+(?:async\s+)?(?:function|const|let)\s+([A-Za-z_$][\w$]*)/gm)]
  .map((m) => m[1]);
if (!names.length) throw new Error("no exports found in charts.js — did the file move?");

const chartsInline = charts.replace(/^export\s+/gm, "");
const appInline = app
  .replace(/^import[^;]+;\s*$/gm, "")                  // drop both imports
  .replace(/\bcreateClient\b/g, "(() => null)")        // supabase never runs here
  .replace(/^if \("serviceWorker".*$/gm, "");          // no /sw.js in a single file

// body of index.html, minus the module script tag we are replacing
const body = html
  .replace(/[\s\S]*<body[^>]*>/i, "")
  .replace(/<\/body>[\s\S]*/i, "")
  .replace(/<script[\s\S]*?<\/script>/gi, "");

const page = `<title>Pulse Dashboard Preview</title>
<style>
${css}
/* preview chrome: the artifact has no service worker or safe-area insets */
body{padding:26px 18px 70px}
</style>
${body}
<script type="module">
window.__PULSE_DEMO__ = ${demo};

const ch = (() => {
${chartsInline}
return { ${names.join(", ")} };
})();

${appInline}
</script>
`;

writeFileSync(out, page);
console.log(`${out}  ${(page.length / 1024).toFixed(1)}kb`);
console.log(`  charts.js exports inlined: ${names.length} (${names.slice(0, 6).join(", ")}…)`);
