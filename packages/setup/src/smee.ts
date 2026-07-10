/**
 * Create a fresh smee.io channel for dev webhook delivery. `GET /new`
 * answers with a redirect whose Location is the new channel URL; the channel
 * is stable, so it's created once at registration time, baked into the
 * GitHub App's webhook URL, and written to MARATHON_WEBHOOK_PROXY (the live
 * github-app subscribes outbound to it — see surface-github/webhook-proxy).
 */
export async function createSmeeChannel(fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn("https://smee.io/new", { method: "HEAD", redirect: "manual" });
  const location = res.headers.get("location");
  if (res.status < 300 || res.status >= 400 || !location || !location.startsWith("https://smee.io/")) {
    throw new Error(`smee.io/new did not redirect to a channel (HTTP ${res.status})`);
  }
  return location;
}
