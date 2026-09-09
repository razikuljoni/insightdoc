/**
 * GET /api/v1/analytics — platform-wide token usage, storage and audit feed (spec §2.4)
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import type { AnalyticsDTO } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await getCurrentUser();

    const [workspaceCount, documents, chunkCount, chatCount, messageCount, usageEvents, auditLogs, feedbackUp, feedbackDown] =
      await Promise.all([
        db.workspaceMember.count({ where: { userId: user.id } }),
        db.document.findMany({
          where: { workspace: { members: { some: { userId: user.id } } } },
          select: { status: true, fileSize: true },
        }),
        db.documentChunk.count({
          where: { document: { workspace: { members: { some: { userId: user.id } } } } },
        }),
        db.chatSession.count({ where: { userId: user.id } }),
        db.chatMessage.count({ where: { chatSession: { userId: user.id } } }),
        db.usageEvent.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
          take: 2000,
        }),
        db.auditLog.findMany({
          where: { workspace: { members: { some: { userId: user.id } } } },
          orderBy: { createdAt: 'desc' },
          take: 12,
        }),
        db.chatMessage.count({ where: { chatSession: { userId: user.id }, feedback: 'UP' } }),
        db.chatMessage.count({ where: { chatSession: { userId: user.id }, feedback: 'DOWN' } }),
      ]);

    const promptTokens = usageEvents.reduce((s, e) => s + e.promptTokens, 0);
    const completionTokens = usageEvents.reduce((s, e) => s + e.completionTokens, 0);
    const estimatedCostUsd = usageEvents.reduce((s, e) => s + e.estimatedCostUsd, 0);
    const embeddingTokens = usageEvents
      .filter((e) => e.kind === 'embedding')
      .reduce((s, e) => s + e.totalTokens, 0);
    const chatTokens = usageEvents.filter((e) => e.kind === 'chat').reduce((s, e) => s + e.totalTokens, 0);

    // Aggregate last 14 days
    const byDayMap = new Map<string, { tokens: number; costUsd: number }>();
    const now = Date.now();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now - i * 86_400_000);
      byDayMap.set(d.toISOString().slice(0, 10), { tokens: 0, costUsd: 0 });
    }
    for (const e of usageEvents) {
      const key = e.createdAt.toISOString().slice(0, 10);
      const bucket = byDayMap.get(key);
      if (bucket) {
        bucket.tokens += e.totalTokens;
        bucket.costUsd += e.estimatedCostUsd;
      }
    }

    const dto: AnalyticsDTO = {
      totals: {
        workspaces: workspaceCount,
        documents: documents.length,
        completedDocuments: documents.filter((d) => d.status === 'COMPLETED').length,
        failedDocuments: documents.filter((d) => d.status === 'FAILED').length,
        chunks: chunkCount,
        chats: chatCount,
        messages: messageCount,
        storageBytes: documents.reduce((s, d) => s + d.fileSize, 0),
      },
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
        embeddingTokens,
        chatTokens,
        byDay: [...byDayMap.entries()].map(([date, v]) => ({
          date,
          tokens: v.tokens,
          costUsd: Math.round(v.costUsd * 10000) / 10000,
        })),
      },
      feedback: { up: feedbackUp, down: feedbackDown },
      recentAudit: auditLogs.map((a) => ({
        id: a.id,
        action: a.action,
        actorEmail: a.actorEmail,
        targetType: a.targetType,
        targetId: a.targetId,
        createdAt: a.createdAt.toISOString(),
      })),
    };

    return NextResponse.json({ analytics: dto });
  } catch (error) {
    console.error('[GET /analytics]', error);
    return NextResponse.json({ error: 'Failed to compute analytics' }, { status: 500 });
  }
}
