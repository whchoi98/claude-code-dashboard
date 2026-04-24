#!/usr/bin/env node
// Builds infra/edge/dist/ — the self-contained Lambda@Edge bundle packaged
// into every Lambda zip by CDK (see infra/lib/compute-stack.ts).
//
// What it does:
//   1. Reads Cognito config from AWS Secrets Manager (ccd/cognito-config).
//   2. Renders infra/edge/_shared.template.js → dist/_shared.js with the
//      secret sentinel replaced by a JSON literal.
//   3. Copies the handler files (check-auth.js, parse-auth.js, etc.) into
//      dist/ so each handler's `require('./_shared.js')` resolves.
//
// dist/ is in .gitignore — never commit it. Run before every cdk deploy.
//
// Usage:
//   node scripts/build-edge.mjs
//   node scripts/build-edge.mjs --secret-id ccd/cognito-config --region ap-northeast-2

import { readFile, writeFile, copyFile, mkdir, rm, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, basename } from 'node:path'
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

const args = parseArgs(process.argv.slice(2))
const SECRET_ID = args['secret-id'] || 'ccd/cognito-config'
const REGION    = args['region']    || 'ap-northeast-2'

const SRC_DIR  = resolve(REPO_ROOT, 'infra/edge')
const DIST_DIR = resolve(REPO_ROOT, 'infra/edge/dist')
const TEMPLATE = resolve(SRC_DIR, '_shared.template.js')
const OUT_SHARED = resolve(DIST_DIR, '_shared.js')

// Fields required in the final CONFIG object written into _shared.js.
// `userPoolRegion` is derived from either `region` or the userPoolId prefix.
const REQUIRED_OUT = [
  'userPoolId',
  'userPoolRegion',
  'clientId',
  'clientSecret',
  'domain',
]

// The build script looks for this exact pair and replaces everything
// between the two markers (inclusive) with a JSON object literal.
const BEGIN = '/*__CCD_COGNITO_CONFIG__*/'
const END   = '/*__END_COGNITO_CONFIG__*/'

async function main() {
  // 1) Fetch Cognito config
  const client = new SecretsManagerClient({ region: REGION })
  const { SecretString } = await client.send(
    new GetSecretValueCommand({ SecretId: SECRET_ID }),
  )
  if (!SecretString) die(`secret ${SECRET_ID} has no SecretString`)
  const secret = JSON.parse(SecretString)

  const config = {
    userPoolId:     secret.userPoolId,
    userPoolRegion: secret.userPoolRegion || secret.region || parseRegionFromPoolId(secret.userPoolId),
    clientId:       secret.clientId,
    clientSecret:   secret.clientSecret,
    domain:         secret.domain,
  }
  const missing = REQUIRED_OUT.filter((k) => !config[k])
  if (missing.length) die(`could not resolve fields: ${missing.join(', ')} (secret keys present: ${Object.keys(secret).join(', ')})`)

  // 2) Clean and recreate dist/
  await rm(DIST_DIR, { recursive: true, force: true })
  await mkdir(DIST_DIR, { recursive: true })

  // 3) Render template → dist/_shared.js
  const template = await readFile(TEMPLATE, 'utf8')
  if (!template.includes(BEGIN) || !template.includes(END)) {
    die(`template is missing sentinel markers: ${BEGIN} ... ${END}`)
  }
  const configLiteral = JSON.stringify(config)
  const beginIdx = template.indexOf(BEGIN)
  const endIdx   = template.indexOf(END) + END.length
  const rendered = template.slice(0, beginIdx) + configLiteral + template.slice(endIdx)
  await writeFile(OUT_SHARED, rendered, 'utf8')

  // 4) Copy handlers into dist/ (every *.js in edge/ except the template)
  const entries = await readdir(SRC_DIR, { withFileTypes: true })
  const handlers = entries
    .filter((e) => e.isFile() && e.name.endsWith('.js') && !e.name.endsWith('.template.js'))
    .map((e) => e.name)
  for (const name of handlers) {
    await copyFile(resolve(SRC_DIR, name), resolve(DIST_DIR, name))
  }

  console.log(`built ${DIST_DIR}`)
  console.log(`  _shared.js   (${rendered.length} bytes, config from secret ${SECRET_ID})`)
  for (const name of handlers) console.log(`  ${basename(name)}`)
}

// Cognito user pool IDs are `<region>_<suffix>`, e.g. `ap-northeast-2_MpKl4ibhk`.
function parseRegionFromPoolId(poolId) {
  if (typeof poolId !== 'string') return null
  const idx = poolId.indexOf('_')
  return idx > 0 ? poolId.slice(0, idx) : null
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { out[key] = next; i++ }
      else { out[key] = true }
    }
  }
  return out
}

function die(msg) {
  console.error(`build-edge: ${msg}`)
  process.exit(1)
}

main().catch((e) => die(e.message || String(e)))
