import { TaggedLogger } from "@dimensionalpocket/tagged-logger";

export abstract class Database<T = any> {
  readonly name: string;
  readonly logger: TaggedLogger;

  constructor(name: string) {
    this.name = name;
    this.logger = new TaggedLogger(`[Database:${name}]`);
  }

  abstract getDb(): T;
  abstract checkIdle(): void;
  abstract close(): void;
  abstract backupToFile(filePath: string): void;
}
