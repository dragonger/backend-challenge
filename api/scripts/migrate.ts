/**
 * Migration CLI built on the MikroORM Migrator, run directly by Bun.
 *
 *   bun scripts/migrate.ts up [--to <name>]
 *   bun scripts/migrate.ts down [--all | --to <name>]   (default: last one)
 *   bun scripts/migrate.ts create [name]                (blank migration)
 *   bun scripts/migrate.ts status
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { buildMikroOrmConfig } from '../src/infrastructure/database/mikro-orm.config.js';

const [command = 'status', ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
};

const dbName = process.env.MIGRATION_DB_NAME || undefined;
const orm = await MikroORM.init(buildMikroOrmConfig({ dbName }));

try {
  const migrator = orm.migrator;

  switch (command) {
    case 'up': {
      const to = flag('--to');
      const done = await migrator.up(to ? { to } : undefined);
      console.log(`Applied ${done.length} migration(s)`);
      for (const m of done) console.log(` + ${m.name}`);
      break;
    }
    case 'down': {
      const all = rest.includes('--all');
      const to = flag('--to');
      const done = await migrator.down(all ? { to: 0 } : to ? { to } : undefined);
      console.log(`Reverted ${done.length} migration(s)`);
      for (const m of done) console.log(` - ${m.name}`);
      break;
    }
    case 'create': {
      const created = await migrator.create(rest[0], true);
      console.log(`Created ${created.fileName}`);
      break;
    }
    case 'status': {
      const pending = await migrator.getPending();
      const executed = await migrator.getExecuted();
      console.log(`Executed: ${executed.length}, pending: ${pending.length}`);
      for (const m of pending) console.log(` ? ${m.name}`);
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} finally {
  await orm.close(true);
}
