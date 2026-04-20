import process from 'node:process';

interface SeedRegistration {
  name: string;
  run: () => Promise<void>;
}

// Modules register seeds here as they land. Keep declaration order
// equal to dependency order (foundation first, then data platform, etc.)
const SEEDS: SeedRegistration[] = [];

function assertLocalDatabase(): void {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch (err: unknown) {
    throw new Error(`DATABASE_URL is not a parseable URL: ${String(err)}`);
  }
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error(`refusing to seed non-local DATABASE_URL (host: ${host})`);
  }
}

async function main(): Promise<void> {
  assertLocalDatabase();

  if (SEEDS.length === 0) {
    console.warn('No seeds registered yet. Seeds land in later prompts (P0.4+).');
    return;
  }

  for (const seed of SEEDS) {
    console.warn(`seeding: ${seed.name}`);
    await seed.run();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
