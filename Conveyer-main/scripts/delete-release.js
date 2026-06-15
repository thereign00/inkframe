const https = require("https");
const TOKEN = process.env.GH_TOKEN;
const releaseId = process.argv[2] || "339275146";

const opts = {
  hostname: "api.github.com",
  path: `/repos/thereign00/inkframe/releases/${releaseId}`,
  method: "DELETE",
  headers: {
    Authorization: `token ${TOKEN}`,
    "User-Agent": "inkframe-release",
  },
};

const req = https.request(opts, (res) => {
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => {
    console.log(`Status: ${res.statusCode}`);
    if (data) console.log(data);
    if (res.statusCode === 204) console.log("✓ Release deleted");
    else console.log("✗ Delete failed");
  });
});
req.end();
