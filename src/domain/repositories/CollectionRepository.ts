import db from '@/lib/db';
import { randomUUID } from 'crypto';

export class CollectionRepository {
  static getAllCollections(): any[] {
    const stmt = db.prepare('SELECT * FROM collections ORDER BY createdAt DESC');
    return stmt.all();
  }

  static createCollection(name: string): string {
    const id = randomUUID();
    const insertStmt = db.prepare('INSERT INTO collections (id, name) VALUES (?, ?)');
    insertStmt.run(id, name);
    return id;
  }
  
  static getCollection(id: string): any {
    return db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
  }

  static deleteCollection(id: string): void {
    db.prepare('DELETE FROM collections WHERE id = ?').run(id);
  }
}
