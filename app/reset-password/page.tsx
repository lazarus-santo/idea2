import Link from 'next/link'
import ResetPasswordForm from '@/components/account/ResetPasswordForm'
import '@/app/account.css'

export const metadata = {
  title: 'New password — Idea 2',
}

/**
 * Set a new password.
 *
 * Arriving here means the reset link in the email was already verified by
 * /auth/confirm, so this page is reached with a session — which is exactly
 * what lets updateUser() accept a new password without asking for the old one.
 */
export default function ResetPasswordPage() {
  return (
    <div className="ac-page">
      <div className="ac-shell">
        <Link href="/" className="ac-back">Idea 2</Link>
        <h1 className="ac-title">Choose a new password</h1>
        <p className="ac-subtitle">At least 8 characters.</p>
        <ResetPasswordForm />
      </div>
    </div>
  )
}
