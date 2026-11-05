import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { appUser, profile } from '../db/schema.js';

export type Profile = typeof profile.$inferSelect;

/** The single owner's profile. v1 has exactly one user, created on first start. */
export async function loadOwner(db: Db): Promise<Profile> {
  const [row] = await db
    .select({ profile })
    .from(appUser)
    .innerJoin(profile, eq(profile.userId, appUser.id))
    .limit(1);
  if (!row) throw new Error('No owner profile: the server did not finish starting up');
  return row.profile;
}
