import { Database } from "./Database";
import { Migrator, type MigratorOptions } from "./Migrator";

export interface MigrationExecutorDefaults {
  migrationsDir?: string;
  schemaPath?: string;
  pwd?: string;
}

const HELP_TEXT = `
Usage: migrate [options]

Options:
  --version, -v <number>      Target version to migrate to
  --up                        Apply pending migrations (default)
  --down                      Roll back migrations
  --migrations-dir <path>     Path to migrations directory
  --schema-path <path>        Path for schema dump output
  --dump                      Dump schema after migration
  --silent, -s                Suppress console output
  --pwd <path>                Base path for resolving relative paths
  --help, -h                  Show this help text
`.trim();

export class MigrationExecutor {
  #db: Database;
  #defaults: MigrationExecutorDefaults;
  #argv: string[];

  constructor(
    db: Database,
    defaults: MigrationExecutorDefaults = {},
    argv = process.argv,
  ) {
    this.#db = db;
    this.#defaults = defaults;
    this.#argv = argv;
  }

  run(): void {
    const args = this.#argv.slice(2);

    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
      console.log(HELP_TEXT);
      return;
    }

    try {
      const options = this.parseArgs(args);
      const migrator = new Migrator(this.#db, options);
      migrator.run();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  parseArgs(args: string[]): MigratorOptions {
    const options: MigratorOptions = {};

    if (this.#defaults.migrationsDir) {
      options.migrationsDir = this.#defaults.migrationsDir;
    }
    if (this.#defaults.schemaPath) {
      options.schemaPath = this.#defaults.schemaPath;
    }
    if (this.#defaults.pwd) {
      options.pwd = this.#defaults.pwd;
    }

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const next = args[i + 1];

      switch (arg) {
        case "--version":
        case "-v":
          options.version = parseInt(this.#consumeValue(arg, next), 10);
          i++;
          break;
        case "--up":
          options.direction = "up";
          break;
        case "--down":
          options.direction = "down";
          break;
        case "--migrations-dir":
          options.migrationsDir = this.#consumeValue(arg, next);
          i++;
          break;
        case "--schema-path":
          options.schemaPath = this.#consumeValue(arg, next);
          i++;
          break;
        case "--dump":
          options.dump = true;
          break;
        case "--silent":
        case "-s":
          options.silent = true;
          break;
        case "--pwd":
          options.pwd = this.#consumeValue(arg, next);
          i++;
          break;
        default:
          throw new Error(`Unknown option: ${arg}`);
      }
    }

    return options;
  }

  #consumeValue(flag: string, value: string | undefined): string {
    if (!value || value.startsWith("-")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return value;
  }
}
