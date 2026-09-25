import Link from 'next/link'
import LogoMark from '@/components/LogoMark'
import { Suspense } from 'react'
import LoginForm from '@/components/account/LoginForm'
import '@/app/account.css'

export const metadata = {
  title: 'Sign in — Idea 2',
}

interface Props {
  searchParams: Promise<{ next?: string; error?: string }>
}

export default async function LoginPage({ searchParams }: Props) {
  const { next, error } = await searchParams

  return (
    <div className="ac-page">
      <div className="ac-shell">
        <Link href="/" className="ac-back"><LogoMark /></Link>
        <h1 className="ac-title">Sign in</h1>
        <p className="ac-subtitle">
          An account is only for your own profile for now — the show log, following
          and crawls come later.
        </p>
        <Suspense>
          <LoginForm next={next ?? null} initialError={error ?? null} />
        </Suspense>
      </div>
    </div>
  )
}
