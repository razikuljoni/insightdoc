/**
 * GET /api/v1/feedback-review — review queue for rated answers (Analytics)
 *
 * Surfaces the latest assistant messages carrying a 👍/👎 signal so analysts
 * can jump straight into the originating conversation. Scoped to sessions the
 * requesting user owns, mirroring the analytics visibility model.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { FeedbackReviewQuerySchema, FeedbackReviewItemSchema } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();

    const url = new URL(request.url);
    const parsed = FeedbackReviewQuerySchema.safeParse({
      rating: url.searchParams.get('rating') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid query parameters' }, { status: 400 });
    }
    const { rating, limit } = parsed.data;

    const rows = await db.chatMessage.findMany({
      where: { feedback: rating, chatSession: { userId: user.id } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { chatSession: { select: { id: true, title: true } } },
    });

    // Attach the preceding user question for context (cheap N lookup, N ≤ 20)
    const items = await Promise.all(
      rows.map(async (m) => {
        const prev = await db.chatMessage.findFirst({
          where: {
            chatSessionId: m.chatSessionId,
            role: 'user',
            createdAt: { lt: m.createdAt },
          },
          orderBy: { createdAt: 'desc' },
          select: { content: true },
        });
        return FeedbackReviewItemSchema.parse({
          messageId: m.id,
          sessionId: m.chatSessionId,
          sessionTitle: m.chatSession.title,
          question: prev?.content.replace(/\s+/g, ' ').slice(0, 160) ?? '(question truncated)',
          content: m.content.replace(/\s+/g, ' ').slice(0, 400),
          citationsCount: (() => {
            try {
              return m.citationsJson ? (JSON.parse(m.citationsJson) as unknown[]).length : 0;
            } catch {
              return 0;
            }
          })(),
          createdAt: m.createdAt.toISOString(),
        });
      }),
    );

    return NextResponse.json({ items });
  } catch (error) {
    console.error('[GET /feedback-review]', error);
    return NextResponse.json({ error: 'Failed to load feedback review' }, { status: 500 });
  }
}
