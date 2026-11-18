import { BlockList,isIP } from 'node:net';
import { isLoopbackIp,normalizeClientIp } from '../../../scripts/lib/client-ip.mjs';

const internal=new BlockList();
for(const [ip,prefix] of [['10.0.0.0',8],['172.16.0.0',12],['192.168.0.0',16],['127.0.0.0',8],['169.254.0.0',16]] as const)internal.addSubnet(ip,prefix,'ipv4');
internal.addAddress('::1','ipv6');internal.addSubnet('fc00::',7,'ipv6');internal.addSubnet('fe80::',10,'ipv6');

export type AnalyticsNetwork='internal'|'public'|'unknown';
/** Only the server's resolved client IP is accepted; never client event metadata. */
export function analyticsNetwork(value:string|null|undefined,accessHost?:string):AnalyticsNetwork{
  const ip=normalizeClientIp(value);
  if(!ip||ip==='0.0.0.0'||ip==='::')return 'unknown';
  // A local proxy can mask its visitor as loopback. Without a local target,
  // preserve uncertainty rather than exclude a possible public-domain visitor.
  if(isLoopbackIp(ip)&&!isLoopbackIp(accessHost)&&accessHost!=='localhost')return 'unknown';
  return internal.check(ip,isIP(ip)===4?'ipv4':'ipv6')?'internal':'public';
}
