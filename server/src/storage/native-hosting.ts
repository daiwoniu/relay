import type { nativeQueries } from './native-queries.js';
import { HostedSiteSchema, type HostedSite } from '../page-hosting/contract.js';
import { StorageContractError } from './command-boundary.js';

type DB = ReturnType<typeof nativeQueries>;
export function readHostedSites(db: DB, { id, includeSource = false }: { id?: string; includeSource?: boolean } = {}): HostedSite[] {
  const rows = id
    ? db.all("SELECT site_json FROM hosted_sites WHERE id=? OR json_extract(site_json,'$.publicId')=?", [id,id])
    : db.all(`SELECT ${includeSource ? 'site_json, source_json' : 'site_json'} FROM hosted_sites ORDER BY updated_at DESC LIMIT 1001`);
  if (rows.length > 1000) throw new StorageContractError('PAYLOAD_TOO_LARGE');
  return rows.map(row => HostedSiteSchema.parse({
    ...JSON.parse(String(row.site_json)),
    ...(typeof row.source_json === 'string' ? { source: JSON.parse(row.source_json) } : {}),
  }));
}
export function saveHostedSite(db: DB, site: HostedSite, expectedToken: string | null) {
  const prior = readHostedSites(db, { id: site.id })[0];
  if ((prior?.contentToken ?? null) !== expectedToken) throw new StorageContractError('CONFLICT');
  if (prior?.publicId && prior.publicId !== site.publicId) throw new StorageContractError('CONFLICT');
  if (site.publicId && readHostedSites(db, { id: site.publicId }).some(other => other.id !== site.id)) throw new StorageContractError('CONFLICT');
  if (!prior && Number(db.get('SELECT COUNT(*) AS n FROM hosted_sites')!.n) >= 1000) throw new StorageContractError('PAYLOAD_TOO_LARGE');
  const { source, ...siteMetadata } = site;
  db.run('INSERT INTO hosted_sites(id,site_json,updated_at,source_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET site_json=excluded.site_json,updated_at=excluded.updated_at,source_json=excluded.source_json', [site.id, JSON.stringify(siteMetadata), site.updatedAt, source ? JSON.stringify(source) : null]);
  return { id: site.id };
}
export function deleteHostedSite(db: DB, id: string, expectedToken: string) {
  const prior = readHostedSites(db, { id })[0];
  if (!prior || prior.contentToken !== expectedToken) throw new StorageContractError('CONFLICT');
  db.run('DELETE FROM hosted_sites WHERE id=?', [id]);
  return { id };
}
