// Create GitHub Release and upload assets
const https = require("https");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.GH_TOKEN;
const OWNER = "thereign00";
const REPO = "inkframe";

function apiRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.github.com",
      path: urlPath,
      method,
      headers: {
        Authorization: `token ${TOKEN}`,
        "User-Agent": "inkframe-release",
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
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function uploadAsset(uploadUrl, filePath, contentType) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(filePath);
    const stat = fs.statSync(filePath);
    const url = new URL(uploadUrl.replace("{?name,label}", `?name=${encodeURIComponent(fileName)}`));
    
    console.log(`  Uploading ${fileName} (${(stat.size / 1e6).toFixed(1)} MB)...`);
    
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        Authorization: `token ${TOKEN}`,
        "User-Agent": "inkframe-release",
        "Content-Type": contentType,
        "Content-Length": stat.size,
      },
    };
    const req = https.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        if (res.statusCode === 201) {
          console.log(`  ✓ ${fileName} uploaded`);
          resolve();
        } else {
          console.error(`  ✗ ${fileName} failed (${res.statusCode}): ${raw.slice(0, 200)}`);
          reject(new Error(`Upload failed: ${res.statusCode}`));
        }
      });
    });
    req.on("error", reject);
    
    // Stream the file
    const stream = fs.createReadStream(filePath);
    stream.pipe(req);
  });
}

async function main() {
  console.log("Creating GitHub Release v1.0.1...");
  
  const { status, data } = await apiRequest("POST", `/repos/${OWNER}/${REPO}/releases`, {
    tag_name: "v1.0.1",
    name: "Inkframe v1.0.1",
    body: "Fix: better-sqlite3 native module now correctly rebuilt for Electron ABI. Fixes startup crash on fresh installs.",
    draft: false,
    prerelease: false,
  });

  if (status === 201) {
    console.log(`✓ Release created: ${data.html_url}`);
  } else if (status === 422 && JSON.stringify(data).includes("already_exists")) {
    console.log("Release already exists, fetching it...");
    const existing = await apiRequest("GET", `/repos/${OWNER}/${REPO}/releases/tags/v1.0.1`);
    Object.assign(data, existing.data);
  } else {
    console.error(`✗ Failed to create release (${status}):`, data);
    process.exit(1);
  }

  const uploadUrl = data.upload_url;
  if (!uploadUrl) {
    console.error("No upload_url in response");
    process.exit(1);
  }

  // Upload assets
  const distDir = path.join(process.cwd(), "dist-electron");
  const assets = [
    { file: "latest.yml", type: "application/x-yaml" },
    { file: "Inkframe-Setup-1.0.1.exe.blockmap", type: "application/octet-stream" },
    { file: "Inkframe-Setup-1.0.1.exe", type: "application/octet-stream" },
  ];

  console.log("\nUploading assets...");
  for (const asset of assets) {
    const filePath = path.join(distDir, asset.file);
    if (!fs.existsSync(filePath)) {
      console.warn(`  ⚠ ${asset.file} not found, skipping`);
      continue;
    }
    await uploadAsset(uploadUrl, filePath, asset.type);
  }

  console.log("\n✓ All done! Release: https://github.com/thereign00/inkframe/releases/tag/v1.0.1");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
