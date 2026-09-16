import Link from 'next/link'
import { getCurrentUser, requireOnboardedProfile } from '@/lib/auth'
import { profilePath } from '@/lib/profile'
import SettingsForm from '@/components/account/SettingsForm'
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

  return (
    <div className="ac-page">
      <div className="ac-shell">
        <Link href="/" className="ac-back">Idea 2</Link>
        <h1 className="ac-title">Settings</h1>
        <p className="ac-subtitle">
          <Link href={profilePath(profile.username!)}>View your profile</Link>
        </p>

        <SettingsForm profile={profile} email={user?.email ?? null} />
      </div>
    </div>
  )
}
