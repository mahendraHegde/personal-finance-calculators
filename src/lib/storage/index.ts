// Public surface of the pluggable storage layer.
export type {
  Collection,
  CollectionSpec,
  Direction,
  Entity,
  ImportMode,
  ImportOptions,
  IndexKey,
  IndexSpec,
  Page,
  PageQuery,
  QueryRange,
  StorageAdapter,
  StorageSchema,
} from "./types";
export { createMemoryStorage } from "./memory-adapter";
export { openIndexedDB } from "./indexeddb-adapter";
