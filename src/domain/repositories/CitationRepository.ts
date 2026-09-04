import db from '@/lib/db';

export class CitationRepository {
  static getLinksForCollection(collectionId: string): { source: string, target: string }[] {
    const stmt = db.prepare('SELECT sourceId as source, targetId as target FROM citations WHERE collectionId = ?');
    return stmt.all(collectionId) as { source: string, target: string }[];
  }

  static clearLinksForCollection(collectionId: string): void {
    db.prepare('DELETE FROM citations WHERE collectionId = ?').run(collectionId);
  }

  static addLinks(collectionId: string, links: { source: string, target: string }[]): void {
    const insertStmt = db.prepare('INSERT OR IGNORE INTO citations (collectionId, sourceId, targetId) VALUES (?, ?, ?)');
    const transaction = db.transaction((linksBatch) => {
      for (const link of linksBatch) {
        insertStmt.run(collectionId, link.source, link.target);
      }
    });
    transaction(links);
  }
}
