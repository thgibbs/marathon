/**
 * Minimal Socket Mode connectivity check (for the local smoke). Opens a
 * connection with the app-level token and resolves on the first `hello` frame.
 * Uses the global WebSocket (Node ≥ 22). A full event loop comes with the
 * production gateway; this just proves inbound connectivity without a tunnel.
 */
export async function verifySocketMode(appToken: string, timeoutMs = 10_000): Promise<boolean> {
  const res = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/x-www-form-urlencoded" },
  });
  const j = (await res.json()) as { ok: boolean; url?: string; error?: string };
  if (!j.ok || !j.url) throw new Error(`apps.connections.open: ${j.error ?? "no url"}`);

  return await new Promise<boolean>((resolve, reject) => {
    // eslint-disable-next-line no-undef
    const ws = new WebSocket(j.url!);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error("socket mode hello timeout"));
    }, timeoutMs);
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "hello") {
          clearTimeout(timer);
          ws.close();
          resolve(true);
        }
      } catch {
        /* ignore non-JSON frames */
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("socket mode connection error"));
    };
  });
}
