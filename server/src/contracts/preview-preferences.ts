import { z } from 'zod';

const preset = z.enum(['default', 'enhanced', 'higher', 'custom']);
export const PreviewCapacitySchema = z.object({
  fileSizeMb: z.number().int().min(3).max(20),
  documentItems: z.number().int().min(50).max(500),
  spreadsheetRows: z.number().int().min(50).max(1000),
  spreadsheetColumns: z.number().int().min(100).max(300),
}).strict();
export const PreviewImageSchema = z.object({
  directSizeMb: z.number().int().min(5).max(20),
  maxDimension: z.number().int().min(2048).max(8192),
  qualityPercent: z.number().int().min(82).max(100),
}).strict();
export const PreviewPreferencesSchema = z.object({
  capacityPreset: preset,
  imagePreset: preset,
  customCapacity: PreviewCapacitySchema,
  customImage: PreviewImageSchema,
}).strict();
export const PreviewPreferencesPatchSchema = PreviewPreferencesSchema.partial().strict().refine(value => Object.keys(value).length > 0);
export type PreviewPreferences = z.infer<typeof PreviewPreferencesSchema>;
export type PreviewCapacity = z.infer<typeof PreviewCapacitySchema>;
export type PreviewImage = z.infer<typeof PreviewImageSchema>;
export const PREVIEW_CAPACITY_PRESETS = {
  default: { fileSizeMb: 3, documentItems: 50, spreadsheetRows: 50, spreadsheetColumns: 100 },
  enhanced: { fileSizeMb: 10, documentItems: 100, spreadsheetRows: 200, spreadsheetColumns: 100 },
  higher: { fileSizeMb: 20, documentItems: 200, spreadsheetRows: 500, spreadsheetColumns: 200 },
} as const;
export const PREVIEW_IMAGE_PRESETS = {
  default: { directSizeMb: 5, maxDimension: 2048, qualityPercent: 82 },
  enhanced: { directSizeMb: 10, maxDimension: 4096, qualityPercent: 90 },
  higher: { directSizeMb: 20, maxDimension: 4096, qualityPercent: 90 },
} as const;
export function defaultPreviewPreferences(): PreviewPreferences {
  return { capacityPreset: 'default', imagePreset: 'default', customCapacity: { ...PREVIEW_CAPACITY_PRESETS.default }, customImage: { ...PREVIEW_IMAGE_PRESETS.default } };
}
export function effectivePreviewPreferences(preferences: PreviewPreferences, admin: boolean) {
  return {
    capacity: preferences.capacityPreset === 'custom' && admin ? preferences.customCapacity : PREVIEW_CAPACITY_PRESETS[preferences.capacityPreset === 'custom' ? 'default' : preferences.capacityPreset],
    image: preferences.imagePreset === 'custom' && admin ? preferences.customImage : PREVIEW_IMAGE_PRESETS[preferences.imagePreset === 'custom' ? 'default' : preferences.imagePreset],
  };
}
export const PREVIEW_PREFERENCES_SCHEMA_SQL = `CREATE TABLE user_preview_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL CHECK(length(settings_json)<=4096), updated_at INTEGER NOT NULL)`;
