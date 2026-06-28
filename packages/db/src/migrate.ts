import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadConfig } from "@marathon/config";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Apply any pending SQL migrations in order, each in its own transaction. */
export async function migrate(
  databaseUrl: string = loadConfig().databaseUrl,
): Promise<string[]> {
  const pool = new Pool({ connectionString: databaseUrl });
  const applied: string[] = [];
  try {
    await pool.query(
      `create table if not exists schema_migrations (
         name text primary key,
         applied_at timestamptz not null default now()
       )`,
    );

    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const { rows } = await pool.query(
        "select 1 from schema_migrations where name = $1",
        [file],
      );
      if (rows.length > 0) continue;

      const sql = await readFile(join(migrationsDir, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations(name) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }
    return applied;
  } finally {
    await pool.end();
  }
}

const runDirectly =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1];

if (runDirectly) {
  migrate()
    .then((applied) => {
      console.log(
        applied.length ? `applied: ${applied.join(", ")}` : "no pending migrations",
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
