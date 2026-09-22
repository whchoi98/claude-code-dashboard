import { lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import { OrgProvider } from './lib/OrgProvider'
import { GroupScopeProvider } from './lib/GroupScopeProvider'

// Each page is requested when visited. Layout owns the loading and recovery
// surfaces, so the menu remains available while a page chunk loads.
const Overview = lazy(() => import('./pages/Overview').then((m) => ({ default: m.Overview })))
const Users = lazy(() => import('./pages/Users').then((m) => ({ default: m.Users })))
const Trends = lazy(() => import('./pages/Trends').then((m) => ({ default: m.Trends })))
const ClaudeCode = lazy(() => import('./pages/ClaudeCode').then((m) => ({ default: m.ClaudeCode })))
const ClaudeChat = lazy(() => import('./pages/ClaudeChat').then((m) => ({ default: m.ClaudeChat })))
const Productivity = lazy(() => import('./pages/Productivity').then((m) => ({ default: m.Productivity })))
const UserProductivity = lazy(() => import('./pages/UserProductivity').then((m) => ({ default: m.UserProductivity })))
const Adoption = lazy(() => import('./pages/Adoption').then((m) => ({ default: m.Adoption })))
const Cost = lazy(() => import('./pages/Cost').then((m) => ({ default: m.Cost })))
const CostLive = lazy(() => import('./pages/CostLive').then((m) => ({ default: m.CostLive })))
const Compliance = lazy(() => import('./pages/Compliance').then((m) => ({ default: m.Compliance })))
const Analyze = lazy(() => import('./pages/Analyze').then((m) => ({ default: m.Analyze })))
const Archive = lazy(() => import('./pages/Archive').then((m) => ({ default: m.Archive })))
const UserSearch = lazy(() => import('./pages/UserSearch').then((m) => ({ default: m.UserSearch })))
const Executive = lazy(() => import('./pages/Executive').then((m) => ({ default: m.Executive })))
const Changelog = lazy(() => import('./pages/Changelog').then((m) => ({ default: m.Changelog })))
const Cowork = lazy(() => import('./pages/Cowork').then((m) => ({ default: m.Cowork })))
const Agentic = lazy(() => import('./pages/Agentic').then((m) => ({ default: m.Agentic })))
const Office = lazy(() => import('./pages/Office').then((m) => ({ default: m.Office })))
const Design = lazy(() => import('./pages/Design').then((m) => ({ default: m.Design })))

export default function App() {
  return (
    // OrgProvider sits OUTSIDE GroupScopeProvider: the email→group map is
    // per org, so the group provider's fetch depends on the org selection.
    <OrgProvider>
      <GroupScopeProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Overview />} />
            <Route path="exec" element={<Executive />} />
            <Route path="users" element={<Users />} />
            <Route path="trends" element={<Trends />} />
            <Route path="claude-code" element={<ClaudeCode />} />
            <Route path="claude-chat" element={<ClaudeChat />} />
            <Route path="cowork" element={<Cowork />} />
            <Route path="agentic" element={<Agentic />} />
            <Route path="office" element={<Office />} />
            <Route path="design" element={<Design />} />
            <Route path="productivity" element={<Productivity />} />
            <Route path="user-productivity" element={<UserProductivity />} />
            <Route path="user-search" element={<UserSearch />} />
            <Route path="adoption" element={<Adoption />} />
            <Route path="cost" element={<Cost />} />
            <Route path="cost-live" element={<CostLive />} />
            <Route path="compliance" element={<Compliance />} />
            <Route path="analyze" element={<Analyze />} />
            <Route path="archive" element={<Archive />} />
            <Route path="changelog" element={<Changelog />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </GroupScopeProvider>
    </OrgProvider>
  )
}
