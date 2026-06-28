import { verifyGithubSignature } from "@marathon/surface-github";
import { dispatchGithubEvent, type GithubAppDeps } from "./handlers";

export interface WebhookRequest {
  eventType: string;
  deliveryId?: string;
  signature?: string;
  rawBody: string;
}

export interface WebhookResult {
  status: number;
  note?: string;
}

/**
 * Handle one GitHub webhook delivery: verify signature, dedupe by delivery id,
 * then classify + dispatch. Pure of any HTTP framework (testable).
 */
export async function handleWebhookRequest(
  deps: GithubAppDeps,
  secret: string,
  req: WebhookRequest,
): Promise<WebhookResult> {
  if (!verifyGithubSignature(secret, req.rawBody, req.signature)) {
    return { status: 401, note: "invalid signature" };
  }
  if (req.deliveryId) {
    const fresh = await deps.db.claim(`github:delivery:${req.deliveryId}`);
    if (!fresh) return { status: 200, note: "duplicate delivery" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, note: "invalid json" };
  }
  await dispatchGithubEvent(deps, req.eventType, payload);
  return { status: 200 };
}
