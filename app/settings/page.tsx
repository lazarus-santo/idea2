import Link from 'next/link'
import { getCurrentUser, requireOnboardedProfile } from '@/lib/auth'
import { profilePath } from '@/lib/profile'
import { getBlockedProfiles, getMutedProfiles } from '@/lib/relationships'
import SettingsForm from '@/components/account/SettingsForm'
import RelationshipLists from '@/components/account/RelationshipLists'
import '@/app/account.css'

export const metadata = {
  title: 'Settings — Idea 2',
}

export default async function SettingsPage() {
  // Sends signed-out visitors to sign in, and half-finished accounts to
  // onboarding. proxy.ts also bounces the signed-out case, but that check is
  // optimistic — this one is the real gate.
  const profile = await requireOnboardedProfile()
  const user = await getCurrentUser()

  // Settings is where an unblock has to live: blocking removes the profile
  // page you would otherwise undo it from. Both functions answer only about
  // their caller and take no id, so there is no version of this page that can
  // be pointed at somebody else's lists.
  const [blocked, muted] = await Promise.all([
    getBlockedProfiles(),
    getMutedProfiles(),
  ])

  return (
    <div className="ac-page">
      <div className="ac-shell">
        <Link href="/" className="ac-back">Idea 2</Link>
        <h1 className="ac-title">Settings</h1>
        <p className="ac-subtitle">
          <Link href={profilePath(profile.username!)}>View your profile</Link>
          {' · '}
          {/* Crawls are not in the site nav in this phase. They are owner-only
              until Phase 2 gives them an audience, so the way in is from the
              account surface rather than from a nav everyone sees. */}
          <Link href="/crawls">Your crawls</Link>
        </p>

        <SettingsForm profile={profile} email={user?.email ?? null}>
          <RelationshipLists blocked={blocked} muted={muted} />
        </SettingsForm>
      </div>
    </div>
  )
}
