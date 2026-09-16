import Link from 'next/link'
import ForgotPasswordForm from '@/components/account/ForgotPasswordForm'
import '@/app/account.css'

export const metadata = {
  title: 'Reset your password — Idea 2',
}

/**
 * Asking for a reset link — its own screen.
 *
 * This is the REQUEST step. /reset-password is the step after it, where
 * somebody who followed the link in their email sets the new password. Two
 * separate pages because they happen minutes apart, in different browsers
 * sometimes, and one of them needs a session while the other must not.
 *
 * It used to be a link-styled button on the sign-in form that reused whatever
 * was in the email field, and told people off with "Enter your email address
 * first" if it was empty.
 */
export default function ForgotPasswordPage() {
  return (
    <div className="ac-page">
      <div className="ac-shell">
        <Link href="/" className="ac-back">Idea 2</Link>
        <h1 className="ac-title">Reset your password</h1>
        <p className="ac-subtitle">
          Enter the email address you signed up with and we&rsquo;ll send you a link.
        </p>
        <ForgotPasswordForm />
      </div>
    </div>
  )
}
