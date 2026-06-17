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
import { UserSearch } from './pages/UserSearch'
import { Executive } from './pages/Executive'
import { Changelog } from './pages/Changelog'
import { Cowork } from './pages/Cowork'
import { Office } from './pages/Office'
import { Design } from './pages/Design'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="exec" element={<Executive />} />
        <Route path="users" element={<Users />} />
        <Route path="trends" element={<Trends />} />
        <Route path="claude-code" element={<ClaudeCode />} />
        <Route path="cowork" element={<Cowork />} />
        <Route path="office" element={<Office />} />
        <Route path="design" element={<Design />} />
        <Route path="productivity" element={<Productivity />} />
        <Route path="user-productivity" element={<UserProductivity />} />
        <Route path="user-search" element={<UserSearch />} />
        <Route path="adoption" element={<Adoption />} />
        <Route path="cost" element={<Cost />} />
        <Route path="compliance" element={<Compliance />} />
        <Route path="analyze" element={<Analyze />} />
        <Route path="archive" element={<Archive />} />
        <Route path="changelog" element={<Changelog />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
