import db from '@/lib/db';
import crypto from 'crypto';

export class TagRepository {
  static getAllTags(): any[] {
    const stmt = db.prepare('SELECT * FROM tags ORDER BY weight DESC, name ASC');
    return stmt.all();
  }

  static createTag(name: string, color: string = '#888888', weight: number = 0): { id: string, name: string, color: string, weight: number } {
    const id = crypto.randomUUID();
    const insertStmt = db.prepare(`
      INSERT INTO tags (id, name, color, weight)
      VALUES (?, ?, ?, ?)
    `);
    insertStmt.run(id, name, color, weight);
    return { id, name, color, weight };
  }
  
  static updateTag(id: string, name: string, color: string, weight: number): void {
    db.prepare('UPDATE tags SET name = ?, color = ?, weight = ? WHERE id = ?').run(name, color, weight, id);
  }

  static getTag(id: string): any {
    return db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
  }

  static deleteTag(id: string): number {
    return db.prepare('DELETE FROM tags WHERE id = ?').run(id).changes;
  }
}
