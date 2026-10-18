#!/usr/bin/env node

import { boundedSpawnSync } from '../../src/process/bounded-child-process.mjs'

function usage() {
  console.error('Usage: wait-for-github-tag.mjs --repo OWNER/REPO --tag TAG --expected-sha SHA [--attempts N] [--delay-seconds N]')
}

function parseArgs(argv) {
  const options = { attempts: 30, delaySeconds: 10 }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value) throw new Error(`${flag ?? 'argument'} requires a value`)
    if (flag === '--repo') options.repo = value
    else if (flag === '--tag') options.tag = value
    else if (flag === '--expected-sha') options.expectedSha = value
    else if (flag === '--attempts') options.attempts = Number(value)
    else if (flag === '--delay-seconds') options.delaySeconds = Number(value)
    else throw new Error(`Unknown option: ${flag}`)
  }
  if (!options.repo || !options.tag || !options.expectedSha) throw new Error('--repo, --tag, and --expected-sha are required')
  if (!Number.isInteger(options.attempts) || options.attempts < 1) throw new Error('--attempts must be a positive integer')
  if (!Number.isFinite(options.delaySeconds) || options.delaySeconds < 0) throw new Error('--delay-seconds must be non-negative')
  return options
}

const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds))

function redactTokens(message) {
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
    const token = process.env[key]
    if (token) message = message.replaceAll(token, '[REDACTED]')
  }
  return message
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED]')
    .replace(/(authorization:\s*)[^\r\n]*/gi, '$1[REDACTED]')
}

function responseStatus(result, diagnostic) {
  const httpStatus = diagnostic.match(/\bHTTP\s+(\d{3})\b/i)?.[1]
  if (httpStatus) return Number(httpStatus)
  for (const output of [result.stdout, result.stderr]) {
    for (const body of [output, ...(output || '').split('\n')]) {
      try {
        const status = JSON.parse(body)?.status
        if (/^[1-5]\d{2}$/.test(String(status))) return Number(status)
      } catch {
        // gh may emit plain text diagnostics alongside the JSON body.
      }
    }
  }
  return /\bNot Found\b/i.test(diagnostic) ? 404 : undefined
}

function transientDelay(diagnostic, delaySeconds, attempt) {
  const retryAfter = diagnostic.match(/^retry-after:\s*([^\r\n]+)/im)?.[1]?.trim()
  if (retryAfter) {
    const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) : (Date.parse(retryAfter) - Date.now()) / 1000
    if (Number.isFinite(seconds)) return Math.min(60, Math.max(0, seconds))
  }
  return Math.min(60, delaySeconds * 2 ** Math.min(attempt - 1, 1023))
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    usage()
    console.error(`Error: ${error.message}`)
    process.exitCode = 2
    return
  }

  const endpoint = `repos/${options.repo}/git/ref/tags/${encodeURIComponent(options.tag)}`
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const result = boundedSpawnSync(process.env.GH_BIN || 'gh', ['api', endpoint], 'network', {
      encoding: 'utf8',
      env: process.env,
    })

    if (result.status === 0) {
      let response
      try {
        response = JSON.parse(result.stdout)
      } catch {
        throw new Error('GitHub returned an invalid tag-ref response')
      }
      const type = response?.object?.type
      if (type === 'tag') {
        if (response.object.sha !== options.expectedSha) {
          throw new Error(`GitHub tag ${options.tag} has object ${response.object.sha}; expected original signed tag object ${options.expectedSha}`)
        }
        console.log(`Found annotated tag ${options.tag} on ${options.repo} (object ${response.object.sha}).`)
        return
      }
      if (type === 'commit') {
        throw new Error(`GitHub tag ${options.tag} is lightweight; refusing to create a release. Push the original signed annotated tag object.`)
      }
      throw new Error(`GitHub tag ${options.tag} references unexpected object type ${type ?? '<missing>'}`)
    }

    const diagnostic = `${result.stderr || ''}\n${result.stdout || ''}`
    const httpStatus = responseStatus(result, diagnostic)
    const notFound = httpStatus === 404
    const transient = httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599)
    if (result.error || result.status === null || (!notFound && !transient)) {
      if (result.stderr) console.error(redactTokens(result.stderr.trim()))
      else if (result.stdout) console.error(redactTokens(result.stdout.trim()))
      throw new Error(redactTokens(`gh api failed while checking tag ${options.tag} on ${options.repo} (exit ${result.status ?? result.signal ?? 'unknown'})${result.error ? `: ${result.error.message}` : ''}`))
    }

    if (transient) {
      if (attempt === options.attempts) {
        console.error(redactTokens(diagnostic.trim()))
        throw new Error(`GitHub transient HTTP ${httpStatus} retry budget exhausted checking tag ${options.tag} on ${options.repo} after ${options.attempts} attempts`)
      }
      const delay = transientDelay(diagnostic, options.delaySeconds, attempt)
      console.log(`GitHub returned HTTP ${httpStatus} (attempt ${attempt}/${options.attempts}); waiting ${delay}s before retrying.`)
      await sleep(delay * 1000)
    } else if (attempt < options.attempts) {
      console.log(`Tag ${options.tag} is not on GitHub yet (attempt ${attempt}/${options.attempts}); waiting ${options.delaySeconds}s for the operator push.`)
      await sleep(options.delaySeconds * 1000)
    }
  }

  throw new Error(`Timed out waiting for annotated tag ${options.tag} on ${options.repo} after ${options.attempts} attempts`)
}

main().catch(error => {
  console.error(`Error: ${error.message}`)
  process.exitCode = 1
})
