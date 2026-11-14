import { z } from 'zod';
export const UsageDaySchema=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{const parsed=new Date(value+'T00:00:00Z');return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;});
export const UsageEmailSchema=z.string().trim().email().max(320).transform(value=>value.toLowerCase());
const counter=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const LocalUsageEventSchema=z.object({fingerprint:z.string().regex(/^[a-f0-9]{64}$/),day:UsageDaySchema,accountId:z.string().min(1).max(256).nullable(),
  tokens:counter,inputTokens:counter,cachedInputTokens:counter,outputTokens:counter}).strict();
export const CONFIRMED_USAGE_START='2026-09-23',CONFIRMED_USAGE_END='2026-09-29';
