// Publish all draft releases for a given version
const https = require("https");
const TOKEN = process.env.GH_TOKEN;
const VERSION = process.argv[2] || "1.0.4";

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.github.com",
      path,
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
  const { data: releases } = await api("GET", "/repos/thereign00/inkframe/releases");
  
  for (const rel of releases) {
    if (rel.tag_name === `v${VERSION}` && rel.draft) {
      console.log(`Publishing v${VERSION} (release id: ${rel.id})...`);
      const { status, data } = await api("PATCH", `/repos/thereign00/inkframe/releases/${rel.id}`, {
        draft: false,
      });
      if (status === 200) {
        console.log(`✓ Published: ${data.html_url}`);
      } else {
        console.error(`✗ Failed (${status}):`, data.message || data);
      }
    }
  }

  // Also clean up old drafts (v1.0.2 empty draft)
  for (const rel of releases) {
    if (rel.draft && rel.assets && rel.assets.length === 0) {
      console.log(`Deleting empty draft: ${rel.tag_name} (${rel.id})`);
      await api("DELETE", `/repos/thereign00/inkframe/releases/${rel.id}`);
    }
  }
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
