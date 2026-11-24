// SPDX-License-Identifier: AGPL-3.0-only
if (!process.env.TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL is not set. Point it at a superuser on a throwaway Postgres, for example');
  console.error('  TEST_DATABASE_URL=postgres://postgres:<password>@127.0.0.1:55432/postgres');
  console.error('<password> is whatever the container was started with (POSTGRES_PASSWORD).');
  process.exit(1);
}
