import db from '@/lib/db';

export class DatabaseRepository {
  static async backup(backupPath: string): Promise<void> {
    await db.backup(backupPath);
  }
}
