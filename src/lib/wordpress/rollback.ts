// src/lib/wordpress/rollback.ts
// Phase 5 — Rollback a published post to a prior draft revision.
// Pulls revisions from the Phase 1 `revisions` table and re-PUTs the chosen
// version's HTML to WordPress at the existing post ID.

import { RevisionsRepo } from '@/lib/db/repositories';
import { publishToWordPress, type WordPressPublishPayload } from './publish';

export interface RollbackInput {
  /** Phase 1 draft id whose history we'll search. */
  draftId: string;
  /** Specific version to restore. If omitted, restores the most recent prior version. */
  version?: number;
  /** WordPress credentials + post coordinates. */
  wp: Pick<WordPressPublishPayload,
    'wpUrl' | 'username' | 'appPassword' | 'title' | 'existingPostId' | 'slug' | 'sourceUrl'
  >;
  /** Optional metadata to re-apply on the rolled-back post. */
  status?: WordPressPublishPayload['status'];
  metaDescription?: string;
  seoTitle?: string;
  canonicalUrl?: string;
}

export interface RollbackResult {
  success: boolean;
  restoredVersion?: number;
  postUrl?: string;
  postId?: number;
  error?: string;
}

export async function rollbackToRevision(input: RollbackInput): Promise<RollbackResult> {
  if (!input.wp.existingPostId && !input.wp.slug && !input.wp.sourceUrl) {
    return { success: false, error: 'rollback requires existingPostId, slug, or sourceUrl to locate the WP post' };
  }

  const revisions = await RevisionsRepo.byDraft(input.draftId);
  if (!revisions?.length) {
    return { success: false, error: 'no revisions found for draft' };
  }

  // byDraft is ordered DESC by version. Pick requested or the second-most-recent
  // (current = revisions[0]; "previous" = revisions[1]).
  const target = typeof input.version === 'number'
    ? revisions.find(r => r.version === input.version)
    : revisions[1] ?? revisions[0];

  if (!target) {
    return { success: false, error: `revision v${input.version} not found` };
  }
  if (!target.html) {
    return { success: false, error: `revision v${target.version} has no html payload` };
  }

  const result = await publishToWordPress({
    ...input.wp,
    title: input.wp.title,
    content: target.html,
    status: input.status ?? 'publish',
    metaDescription: input.metaDescription,
    seoTitle: input.seoTitle,
    canonicalUrl: input.canonicalUrl,
  });

  if (!result.success) {
    return { success: false, restoredVersion: target.version, error: result.error };
  }
  return {
    success: true,
    restoredVersion: target.version,
    postId: result.post?.id,
    postUrl: result.post?.url,
  };
}
