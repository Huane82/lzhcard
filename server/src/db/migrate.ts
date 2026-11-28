import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPgPool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

interface MigrationFile {
  version: string;
  filePath: string;
  sql: string;
  checksum: string;
}

async function loadMigrations(): Promise<MigrationFile[]> {
  const entries = await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const sqlFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const out: MigrationFile[] = [];
  for (const name of sqlFiles) {
    const resolved = path.resolve(MIGRATIONS_DIR, name);
    if (!resolved.startsWith(MIGRATIONS_DIR + path.sep)) {
      throw new Error(`Unsafe migration path rejected: ${name}`);
    }
    const sql = await fs.readFile(resolved, 'utf8');
    const checksum = crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
    out.push({ version: name, filePath: resolved, sql, checksum });
  }
  return out;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const statusOnly = args.has('--status');
  const dryRun = args.has('--dry-run');

  const pool = createPgPool();
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const appliedRes = await client.query<{ version: string; checksum: string; applied_at: Date }>(
      'SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version ASC'
    );
    const appliedMap = new Map(appliedRes.rows.map((r) => [r.version, r]));
    const migrations = await loadMigrations();

    if (statusOnly) {
      for (const m of migrations) {
        const applied = appliedMap.get(m.version);
        if (!applied) {
          console.log(`[PENDING] ${m.version} (${m.checksum.slice(0, 12)})`);
        } else if (applied.checksum !== m.checksum) {
          console.log(`[CHECKSUM_MISMATCH] ${m.version}`);
        } else {
          console.log(`[APPLIED] ${m.version} @ ${applied.applied_at.toISOString()}`);
        }
      }
      return;
    }

    for (const m of migrations) {
      const existing = appliedMap.get(m.version);
      if (existing) {
        if (existing.checksum !== m.checksum) {
          throw new Error(
            `Migration ${m.version} checksum changed after application. Never modify applied migrations.`
          );
        }
        console.log(`[SKIP] ${m.version} already applied`);
        continue;
      }

      if (dryRun) {
        console.log(`[DRY-RUN] Would apply ${m.version} (${m.checksum.slice(0, 12)})`);
        continue;
      }

      console.log(`[APPLY] ${m.version}...`);
      // Migration SQL may manage its own BEGIN/COMMIT; verify checksum & record inside transaction.
      await client.query(m.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
        [m.version, m.checksum]
      );
      console.log(`[DONE] ${m.version}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration runner failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
