import AdminPage from '@/components/AdminPage'

interface Props {
  searchParams: Promise<{ pw?: string }>
}

export default async function Admin({ searchParams }: Props) {
  const { pw } = await searchParams
  const adminPassword = process.env.ADMIN_PASSWORD

  if (!adminPassword || pw !== adminPassword) {
    if (pw !== undefined) {
      // Wrong password was submitted — show form with error
      return <LoginForm error />
    }
    return <LoginForm />
  }

  return <AdminPage adminPw={pw} />
}

function LoginForm({ error }: { error?: boolean }) {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0a0a0a',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <form method="GET" style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 280 }}>
        <p style={{ color: '#fff', fontSize: 13, marginBottom: 4 }}>Admin access</p>
        {error && <p style={{ color: '#f87171', fontSize: 12 }}>Incorrect password.</p>}
        <input
          name="pw"
          type="password"
          placeholder="Password"
          autoFocus
          style={{
            background: '#111',
            border: '1px solid #333',
            color: '#fff',
            padding: '8px 12px',
            fontSize: 13,
            outline: 'none',
          }}
        />
        <button type="submit" style={{
          background: '#e2ce3a',
          color: '#000',
          border: 'none',
          padding: '8px 12px',
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          cursor: 'pointer',
        }}>
          Enter
        </button>
      </form>
    </div>
  )
}
