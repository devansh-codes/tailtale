/** Common airliner types counted by the cron every 10 minutes (spec 5.3). */
export const TRACKED_TYPES = [
  "A319", "A320", "A321", "A20N", "A21N", "BCS1", "BCS3", "A332", "A333", "A339", "A359", "A35K", "A388",
  "B737", "B738", "B739", "B38M", "B39M", "B752", "B763", "B764", "B772", "B77W", "B77L", "B788", "B789",
  "B78X", "B744", "B748", "E170", "E75L", "E75S", "E190", "E195", "E290", "CRJ2", "CRJ7", "CRJ9", "AT76", "DH8D",
] as const;

/**
 * The free plan allows 10 ms CPU per cron invocation, so the list is split across four cron
 * triggers that fire one minute apart (each group still gets a sample every 10 minutes).
 */
export const CRON_GROUPS: Record<string, readonly string[]> = {
  "0-59/10 * * * *": TRACKED_TYPES.slice(0, 10),
  "1-59/10 * * * *": TRACKED_TYPES.slice(10, 20),
  "2-59/10 * * * *": TRACKED_TYPES.slice(20, 30),
  "3-59/10 * * * *": TRACKED_TYPES.slice(30),
};

export const isTracked = (t: string): boolean => (TRACKED_TYPES as readonly string[]).includes(t);
