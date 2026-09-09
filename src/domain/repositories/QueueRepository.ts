import db from '@/lib/db';
import crypto from 'crypto';

export interface QueueItem {
  id: string;
  paperId: string;
  type: 'citations' | 'references' | 'both';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  collectionId?: string;
  createdAt: string;
}

export class QueueRepository {
  static getPendingItems(limit: number = 5): QueueItem[] {
    const stmt = db.prepare(`SELECT * FROM retry_queue WHERE status = 'pending' ORDER BY createdAt ASC LIMIT ?`);
    return stmt.all(limit) as QueueItem[];
  }

  static updateStatus(id: string, status: string): void {
    db.prepare(`UPDATE retry_queue SET status = ? WHERE id = ?`).run(status, id);
  }
  
  static addQueueItem(paperId: string, type: 'citations' | 'references' | 'both', collectionId?: string): void {
    const checkStmt = db.prepare('SELECT id FROM retry_queue WHERE paperId = ? AND type = ? AND status = ? AND collectionId IS ?');
    const existing = checkStmt.get(paperId, type, 'pending', collectionId ?? null);
    if (existing) return;

    db.prepare('INSERT INTO retry_queue (id, paperId, type, status, collectionId) VALUES (?, ?, ?, ?, ?)').run(
      crypto.randomUUID(), paperId, type, 'pending', collectionId ?? null
    );
  }

  static getStatusCounts(): { pending: number, failed: number } {
    const pendingCount = (db.prepare(`SELECT count(*) as count FROM retry_queue WHERE status = 'pending'`).get() as any).count;
    const failedCount = (db.prepare(`SELECT count(*) as count FROM retry_queue WHERE status = 'failed'`).get() as any).count;
    return { pending: pendingCount, failed: failedCount };
  }
}
