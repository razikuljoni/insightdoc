/**
 * InsightDoc — Audit & Usage Services (spec §2.4)
 *
 * Central, non-blocking emitters for the audit trail and token/cost ledger.
 * Cost model mirrors public pricing tiers of the models the spec names
 * (text-embedding-3-small, gpt-4o) so estimates are meaningful.
 */
import { db } from '@/lib/db';
import type { UsageKind } from '@/lib/types';

/** USD per 1M tokens (input, output respectively). */
const COST_TABLE: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5, output: 10 },
  'insightdoc-llm': { input: 2.5, output: 10 },
  'local-hashed-bow-1536-v1': { input: 0.02, output: 0 },
};

export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = COST_TABLE[model] ?? { input: 1, output: 2 };
  return (promptTokens * pricing.input + completionTokens * pricing.output) / 1_000_000;
}

export async function recordUsage(params: {
  userId: string;
  workspaceId?: string | null;
  kind: UsageKind;
  model: string;
  promptTokens: number;
  completionTokens: number;
}): Promise<void> {
  const totalTokens = params.promptTokens + params.completionTokens;
  try {
    await db.usageEvent.create({
      data: {
        userId: params.userId,
        workspaceId: params.workspaceId ?? null,
        kind: params.kind,
        model: params.model,
        promptTokens: params.promptTokens,
        completionTokens: params.completionTokens,
        totalTokens,
        estimatedCostUsd: estimateCost(params.model, params.promptTokens, params.completionTokens),
      },
    });
  } catch (error) {
    // Usage tracking must never break the primary flow
    console.error('[usage] failed to record usage event:', error);
  }
}

export async function recordAudit(params: {
  workspaceId?: string | null;
  actorEmail: string;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        workspaceId: params.workspaceId ?? null,
        actorEmail: params.actorEmail,
        action: params.action,
        targetType: params.targetType ?? null,
        targetId: params.targetId ?? null,
        detailJson: params.detail ? JSON.stringify(params.detail) : null,
      },
    });
  } catch (error) {
    console.error('[audit] failed to record audit log:', error);
  }
}
