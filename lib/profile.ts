/**
 * Profile shapes and the username rules, shared by the browser and the server.
 *
 * The rules here are a MIRROR of migration_v40.sql, not the enforcement. The
 * database is the authority: the same format is a CHECK constraint, the same
 * reserved list is a table behind a trigger, and uniqueness is a UNIQUE index.
 * These copies exist only so the UI can say "too short" without a round trip,
 * and so a claim that is going to fail fails before we ask the user to wait.
 *
 * If you change a rule here, change it in the migration too — and expect the
 * migration's version to win.
 */

export type ProfilePrivacy = 'public' | 'private'

/** A profile as the browser and public pages see it (the granted columns). */
export interface Profile {
  id: string
  username: string | null
  display_name: string | null
  avatar_url: string | null
  bio: string | null
  privacy: ProfilePrivacy
  created_at: string
}

/** The columns anon/authenticated may SELECT — see migration_v40 section 6. */
export const PROFILE_COLUMNS =
  'id, username, display_name, avatar_url, bio, privacy, created_at'

/**
 * The discoverable half of a profile: what a search result and a locked
 * profile header show, and nothing else.
 *
 * Returned by public.profile_card(handle) and public.search_profile_cards(q),
 * which answer for EVERY profile that has a username whatever its privacy —
 * that is what makes a private account findable, and therefore askable. The
 * columns missing here, bio and created_at, are missing from those functions'
 * signatures too, so a private profile's writing never leaves the database.
 * Only the full row in public.profiles carries them, and RLS keeps that to the
 * owner and to approved followers.
 *
 * These replaced the public.profile_cards VIEW in migration_v45. The view was
 * not leaking — it carried the same five columns — but being GRANTed it was a
 * table to PostgREST, so one unfiltered request returned every account. A
 * function answers only the question it was written for.
 */
export interface ProfileCard {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  privacy: ProfilePrivacy
}

export const USERNAME_MIN = 3
export const USERNAME_MAX = 30
export const DISPLAY_NAME_MAX = 50
export const BIO_MAX = 300

/** Lower-case, 3-30 chars, no leading or trailing underscore. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_]{1,28}[a-z0-9]$/

/**
 * Mirror of public.reserved_usernames. Kept as a plain list for instant UI
 * feedback; the trigger is what actually refuses these.
 */
export const RESERVED_USERNAMES = new Set([
  'admin', 'api', 'auth', 'login', 'logout', 'signin', 'signup', 'settings',
  'onboarding', 'u', 'user', 'users', 'profile', 'profiles', 'account',
  'accounts', 'exhibitions', 'exhibition', 'readings', 'reading',
  'editors-picks', 'editorspicks', 'map', 'search', 'venues', 'venue',
  'artists', 'artist', 'institutions', 'institution', 'galleries', 'gallery',
  'museum', 'museums', 'crawl', 'crawls', 'log', 'logs', 'feed', 'follow',
  'followers', 'following', 'reset-password', 'new', 'edit', 'delete',
  'idea2', 'idea-2', 'official', 'staff', 'team', 'support', 'help', 'contact',
  'moderator', 'mod', 'root', 'system', 'about', 'terms', 'privacy', 'legal',
  'security', 'abuse', 'static', 'public', 'assets', 'favicon', 'robots',
  'sitemap', 'rss', 'www', 'me', 'null', 'undefined', 'anonymous', 'everyone',
])

/**
 * Validate a username for the UI.
 *
 * Returns null when it looks claimable, or a sentence to show the person.
 * Uniqueness is NOT checked here — only the database can answer that, and it
 * answers on write.
 */
export function validateUsername(raw: string): string | null {
  const username = raw.trim().toLowerCase()

  if (username.length === 0) return 'Pick a username.'
  if (username.length < USERNAME_MIN) return `At least ${USERNAME_MIN} characters.`
  if (username.length > USERNAME_MAX) return `At most ${USERNAME_MAX} characters.`
  if (/[^a-z0-9_]/.test(username)) return 'Letters, numbers and underscores only.'
  if (!USERNAME_PATTERN.test(username)) return 'Cannot start or end with an underscore.'
  if (RESERVED_USERNAMES.has(username)) return 'That username is reserved.'

  return null
}

/** What we store: usernames are always lower-case (the CHECK enforces it). */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase()
}

export function validateDisplayName(raw: string): string | null {
  const name = raw.trim()
  if (name.length === 0) return 'Add a display name.'
  if (name.length > DISPLAY_NAME_MAX) return `At most ${DISPLAY_NAME_MAX} characters.`
  return null
}

export function validateBio(raw: string): string | null {
  if (raw.length > BIO_MAX) return `At most ${BIO_MAX} characters.`
  return null
}

/**
 * The privacy choices, with the wording shown in settings.
 *
 * Two states, not three. 'followers_only' existed in v40 and never behaved
 * differently from 'private' — there was no follow graph to check it against —
 * so v43 folded every such row into 'private' and dropped it from the CHECK.
 *
 * The Private copy says "found" on purpose. A private profile IS returned by
 * search; what privacy hides is the content of the profile page, not the
 * profile's existence. Saying "only you can see your profile" would now be a
 * lie about where the line falls.
 */
export const PRIVACY_OPTIONS: {
  value: ProfilePrivacy
  label: string
  description: string
}[] = [
  {
    value: 'public',
    label: 'Public',
    description: 'Anyone can see your profile.',
  },
  {
    value: 'private',
    label: 'Private',
    description: 'People can find you in search, but only you can see what is on your profile.',
  },
]

/**
 * Read a stored privacy value as one of the two that now exist.
 *
 * v43 collapsed 'followers_only' into 'private' in the database, so nothing
 * should reach this that is not already one of the two. It is here for the row
 * that is loaded by a browser tab which was open across the migration, and for
 * any future value this build has not been taught: an unrecognised setting
 * must read as the private one, never as public, or a mistake here quietly
 * publishes somebody.
 */
export function normalizePrivacy(value: string | null | undefined): ProfilePrivacy {
  return value === 'public' ? 'public' : 'private'
}

/** Where a profile lives. Kept in one place so the route can move later. */
export function profilePath(username: string): string {
  return `/u/${username}`
}

/**
 * A person's display name falls back to their username — never to an email
 * address or a provider-supplied name. With Sign in with Apple the provider
 * name is frequently absent or a relay placeholder, so it is never a fallback.
 */
export function profileDisplayName(profile: Pick<Profile, 'display_name' | 'username'>): string {
  return profile.display_name?.trim() || profile.username || 'Someone'
}
