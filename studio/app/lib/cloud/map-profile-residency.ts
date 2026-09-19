import { stat } from 'node:fs/promises';
import { mapCacheHoldsAll } from '@/app/lib/map-cache/service';
import { localObjectPath } from '@/app/lib/s3/s3-object';
import { MAP_CACHE_BUCKET, type RegistryMember } from './map-registry';

/** Complete verified registration, checked where each member actually lives. */
export async function registeredProfileInstalled(members: Iterable<RegistryMember>): Promise<boolean> {
  const cached: RegistryMember[] = [];
  const local: RegistryMember[] = [];
  for (const member of members) (member.bucket === MAP_CACHE_BUCKET ? cached : local).push(member);
  if (cached.length + local.length === 0) return false;
  if (cached.length && !(await mapCacheHoldsAll(cached))) return false;
  // Bound filesystem work: native closures can contain tens of thousands of files.
  for (let offset = 0; offset < local.length; offset += 32) {
    const present = await Promise.all(local.slice(offset, offset + 32).map(async (member) => {
      try {
        const file = await stat(localObjectPath(member.bucket, member.key));
        return file.isFile() && file.size === member.byteLength;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    }));
    if (present.some((value) => !value)) return false;
  }
  return true;
}
