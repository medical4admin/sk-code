const productionOrigins = [
  "https://sk-coder.site",
  "https://www.sk-coder.site",
  "https://admin.sk-coder.site",
  "https://api.sk-coder.site",
]
const localOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/

export function isAllowedOrigin(origin?: string, environment: NodeJS.ProcessEnv = process.env) {
  if (!origin)
    return true
  const configuredOrigins = (environment.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean)
  if (configuredOrigins.length)
    return configuredOrigins.includes(origin)
  if (environment.NODE_ENV === "production")
    return productionOrigins.includes(origin)
  return localOrigin.test(origin)
}
