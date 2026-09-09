/**
 * GET  /api/v1/workspaces — list current user's workspaces with rollups
 * POST /api/v1/workspaces — create workspace (creator becomes ADMIN, spec §2.1)
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { recordAudit } from '@/server/audit';
import { CreateWorkspaceSchema, slugify, type WorkspaceDTO } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await getCurrentUser();

    const memberships = await db.workspaceMember.findMany({
      where: { userId: user.id },
      include: {
        workspace: {
          include: {
            _count: { select: { documents: true, chats: true, members: true } },
            documents: { select: { fileSize: true } },
          },
        },
      },
      orderBy: { workspace: { createdAt: 'asc' } },
    });

    const workspaces: WorkspaceDTO[] = memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      description: m.workspace.description,
      createdAt: m.workspace.createdAt.toISOString(),
      documentCount: m.workspace._count.documents,
      chatCount: m.workspace._count.chats,
      memberCount: m.workspace._count.members,
      storageBytes: m.workspace.documents.reduce((sum, d) => sum + d.fileSize, 0),
      role: m.role as WorkspaceDTO['role'],
    }));

    return NextResponse.json({ workspaces });
  } catch (error) {
    console.error('[GET /workspaces]', error);
    return NextResponse.json({ error: 'Failed to list workspaces' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    const body: unknown = await request.json();
    const parsed = CreateWorkspaceSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid workspace payload', issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const slug = slugify(`${parsed.data.name}-${Date.now().toString(36)}`);
    const workspace = await db.workspace.create({
      data: {
        name: parsed.data.name,
        slug,
        description: parsed.data.description ?? null,
        members: { create: { userId: user.id, role: 'ADMIN' } },
      },
    });

    await recordAudit({
      workspaceId: workspace.id,
      actorEmail: user.email,
      action: 'workspace.create',
      targetType: 'workspace',
      targetId: workspace.id,
    });

    const dto: WorkspaceDTO = {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      description: workspace.description,
      createdAt: workspace.createdAt.toISOString(),
      documentCount: 0,
      chatCount: 0,
      memberCount: 1,
      storageBytes: 0,
      role: 'ADMIN',
    };
    return NextResponse.json({ workspace: dto }, { status: 201 });
  } catch (error) {
    console.error('[POST /workspaces]', error);
    return NextResponse.json({ error: 'Failed to create workspace' }, { status: 500 });
  }
}
