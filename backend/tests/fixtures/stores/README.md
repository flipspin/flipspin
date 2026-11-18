# Synthetic release stores

Generated from historical source, not the migration implementation. The commit
ids below are from the pre-release history. All identifiers,
credentials and music paths are fabricated. Neither SQLite file has user_version
or application_id set, matching the releases that created them.

- `today`: ledger, acquisition, upload and listening DDL at `2cb0e94` (before the
  migration runner); at least one row in every table, plus a visible helper lease.
- `pre-77b11d5`: ledger/acquisition DDL at `73fd989`, before uploads at `57faf64`
  and the quoted-name fix at `77b11d5`. The acquisition kind rebuild already
  produced `CREATE TABLE "jobs"`; the next upload-kind migration used to fail.

JSON files represent today's versions and a claimed synthetic server. Tests
also replay the separate users_v1.json/users_v2.json fixtures with backups.
