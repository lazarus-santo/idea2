import Image from 'next/image'

// The "ii" mark that stands in for the "Idea 2" text wordmark everywhere but
// the homepage. Sized in em by .logo-mark, so it follows the font-size the
// wordmark link already has at each breakpoint.
export default function LogoMark() {
  return <Image src="/logo/logo.svg" alt="Idea 2" width={624} height={590} className="logo-mark" priority />
}
