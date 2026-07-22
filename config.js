export const APP_CONFIG = Object.freeze({
  requestTimeoutMs: 8000,
  cacheTtlMs: 60 * 60 * 1000,
  api: Object.freeze({
    virusTotal: 'https://www.virustotal.com/api/v3',
    abuseIpDb: 'https://api.abuseipdb.com/api/v2',
  }),
});

export const STORAGE_KEYS = Object.freeze({
  vtKey: 'sb_vt_key',
  abKey: 'sb_ab_key',
  otxKey: 'sb_otx_key',
  threatFoxKey: 'sb_threatfox_key',
  vtTier: 'sb_vt_tier',
  vtCustomRate: 'sb_vt_custom_rate',
  useVT: 'sb_use_vt',
  useAB: 'sb_use_ab',
  theme: 'sb_theme',
  cachePrefix: 'sb_cache_',
  vtUsage: 'sb_vt_usage_',
  history: 'sb_history',
  iocHistory: 'sb_ioc_history',
  notes: 'sb_notes',
  tags: 'sb_tags',
  savedSearches: 'sb_saved_searches',
  sessions: 'sb_sessions',
  tableColumns: 'sb_table_columns',
  sortStack: 'sb_sort_stack',
});

export const SESSION_ONLY_KEYS = new Set([STORAGE_KEYS.vtKey, STORAGE_KEYS.abKey, STORAGE_KEYS.otxKey, STORAGE_KEYS.threatFoxKey]);
