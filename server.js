#!/usr/bin/env node

// Local development only — not deployed to Cloudflare.
// Run: node server.js
// Then open: http://localhost:3000

const http = require("http");
const fs   = require("fs");
const path = require("path");

const PORT    = 3000;
const HTML    = path.join(__dirname, "public", "index.html");
const API_BASE = "https://api.optimizely.com";

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    fs.createReadStream(HTML).pipe(res);
    return;
  }

  if (req.url.startsWith("/api/")) {
    const target = API_BASE + req.url.slice(4);

    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const fetchOpts = {
          method: req.method,
          headers: {
            "Authorization": req.headers["authorization"] || "",
            "Content-Type":  "application/json",
          },
        };
        if (body) fetchOpts.body = body;

        console.log(`→ ${req.method} ${target}`);
        const apiRes = await fetch(target, fetchOpts);
        const text   = await apiRes.text();
        console.log(`← ${apiRes.status}`);

        res.writeHead(apiRes.status, { "Content-Type": "application/json" });
        res.end(text);
      } catch (e) {
        console.error("Proxy error:", e.message);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`\nOptimizely bulk archive running at http://localhost:${PORT}\n`);
});
