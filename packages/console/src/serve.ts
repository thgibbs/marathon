/**
 * Run the recent-commands console (design/recent-commands-view.md).
 * Localhost-bound, read-only. `GET /commands?tenantId=...`, `GET /tasks/:id?tenantId=...`.
 */
import { Database } from "@marathon/db";
import { createConsoleServer, listenConsoleServer } from "./server";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://marathon:marathon@localhost:5432/marathon";
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 8788);
  const db = new Database(databaseUrl);
  const server = createConsoleServer(db);
  const url = await listenConsoleServer(server, host, port);
  console.log(`[console] listening on ${url}`);
}

main().catch((err) => {
  console.error("console FAILED:", err);
  process.exit(1);
});
