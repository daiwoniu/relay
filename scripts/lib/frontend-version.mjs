import fs from 'node:fs';
import path from 'node:path';

/** Read the version frozen into this release, never the working tree package. */
export function readFrontendVersion(releaseDir,{required=false}={}){
  const file=path.join(releaseDir,'relay-version.json');
  if(!fs.existsSync(file)&&!required)return undefined;
  try{
    const version=JSON.parse(fs.readFileSync(file,'utf8'))?.version;
    if(typeof version!=='string'||!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/.test(version))throw new Error();
    return version;
  }catch{throw new Error('前端构建缺少有效的 relay-version.json');}
}
