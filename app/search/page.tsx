import { Suspense } from 'react'
import SearchPage from '@/components/SearchPage'

export default function Search() {
  return (
    <Suspense>
      <SearchPage />
    </Suspense>
  )
}
