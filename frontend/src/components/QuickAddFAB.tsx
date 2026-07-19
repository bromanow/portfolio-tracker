import { useNavigate, useLocation } from 'react-router-dom'
import { Plus } from 'lucide-react'

// Pages where the FAB should be hidden (detail pages, admin, etc.)
const HIDDEN_ON = ['/login', '/admin', '/holdings/security']

export default function QuickAddFAB() {
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const hidden = HIDDEN_ON.some(p => pathname.startsWith(p))
  if (hidden) return null

  return (
    <button
      onClick={() => navigate('/activity?new=1')}
      aria-label="Add transaction"
      className="fixed bottom-20 right-4 z-40 w-14 h-14 rounded-full bg-primary text-white shadow-lg flex items-center justify-center hover:bg-primary/90 active:scale-95 transition-transform md:hidden"
    >
      <Plus className="h-6 w-6" />
    </button>
  )
}
