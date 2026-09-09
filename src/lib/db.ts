import { PrismaClient } from '@prisma/client';

let dbUrl =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL;

if (dbUrl && dbUrl.startsWith('file:')) {
  dbUrl = process.env.POSTGRES_PRISMA_URL || process.env.POSTGRES_URL;
}

if (dbUrl) {
  process.env.DATABASE_URL = dbUrl;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: dbUrl ? { db: { url: dbUrl } } : undefined,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;

