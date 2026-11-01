export function installIndexedDBLifetime(IndexedDB) {
  const metadata = new WeakMap();
  for (const name of ['runInTransaction', 'compareAndSwap', 'getKeyValues']) {
    const operation = IndexedDB.prototype[name];
    IndexedDB.prototype[name] = async function (...args) {
      if (!this.database) return operation.apply(this, args);
      let description = metadata.get(this);
      if (!description) {
        description = {
          version: this.database.version,
          stores: Array.from(this.database.objectStoreNames),
        };
        metadata.set(this, description);
      }
      const database = await IndexedDB.openDatabase(
        this.name, description.version, description.stores,
      );
      if (!this.database) {
        database.close();
        return operation.apply(this, args);
      }
      const scoped = new IndexedDB(database, this.name);
      scoped.pendingTransactions = this.pendingTransactions;
      try {
        return await operation.apply(scoped, args);
      } finally {
        database.close();
      }
    };
  }
}
