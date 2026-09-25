import Link from 'next/link'
import LogoMark from '@/components/LogoMark'
import { redirect } from 'next/navigation'
import { getOwnProfile, requireUser } from '@/lib/auth'
import { profilePath } from '@/lib/profile'
import OnboardingForm from '@/components/account/OnboardingForm'
import '@/app/account.css'

export const metadata = {
  title: 'Choose a username — Idea 2',
}

interface Props {
  searchParams: Promise<{ next?: string }>
}

/**
 * The step between signing up and having an account people can look at.
 *
 * Anything the provider told us about this person is offered here as a
 * suggestion in a field they can change, never written on their behalf. Sign
 * in with Apple in particular may send no name at all, a placeholder, and a
 * relay email address — and it sends the name only on the very first
 * authorization, so a value stored silently could never be corrected by
 * signing in again.
 */
export default async function OnboardingPage({ searchParams }: Props) {
  const user = await requireUser()
  const profile = await getOwnProfile()
  const { next } = await searchParams

  // Already onboarded — nothing to do here.
  if (profile?.username) {
    redirect(profilePath(profile.username))
  }

  const metadata = user.user_metadata ?? {}
  const suggestedName =
    typeof metadata.full_name === 'string' ? metadata.full_name
    : typeof metadata.name === 'string' ? metadata.name
    : ''

  return (
    <div className="ac-page">
      <div className="ac-shell">
        <Link href="/" className="ac-back"><LogoMark /></Link>
        <h1 className="ac-title">Choose your username</h1>
        <p className="ac-subtitle">
          This is how you&rsquo;ll appear on Idea 2. You can change it later.
        </p>
        <OnboardingForm
          userId={user.id}
          suggestedName={suggestedName}
          suggestedUsername={suggestUsername(suggestedName, user.email ?? '')}
          next={next ?? null}
        />
      </div>
    </div>
  )
}

/**
 * A starting point for the username field, never a value we save on our own.
 *
 * Apple's private relay addresses are random strings, so they make a
 * meaningless handle — better to leave the field empty and let the person
 * type than to prefill something like k7x9mn2p.
 */
function suggestUsername(name: string, email: string): string {
  const fromName = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (fromName.length >= 3) return fromName.slice(0, 30)

  if (email.endsWith('privaterelay.appleid.com')) return ''

  const local = email.split('@')[0] ?? ''
  const fromEmail = local.toLowerCase().replace(/[^a-z0-9]/g, '')
  return fromEmail.length >= 3 ? fromEmail.slice(0, 30) : ''
}
