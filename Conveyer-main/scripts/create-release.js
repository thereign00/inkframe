// Upload release asset with progress logging and long timeout
const https = require("https");
const fs = require("fs");
const path = require("path");
const TOKEN = process.env.GH_TOKEN;
const OWNER = "thereign00";
const REPO = "inkframe";
const VERSION = process.argv[2] || "1.0.2";

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.github.com",
      path: urlPath,
      method,
      headers: {
        Authorization: `token ${TOKEN}`,
        "User-Agent": "inkframe",
        Accept: "application/vnd.github.v3+json",
      },
    };
    if (body) {
      const data = JSON.stringify(body);
      opts.headers["Content-Type"] = "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(data);
    }
    const req = https.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  // 1. Delete all releases for this version (draft or published)
  console.log("Cleaning up old releases...");
  const { data: releases } = await api("GET", `/repos/${OWNER}/${REPO}/releases`);
  for (const rel of releases) {
    if (rel.tag_name === `v${VERSION}`) {
      console.log(`  Deleting release ${rel.id} (${rel.draft ? "draft" : "published"})...`);
      await api("DELETE", `/repos/${OWNER}/${REPO}/releases/${rel.id}`);
    }
  }

  // 2. Delete tag
  await api("DELETE", `/repos/${OWNER}/${REPO}/git/refs/tags/v${VERSION}`);

  // 3. Create release (non-draft, so electron-updater can see it)
  console.log(`Creating release v${VERSION}...`);
  const { status, data } = await api("POST", `/repos/${OWNER}/${REPO}/releases`, {
    tag_name: `v${VERSION}`,
    name: `Inkframe v${VERSION}`,
    body: `v${VERSION} — Fix dialogs, right-click context menu, text selection in Electron`,
    draft: false,
    prerelease: false,
  });
  
  if (status !== 201) {
    console.error("Failed to create release:", status, data);
    process.exit(1);
  }
  console.log(`✓ Release created: ${data.html_url}`);
  const uploadUrl = data.upload_url;

  // 4. Upload small files first
  const distDir = path.join(process.cwd(), "dist-electron");
  const smallFiles = [
    { file: "latest.yml", type: "application/x-yaml" },
    { file: `Inkframe-Setup-${VERSION}.exe.blockmap`, type: "application/octet-stream" },
  ];

  for (const asset of smallFiles) {
    const filePath = path.join(distDir, asset.file);
    if (!fs.existsSync(filePath)) { console.warn(`  ⚠ ${asset.file} not found`); continue; }
    console.log(`Uploading ${asset.file}...`);
    
    const url = new URL(uploadUrl.replace("{?name,label}", `?name=${encodeURIComponent(asset.file)}`));
    const fileData = fs.readFileSync(filePath);
    
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          Authorization: `token ${TOKEN}`,
          "User-Agent": "inkframe",
          "Content-Type": asset.type,
          "Content-Length": fileData.length,
        },
      }, (res) => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => resolve({ status: res.statusCode, data: d }));
      });
      req.on("error", reject);
      req.write(fileData);
      req.end();
    });
    
    console.log(`  ✓ ${asset.file} (${result.status})`);
  }

  // 5. Upload the big exe using streaming with progress and keepalive
  const exeFile = `Inkframe-Setup-${VERSION}.exe`;
  const exePath = path.join(distDir, exeFile);
  if (!fs.existsSync(exePath)) { console.error(`✗ ${exeFile} not found!`); process.exit(1); }
  
  const stat = fs.statSync(exePath);
  console.log(`\nUploading ${exeFile} (${(stat.size / 1e9).toFixed(2)} GB)...`);
  console.log("This will take a while. Progress logged every 30s.");

  const url = new URL(uploadUrl.replace("{?name,label}", `?name=${encodeURIComponent(exeFile)}`));
  
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        Authorization: `token ${TOKEN}`,
        "User-Agent": "inkframe",
        "Content-Type": "application/octet-stream",
        "Content-Length": stat.size,
      },
      // No timeout - let it run as long as needed
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode === 201) {
          console.log(`\n✓ ${exeFile} uploaded successfully!`);
          resolve();
        } else {
          console.error(`\n✗ Upload failed (${res.statusCode}): ${d.slice(0, 300)}`);
          reject(new Error("Upload failed"));
        }
      });
    });
    
    req.on("error", (err) => {
      console.error(`\n✗ Upload error: ${err.message}`);
      reject(err);
    });

    // Stream file with progress
    const stream = fs.createReadStream(exePath, { highWaterMark: 1024 * 1024 }); // 1MB chunks
    let uploaded = 0;
    let lastLog = Date.now();
    
    stream.on("data", (chunk) => {
      uploaded += chunk.length;
      const now = Date.now();
      if (now - lastLog > 30000) { // Log every 30s
        const pct = ((uploaded / stat.size) * 100).toFixed(1);
        const mbUploaded = (uploaded / 1e6).toFixed(0);
        const mbTotal = (stat.size / 1e6).toFixed(0);
        console.log(`  ${pct}% (${mbUploaded}/${mbTotal} MB)`);
        lastLog = now;
      }
    });
    
    stream.pipe(req);
  });

  console.log(`\n✓ All done! Release: https://github.com/${OWNER}/${REPO}/releases/tag/v${VERSION}`);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
