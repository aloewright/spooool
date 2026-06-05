import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Runs once per worker pool; applyD1Migrations skips already-applied migrations.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
