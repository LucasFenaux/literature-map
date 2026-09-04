import db from '@/lib/db';
import { Paper } from '@/lib/openalex';

export class PaperRepository {
  static getPapersForCollection(collectionId: string): any[] {
    const stmt = db.prepare('SELECT * FROM papers WHERE collectionId = ? ORDER BY createdAt DESC');
    const rows = stmt.all(collectionId) as any[];
    return rows.map((row) => ({
      ...row,
      authors: JSON.parse(row.authors || '[]'),
      localTags: JSON.parse(row.localTags || '[]')
    }));
  }

  static getPaper(id: string, collectionId: string): any {
    const stmt = db.prepare('SELECT * FROM papers WHERE id = ? AND collectionId = ?');
    const row = stmt.get(id, collectionId) as any;
    if (!row) return null;
    return {
      ...row,
      authors: JSON.parse(row.authors || '[]'),
      localTags: JSON.parse(row.localTags || '[]')
    };
  }
  
  static getPaperStatus(id: string, collectionId: string): string | null {
    const stmt = db.prepare('SELECT status FROM papers WHERE id = ? AND collectionId = ?');
    const row = stmt.get(id, collectionId) as any;
    return row ? row.status : null;
  }

  static updatePaperStatus(id: string, collectionId: string, status: string): void {
    db.prepare('UPDATE papers SET status = ? WHERE id = ? AND collectionId = ?').run(status, id, collectionId);
  }

  static updatePaper(id: string, collectionId: string, status: string, localTags: string, notes: string): void {
    db.prepare('UPDATE papers SET status = ?, localTags = ?, notes = ? WHERE id = ? AND collectionId = ?').run(status, localTags, notes, id, collectionId);
  }

  static addPaper(paper: any, collectionId: string, status: string = 'seed'): void {
    const insertStmt = db.prepare(`
      INSERT INTO papers (id, collectionId, doi, title, abstract, authors, year, publicationDate, citationCount, url, venue, status, localTags, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '')
    `);

    let authorsJson = '[]';
    if (Array.isArray(paper.authors)) {
      authorsJson = JSON.stringify(paper.authors);
    } else if (typeof paper.authors === 'string') {
      try {
        JSON.parse(paper.authors);
        authorsJson = paper.authors;
      } catch {
        authorsJson = JSON.stringify([paper.authors]);
      }
    }

    insertStmt.run(
      paper.id,
      collectionId,
      paper.doi || null,
      paper.title,
      paper.abstract || '',
      authorsJson,
      paper.year || new Date().getFullYear(),
      paper.publicationDate || null,
      paper.citationCount || 0,
      paper.url || '',
      paper.venue || '',
      status
    );
  }

  static getBasicPapersForCollectionByStatus(collectionId: string, status: string): { id: string, title: string }[] {
    return db.prepare('SELECT id, title FROM papers WHERE collectionId = ? AND status = ?').all(collectionId, status) as { id: string, title: string }[];
  }
  
  static getIdsForCollection(collectionId: string): { id: string }[] {
    return db.prepare('SELECT id FROM papers WHERE collectionId = ?').all(collectionId) as { id: string }[];
  }

  static clearCollection(collectionId: string): void {
    db.prepare('DELETE FROM papers WHERE collectionId = ?').run(collectionId);
  }

  static getPaperById(id: string): any {
    return db.prepare('SELECT * FROM papers WHERE id = ?').get(id);
  }

  static deletePaper(id: string, collectionId: string): void {
    db.prepare('DELETE FROM papers WHERE id = ? AND collectionId = ?').run(id, collectionId);
  }

  static updatePaperLocalTags(id: string, collectionId: string, tagsJson: string): void {
    db.prepare('UPDATE papers SET localTags = ? WHERE id = ? AND collectionId = ?').run(tagsJson, id, collectionId);
  }
  
  static updatePaperNotes(id: string, collectionId: string, notes: string): void {
    db.prepare('UPDATE papers SET notes = ? WHERE id = ? AND collectionId = ?').run(notes, id, collectionId);
  }

  static removeTagFromAll(tagId: string): void {
    try {
      db.prepare(`
        UPDATE papers 
        SET localTags = (
          SELECT json_group_array(value) 
          FROM json_each(localTags) 
          WHERE value != ?
        )
        WHERE localTags LIKE '%' || ? || '%'
      `).run(tagId, tagId);
    } catch (e) {
      console.warn("Failed to clean up tags from papers natively, relying on frontend cleanup.", e);
    }
  }

  static clearNonSeedPapers(collectionId: string): void {
    db.transaction(() => {
      const selectStmt = db.prepare(`SELECT id FROM papers WHERE collectionId = ? AND status != 'seed' AND status != 'collection'`);
      const relatedPapers = selectStmt.all(collectionId) as { id: string }[];
      const relatedIds = relatedPapers.map(p => p.id);
      
      if (relatedIds.length > 0) {
        const placeholders = relatedIds.map(() => '?').join(',');
        const deleteStmt = db.prepare(`DELETE FROM papers WHERE collectionId = ? AND id IN (${placeholders})`);
        deleteStmt.run(collectionId, ...relatedIds);
      }
    })();
  }
}
