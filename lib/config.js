// Shared config contract for dsh-mcp-pill.
// Nested runtime shape stays the same as the historical Settings namespace.
// Official Settings Card writes the same nested section through path mutate.

export const SETTINGS_NS = 'mcp-pill'

export const DEFAULT_SETTINGS = {
  pill: {
    enabled: false,
  },
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function cloneSettings(config) {
  return JSON.parse(JSON.stringify(config || DEFAULT_SETTINGS))
}

export function validateSettings(raw) {
  if (!isPlainObject(raw)) return { ok: false, errors: ['settings must be a JSON object'] }
  
  const errors = []
  const allowedKeys = ['pill']
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.includes(key)) {
      errors.push('unknown top-level key: ' + key)
    }
  }
  
  const d = DEFAULT_SETTINGS
  const pillRaw = isPlainObject(raw.pill) ? raw.pill : {}
  if (raw.pill !== undefined && !isPlainObject(raw.pill)) {
    errors.push('pill must be an object')
  }
  for (const key of Object.keys(pillRaw)) {
    if (key !== 'enabled') errors.push('unknown pill key: ' + key)
  }
  
  const pill = {
    enabled: checkBool(errors, 'pill.enabled', pillRaw.enabled, d.pill.enabled),
  }
  
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, config: { pill } }
}

function checkBool(errors, path, value, fallback) {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  errors.push(path + ' must be a boolean')
  return fallback
}
