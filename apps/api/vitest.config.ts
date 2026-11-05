import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Local runs read TEST_DATABASE_URL from the repo's .env; CI sets it in the environment.
const dotEnv = new URL('../../.env', import.meta.url);
if (existsSync(dotEnv)) process.loadEnvFile(dotEnv);

export default defineConfig({
  test: {
    // Integration tests share one database; run files one after another.
    fileParallelism: false,
  },
});
