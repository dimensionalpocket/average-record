import { Database as BunSqlite, type DatabaseOptions } from "bun:sqlite";
import { existsSync } from "fs";
import { dirname } from "path";
import { Database } from "./Database";

export class BunSqliteDatabase extends Database<BunSqlite> {
  private db: BunSqlite | null = null;
  private lastUsed = 0;
  private intervalId: Timer | null = null;

  constructor(
    name: string,
    private readonly path: string,
    private readonly options?: DatabaseOptions,
    private readonly initializationCommands?: string[],
    private readonly idleTimeoutMs?: number,
  ) {
    super(name);
    if (this.idleTimeoutMs !== undefined) {
      const checkInterval = Math.min(this.idleTimeoutMs / 2, 1000);
      this.intervalId = setInterval(
        checkDatabaseIdle,
        checkInterval,
        this,
      ).unref();
    }
  }

  getDb(): BunSqlite {
    this.lastUsed = Date.now();
    if (this.db === null) {
      this.db = new BunSqlite(this.path, this.options);
      if (this.initializationCommands) {
        for (const cmd of this.initializationCommands) {
          this.db.run(cmd);
        }
      }
      if (this.path !== ":memory:") {
        const extra =
          this.idleTimeoutMs !== undefined
            ? ` (idleTimeoutMs=${this.idleTimeoutMs})`
            : "";
        this.logger.log(`Opened: ${this.path}${extra}`);
      }
    }
    return this.db;
  }

  checkIdle(): void {
    if (
      this.idleTimeoutMs !== undefined &&
      this.db !== null &&
      Date.now() - this.lastUsed >= this.idleTimeoutMs
    ) {
      if (this.path !== ":memory:") {
        this.logger.log(
          `Closed due to inactivity: ${this.path} (idleTimeoutMs=${this.idleTimeoutMs})`,
        );
      }
      this.close();
    }
  }

  close(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.db && this.path !== ":memory:") {
      this.logger.log(`Closed: ${this.path}`);
    }
    this.db?.close();
    this.db = null;
  }

  backupToFile(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      throw new Error(`Directory does not exist: ${dir}`);
    }
    this.getDb().run("VACUUM INTO ?", [filePath]);
  }
}

function checkDatabaseIdle(db: BunSqliteDatabase): void {
  db.checkIdle();
}
