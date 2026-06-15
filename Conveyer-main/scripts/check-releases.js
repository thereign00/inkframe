const https = require("https");
const TOKEN = process.env.GH_TOKEN;
const opts = {
  hostname: "api.github.com",
  path: "/repos/thereign00/inkframe/releases",
  headers: { Authorization: "token " + TOKEN, "User-Agent": "x" },
};
https.get(opts, (r) => {
  let d = "";
  r.on("data", (c) => (d += c));
  r.on("end", () => {
    const releases = JSON.parse(d);
    if (!releases.length) { console.log("No releases found"); return; }
    releases.forEach((x) => {
      console.log(x.tag_name, x.draft ? "DRAFT" : "PUBLISHED");
      x.assets.forEach((a) =>
        console.log("  ", a.name, a.state, (a.size / 1e6).toFixed(1) + "MB")
      );
    });
  });
});
