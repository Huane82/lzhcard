# Lzhcard Self-Hosted Backend & Migration Toolkit (Stage 1)

## Contents
- `migrations/001_initial_schema.sql`: PostgreSQL 18 schema covering all 33 tables, triggers, indexes, and constraints.
- `src/db/migrate.ts`: Versioned SQL migration runner with SHA-256 verification.
- `src/etl/firebaseToPg.ts`: Idempotent Firebase (Auth + Firestore + RTDB) -> PostgreSQL 18 ETL CLI (`--mode=full`, `--mode=incremental`, `--dry-run`).
- `src/etl/reconcile.ts`: Independent verification & 20-account cross-role reconciliation CLI.

## Usage (Ubuntu `/opt/lzhcard/server` or Windows)
1. Copy `.env.example` to `.env` (keep `chmod 600 .env`, never commit `.env` or service account JSON files).
2. Install dependencies & build:
   ```bash
   npm ci
   npm run build
   ```
3. Check & apply migrations (always run `pg_dump` backup first):
   ```bash
   npm run migrate:status
   npm run migrate
   ```
4. Run ETL dry-run, full run, and reconciliation:
   ```bash
   npm run etl:dry-run
   npm run etl:full
   npm run etl:reconcile
   ```
