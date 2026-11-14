import { NotificationPreferencesDtoSchema } from '../contracts/index.js';
/** Same whitelist as the existing HTTP surface; reject empty patches and caller-supplied account scope. */
export const NotificationPreferencesPatchSchema=NotificationPreferencesDtoSchema.partial().strict().refine(value=>Object.keys(value).length>0);
