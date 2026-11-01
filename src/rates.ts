// Rates from https://docs.x.com/x-api/getting-started/pricing and the April 16, 2026
// changelog entry, checked 2026-11-01. X says rates are subject to change, and
// it does not bill a resource twice in one UTC day, so these are upper-bound estimates.
// The authoritative number is in https://console.x.com.
// That page lists no price for media upload (initialize, append, finalize, status) or for
// reposting, so those calls have no entry here and are recorded as unpriced.
export const RATES = {
  postCreate: 0.015,
  postCreateWithUrl: 0.2,
  summonedReply: 0.01,
  postRead: 0.005,
  ownedRead: 0.001,
  userRead: 0.01,
  /** "Following/Followers: Read". The owned rate applies to your own lists when you own the app. */
  followListRead: 0.01,
  dmRead: 0.01,
  dmCreate: 0.015,
  interactionDelete: 0.01,
  userInteraction: 0.015,
} as const;

/** A list read estimated above this refuses to start without an explicit --max-spend. */
export const DEFAULT_SPEND_CAP_USD = 1;

const URL_LIKE = /https?:\/\/|\b[a-z0-9-]+\.[a-z]{2,}\b/i;

/** X also links bare domains, so this errs toward the higher URL rate. */
export function looksLikeUrl(text: string): boolean {
  return URL_LIKE.test(text);
}

export function estimatePostCost(text: string, summoned: boolean): number {
  if (looksLikeUrl(text)) return RATES.postCreateWithUrl;
  return summoned ? RATES.summonedReply : RATES.postCreate;
}
