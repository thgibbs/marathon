/*
 * Runs INSIDE the sandbox container (a stand-in for the Pi agent loop). It has NO
 * credentials and NO network. It does filesystem work on the mounted /workspace
 * (a stand-in for Pi's built-in read/grep/... tools) and obtains governed-tool
 * results ONLY by asking the host broker over stdio (stdout = requests as JSON
 * lines, stdin = responses). Proves the §12.6 host/sandbox split end to end.
 */
const fs = require("node:fs");
const WS = "/workspace";

// minimal broker client over stdio (correlate responses by id)
let buf = "";
let nextId = 0;
const pending = new Map();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      const resolve = pending.get(m.id);
      if (resolve) {
        pending.delete(m.id);
        resolve(m);
      }
    } catch {
      /* ignore non-JSON */
    }
  }
});
function broker(tool, input) {
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    process.stdout.write(JSON.stringify({ id, tool, input }) + "\n");
  });
}

(async () => {
  // 1. workspace FS work (no host filesystem is visible here, only /workspace)
  const raw = fs.readFileSync(`${WS}/input.txt`, "utf8").trim();
  fs.writeFileSync(`${WS}/work.txt`, raw.toUpperCase() + "\n");

  // 2. governed tools via the host broker — this process holds no credentials
  const lookup = await broker("host.lookup", { q: raw });
  const del = await broker("host.delete", { id: 1 });

  // 3. leave a result for the host to assert
  fs.writeFileSync(
    `${WS}/output.txt`,
    JSON.stringify({
      workDone: fs.existsSync(`${WS}/work.txt`),
      lookupStatus: lookup.status,
      lookupContent: lookup.content,
      destructiveStatus: del.status,
    }) + "\n",
  );
  process.stderr.write("[sandbox-agent] done\n");
  process.exit(0);
})().catch((e) => {
  process.stderr.write("[sandbox-agent] error: " + e + "\n");
  process.exit(1);
});
