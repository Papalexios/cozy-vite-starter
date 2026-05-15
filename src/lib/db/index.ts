// src/lib/db/index.ts
export * from './types';
export * from './repositories';
export * from './jobQueue';

import { isSupabaseConfigured } from '@/lib/supabaseClient';
export const isContentMemoryReady = isSupabaseConfigured;
