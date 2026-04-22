import { Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Overview } from './pages/Overview'
import { Users } from './pages/Users'
import { Trends } from './pages/Trends'
import { ClaudeCode } from './pages/ClaudeCode'
import { Productivity } from './pages/Productivity'
import { UserProductivity } from './pages/UserProductivity'
import { Adoption } from './pages/Adoption'
import { Cost } from './pages/Cost'
import { Compliance } from './pages/Compliance'
import { Analyze } from './pages/Analyze'
import { Archive } from './pages/Archive'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="users" element={<Users />} />
        <Route path="trends" element={<Trends />} />
        <Route path="claude-code" element={<ClaudeCode />} />
        <Route path="productivity" element={<Productivity />} />
        <Route path="user-productivity" element={<UserProductivity />} />
        <Route path="adoption" element={<Adoption />} />
        <Route path="cost" element={<Cost />} />
        <Route path="compliance" element={<Compliance />} />
        <Route path="analyze" element={<Analyze />} />
        <Route path="archive" element={<Archive />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
