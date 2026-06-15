// Clean up draft releases and re-upload v1.0.1
const https = require("https");
const fs = require("fs");
const path = require("path");
const TOKEN = process.env.GH_TOKEN;
const OWNER = "thereign00";
const REPO = "inkframe";

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
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  // 1. List all releases (including drafts)
  console.log("Fetching releases...");
  const { data: releases } = await api("GET", `/repos/${OWNER}/${REPO}/releases`);
  
  // 2. Delete all v1.0.1 releases (drafts or published)
  for (const rel of releases) {
    if (rel.tag_name === "v1.0.1") {
      console.log(`Deleting ${rel.draft ? "draft" : "published"} release ${rel.id}...`);
      await api("DELETE", `/repos/${OWNER}/${REPO}/releases/${rel.id}`);
      console.log("  ✓ Deleted");
    }
  }
  
  // 3. Delete the v1.0.1 tag if it exists
  console.log("Deleting v1.0.1 tag...");
  const tagResult = await api("DELETE", `/repos/${OWNER}/${REPO}/git/refs/tags/v1.0.1`);
  console.log(`  Tag delete: ${tagResult.status === 204 ? "✓" : "not found (ok)"}`);
  
  console.log("\n✓ Cleanup done. Now run:");
  console.log('  set GH_TOKEN=... && npm run dist:publish');
}

main().catch(e => { console.error("Error:", e); process.exit(1); });
