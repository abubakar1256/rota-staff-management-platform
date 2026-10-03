import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const root = resolve(process.cwd(), "dist");
const port = Number(process.env.PORT || 5175);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const safeFilePath = (pathname) => {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const candidate = resolve(join(root, decodedPath.replace(/^\/+/, "")));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
};

const send = async (request, response, filePath) => {
  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      "Content-Type": contentTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
    });
    if (request.method !== "HEAD") response.end(file);
    else response.end();
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
};

const server = createServer(async (request, response) => {
  if (!request.url || !["GET", "HEAD"].includes(request.method || "GET")) {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  const url = new URL(request.url, "http://localhost");
  const requestedPath = safeFilePath(url.pathname);
  if (!requestedPath) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Bad request");
    return;
  }

  try {
    const requestedStats = await stat(requestedPath);
    if (requestedStats.isFile()) {
      await send(request, response, requestedPath);
      return;
    }
  } catch {
    // Client-side routes fall through to the SPA entry point.
  }

  await send(request, response, join(root, "index.html"));
});

server.listen(port, "0.0.0.0", () => {
  console.log("Rota frontend listening on port " + port);
});
