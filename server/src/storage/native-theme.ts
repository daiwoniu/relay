import type { nativeQueries } from './native-queries.js';
import { getThemeSettingsFromDatabase,saveThemeSettingsInDatabase,getThemeAssetRecordFromDatabase } from '../db/queries-account.js';
import { parseThemeSettings,getThemeAssetIds } from '../theme/theme-settings.js';
import { AccountThemeSettingsDtoSchema } from '../contracts/index.js';
import { StorageContractError } from './command-boundary.js';
type DB=Pick<ReturnType<typeof nativeQueries>,'get'|'run'|'saveToFile'>;
export function readNativeTheme(db:DB,userId:string){
  const row=db.get('SELECT length(CAST(settings_json AS BLOB)) AS bytes FROM user_theme_settings WHERE user_id=?',[userId]);
  if(Number(row?.bytes)>16384)throw new StorageContractError('PAYLOAD_TOO_LARGE');
  return AccountThemeSettingsDtoSchema.parse(getThemeSettingsFromDatabase(db,userId));
}
export function saveNativeTheme(db:DB,userId:string,input:unknown,now:number){
  const previous=readNativeTheme(db,userId);let settings;
  try{settings=parseThemeSettings(input,now,previous);}catch{throw new StorageContractError('INVALID_ARGUMENT');}
  for(const id of getThemeAssetIds(settings)){
    if(getThemeAssetRecordFromDatabase(db,id)?.user_id!==userId)throw new StorageContractError('NOT_FOUND');
    if(db.get('SELECT 1 FROM _relay_theme_asset_jobs WHERE asset_id=? AND files_finished=0',[id]))throw new StorageContractError('CONFLICT');
  }
  saveThemeSettingsInDatabase(db,userId,settings);
  // No filesystem effects inside the transaction. Unreferenced assets remain retained until journaled cleanup exists.
  return{userId};
}
