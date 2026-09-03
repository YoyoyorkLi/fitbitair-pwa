// Static file server for public/, for looking at the PWA in a browser.
//
//     node .claude/serve.mjs [port]     # then open http://localhost:8899
//
// `vercel dev` is the real local environment and the only one that serves
// /api/*; this is the cheaper thing you want most of the time, which is to
// look at the dashboard on a phone-sized viewport. With no /api/config to
// answer, app.js falls through to public/demo.json on its own -- the same
// path a signed-out visitor takes -- so no keys and no network are involved.
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

// No trailing separator: the containment check below appends one, and
// "public/" + "/" would never prefix-match a real path.
const root = fileURLToPath(new URL("../public", import.meta.url));
const port = Number(process.argv[2]) || 8899;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  const file = normalize(join(root, rel));
  // Same rule as pulse/cli.py's phone server: serve out of one directory and
  // nothing above it. A dev tool that leaks .env.local is still a leak.
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("404");
  }
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file)] || "application/octet-stream",
    // Never cache: the whole point is to reload after an edit.
    "Cache-Control": "no-store",
  });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`serving public/ on http://localhost:${port}`));
