import { useFetch } from './api'

type Health = {
  ok: boolean
  analyticsKey: 'analytics' | 'admin' | 'none' | 'unknown'
  adminKey: 'analytics' | 'admin' | 'none' | 'unknown'
  // Set while Anthropic refuses this server's address under the org's IP allowlist.
  ipAllowlistBlockedAt?: string | null
  apiUrl: string
  apiVersion: string
  dataConstraints: {
    firstAvailableDate: string
    bufferDays: number
    maxLookbackDays: number
    summariesMaxRangeDays: number
    rateLimitPerMinute: number
  }
}

export function useHealth() {
  const { data } = useFetch<Health>('/api/health')
  return data
}
