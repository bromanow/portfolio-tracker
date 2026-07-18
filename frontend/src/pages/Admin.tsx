import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import PlaidConnect from '../components/PlaidConnect'
import Prices from './Prices'

import SystemTab from './admin/SystemTab'
import MyAccountTab from './admin/MyAccountTab'
import AccountsTab from './admin/AccountsTab'
import OpeningBalancesTab from './admin/OpeningBalancesTab'
import CurrencySplitTab from './admin/CurrencySplitTab'
import SecuritiesTab from './admin/SecuritiesTab'
import OptionRetypeTab from './admin/OptionRetypeTab'
import ExpiredOptionsTab from './admin/ExpiredOptionsTab'
import BrokeragesTab from './admin/BrokeragesTab'
import TypeMappingsTab from './admin/TypeMappingsTab'
import FxRatesTab from './admin/FxRatesTab'
import IBKRFlexTab from './admin/IBKRFlexTab'
import IBeamTab from './admin/IBeamTab'
import UsersTab from './admin/UsersTab'
import DangerZoneTab from './admin/DangerZoneTab'

type TabId = 'system' | 'accounts' | 'securities' | 'prices' | 'expired-options' | 'option-types' | 'brokerages' | 'type-mappings' | 'fx-rates' | 'opening-balances' | 'currency-split' | 'users' | 'danger' | 'my-account' | 'ibkr-flex' | 'ibeam' | 'plaid'

// Grouped for the left-hand sub-page nav (section header → tabs).
const TAB_GROUPS: { heading: string; tabs: { id: TabId; label: string; adminOnly?: boolean }[] }[] = [
  { heading: 'You', tabs: [
    { id: 'my-account',       label: 'My Account' },
    { id: 'system',           label: 'System',           adminOnly: true },
  ]},
  { heading: 'Data', tabs: [
    { id: 'accounts',         label: 'Accounts' },
    { id: 'opening-balances', label: 'Opening Balances' },
    { id: 'securities',       label: 'Securities',       adminOnly: true },
    { id: 'prices',           label: 'Prices',           adminOnly: true },
    { id: 'option-types',     label: 'Fix Option Types', adminOnly: true },
    { id: 'expired-options',  label: 'Expired Options',  adminOnly: true },
    { id: 'brokerages',       label: 'Brokerages',       adminOnly: true },
    { id: 'type-mappings',    label: 'Type Mappings',    adminOnly: true },
    { id: 'fx-rates',         label: 'FX Rates',         adminOnly: true },
    { id: 'currency-split',   label: 'Currency Split',   adminOnly: true },
  ]},
  { heading: 'Connections', tabs: [
    { id: 'ibkr-flex',        label: 'IBKR Flex',        adminOnly: true },
    { id: 'ibeam',            label: 'IBeam (Live Data)', adminOnly: true },
    { id: 'plaid',            label: 'Plaid',            adminOnly: true },
  ]},
  { heading: 'Manage', tabs: [
    { id: 'users',            label: 'Users',            adminOnly: true },
    { id: 'danger',           label: '⚠ Bulk Delete',   adminOnly: true },
  ]},
]
const ALL_TABS = TAB_GROUPS.flatMap(g => g.tabs)

export default function Admin() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [searchParams, setSearchParams] = useSearchParams()
  const visible = (t: { adminOnly?: boolean }) => !t.adminOnly || isAdmin
  const groups = TAB_GROUPS
    .map(g => ({ ...g, tabs: g.tabs.filter(visible) }))
    .filter(g => g.tabs.length > 0)

  // Tab is URL-driven (?tab=…) so deep links work (e.g. Data Health → /admin?tab=securities).
  const urlTab = searchParams.get('tab') as TabId | null
  const valid = ALL_TABS.some(t => t.id === urlTab && visible(t))
  const tab: TabId = valid && urlTab ? urlTab : (isAdmin ? 'system' : 'my-account')
  const selectTab = (id: TabId) => {
    const next = new URLSearchParams(searchParams)
    next.set('tab', id)
    setSearchParams(next, { replace: true })
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Admin</h1>
      <div className="flex flex-col md:flex-row gap-5 items-start">
        {/* Left sub-page nav */}
        <aside className="w-full md:w-52 flex-shrink-0">
          <nav className="md:sticky md:top-4 space-y-3">
            {groups.map(g => (
              <div key={g.heading}>
                <div className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">{g.heading}</div>
                <div className="space-y-0.5">
                  {g.tabs.map(t => (
                    <button
                      key={t.id}
                      onClick={() => selectTab(t.id)}
                      className={`w-full text-left px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                        tab === t.id ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <main className="flex-1 min-w-0 w-full">
          {tab === 'system' && isAdmin && <SystemTab />}
          {tab === 'my-account' && <MyAccountTab />}
          {tab === 'accounts' && <AccountsTab />}
          {tab === 'opening-balances' && <OpeningBalancesTab />}
          {tab === 'currency-split' && isAdmin && <CurrencySplitTab />}
          {tab === 'securities' && <SecuritiesTab />}
          {tab === 'prices' && isAdmin && <Prices />}
          {tab === 'option-types' && isAdmin && <OptionRetypeTab />}
          {tab === 'expired-options' && isAdmin && <ExpiredOptionsTab />}
          {tab === 'brokerages' && <BrokeragesTab />}
          {tab === 'type-mappings' && <TypeMappingsTab />}
          {tab === 'fx-rates' && <FxRatesTab />}
          {tab === 'ibkr-flex' && isAdmin && <IBKRFlexTab />}
          {tab === 'ibeam' && isAdmin && <IBeamTab />}
          {tab === 'plaid' && isAdmin && <PlaidConnect />}
          {tab === 'users' && isAdmin && <UsersTab />}
          {tab === 'danger' && isAdmin && <DangerZoneTab />}
        </main>
      </div>
    </div>
  )
}
