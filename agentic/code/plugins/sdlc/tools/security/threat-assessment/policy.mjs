// Validate and resolve threat-assessment policy without scanning content.
import { BUILTIN_PACK_PREFIX, BUILTIN_PACKS, BUILTIN_PROFILES, BUILTIN_RULES, SEVERITIES, THREAT_ASSESSMENT_LIMITS, THREAT_SURFACES } from './builtins.mjs';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validatePattern(pattern, where, errors) {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 500) {
    errors.push(`${where}: must be a non-empty regex string no longer than 500 characters`);
    return;
  }
  try {
    new RegExp(pattern, 'imu');
  } catch (error) {
    errors.push(`${where}: invalid regular expression (${error.message})`);
  }
  if (/\\[1-9]/.test(pattern) || /\(\?<([=!])/.test(pattern)
    || /\([^)]*[+*][^)]*\)[+*{]/.test(pattern) || /(?:\.\*){2,}/.test(pattern)) {
    errors.push(`${where}: unsafe regex construct (backreference, lookbehind, or nested unbounded quantifier)`);
  }
}

function validateStatement(statement, where, errors) {
  if (!isObject(statement)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  if (typeof statement.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(statement.id)) {
    errors.push(`${where}.id: must be a kebab-case identifier`);
  }
  if (!['suppress', 'set-severity'].includes(statement.effect)) {
    errors.push(`${where}.effect: must be suppress or set-severity`);
  }
  if (typeof statement.reason !== 'string' || !statement.reason.trim()) {
    errors.push(`${where}.reason: must be a non-empty string`);
  }
  if (statement.signals !== undefined
    && (!Array.isArray(statement.signals) || !statement.signals.every(signal => typeof signal === 'string'))) {
    errors.push(`${where}.signals: must be an array of strings`);
  }
  if (statement.effect === 'suppress') {
    if (!statement.signals?.length) errors.push(`${where}.signals: suppress statements must name at least one signal`);
    const when = statement.when;
    if (!isObject(when) || !Object.values(when).some(value => Array.isArray(value) && value.length)) {
      errors.push(`${where}.when: suppress statements require at least one narrow condition`);
    }
    if (!isObject(statement.riskAcceptance)
      || typeof statement.riskAcceptance.acceptedBy !== 'string'
      || typeof statement.riskAcceptance.rationale !== 'string') {
      errors.push(`${where}.riskAcceptance: suppress statements require acceptedBy and rationale`);
    }
  }
  if (statement.effect === 'set-severity' && !SEVERITIES.includes(statement.severity)) {
    errors.push(`${where}.severity: set-severity requires a known severity`);
  }
}

export function validateThreatAssessmentConfig(value) {
  const errors = [];
  if (value === undefined || value === null) return errors;
  if (!isObject(value)) return ['security.threatAssessment: must be an object'];
  if (value.schemaVersion !== undefined && value.schemaVersion !== '1') {
    errors.push("security.threatAssessment.schemaVersion: must be '1'");
  }
  if (value.mode !== undefined && !['off', 'audit', 'enforce'].includes(value.mode)) {
    errors.push('security.threatAssessment.mode: must be off, audit, or enforce');
  }
  if (value.defaultProfile !== undefined && typeof value.defaultProfile !== 'string') {
    errors.push('security.threatAssessment.defaultProfile: must be a string');
  }
  if (value.surfaces !== undefined) {
    if (!isObject(value.surfaces)) errors.push('security.threatAssessment.surfaces: must be an object');
    else {
      for (const [surface, entry] of Object.entries(value.surfaces)) {
        if (!THREAT_SURFACES.includes(surface)) {
          errors.push(`security.threatAssessment.surfaces.${surface}: unknown surface`);
          continue;
        }
        if (!isObject(entry)) {
          errors.push(`security.threatAssessment.surfaces.${surface}: must be an object`);
          continue;
        }
        if (entry.mode !== undefined && !['off', 'audit', 'enforce'].includes(entry.mode)) {
          errors.push(`security.threatAssessment.surfaces.${surface}.mode: must be off, audit, or enforce`);
        }
      }
    }
  }
  if (value.rulePacks !== undefined) {
    if (!isObject(value.rulePacks)) errors.push('security.threatAssessment.rulePacks: must be an object');
    else {
      let customRuleCount = 0;
      for (const [name, pack] of Object.entries(value.rulePacks)) {
        const where = `security.threatAssessment.rulePacks.${name}`;
        if (name.startsWith(BUILTIN_PACK_PREFIX)) errors.push(`${where}: project rule packs cannot shadow aiwg: built-ins`);
        if (!isObject(pack) || !Array.isArray(pack.rules)) {
          errors.push(`${where}.rules: must be an array`);
          continue;
        }
        customRuleCount += pack.rules.length;
        if (typeof pack.version !== 'string' || !pack.version.trim()) {
          errors.push(`${where}.version: must be a non-empty string`);
        }
        const ids = new Set();
        pack.rules.forEach((rule, index) => {
          const ruleWhere = `${where}.rules[${index}]`;
          if (!isObject(rule)) {
            errors.push(`${ruleWhere}: must be an object`);
            return;
          }
          if (typeof rule.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(rule.id)) {
            errors.push(`${ruleWhere}.id: must be a kebab-case identifier`);
          } else if (BUILTIN_RULES.some(builtin => builtin.id === rule.id)) {
            errors.push(`${ruleWhere}.id: cannot shadow built-in rule '${rule.id}'`);
          } else if (ids.has(rule.id)) {
            errors.push(`${ruleWhere}.id: duplicate '${rule.id}'`);
          } else ids.add(rule.id);
          if (!SEVERITIES.includes(rule.severity)) errors.push(`${ruleWhere}.severity: unknown severity`);
          for (const dimension of ['likelihood', 'impact']) {
            if (rule[dimension] !== undefined
              && (!Number.isInteger(rule[dimension]) || rule[dimension] < 1 || rule[dimension] > 5)) {
              errors.push(`${ruleWhere}.${dimension}: must be an integer from 1 to 5`);
            }
          }
          if (!Array.isArray(rule.patterns) || rule.patterns.length === 0) {
            errors.push(`${ruleWhere}.patterns: must be a non-empty array`);
          } else if (rule.patterns.length > THREAT_ASSESSMENT_LIMITS.maxPatternsPerRule) {
            errors.push(`${ruleWhere}.patterns: cannot exceed ${THREAT_ASSESSMENT_LIMITS.maxPatternsPerRule} patterns`);
          } else rule.patterns.forEach((pattern, patternIndex) =>
            validatePattern(pattern, `${ruleWhere}.patterns[${patternIndex}]`, errors));
        });
      }
      if (customRuleCount > THREAT_ASSESSMENT_LIMITS.maxCustomRules) {
        errors.push(`security.threatAssessment.rulePacks: cannot exceed ${THREAT_ASSESSMENT_LIMITS.maxCustomRules} custom rules`);
      }
    }
  }
  const profiles = value.profiles ?? {};
  if (!isObject(profiles)) errors.push('security.threatAssessment.profiles: must be an object');
  else {
    const visit = (name, stack = []) => {
      if (stack.includes(name)) {
        errors.push(`security.threatAssessment.profiles.${name}.extends: cyclic inheritance (${[...stack, name].join(' -> ')})`);
        return;
      }
      const profile = profiles[name];
      if (!isObject(profile)) return;
      const parents = profile.extends ?? [];
      if (!Array.isArray(parents)) {
        errors.push(`security.threatAssessment.profiles.${name}.extends: must be an array`);
        return;
      }
      for (const parent of parents) {
        if (!(parent in profiles) && !(parent in BUILTIN_PROFILES) && !String(parent).startsWith('aiwg:')) {
          errors.push(`security.threatAssessment.profiles.${name}.extends: unknown profile '${parent}'`);
        }
        const local = String(parent).replace(/^aiwg:/, '');
        if (local in profiles) visit(local, [...stack, name]);
      }
    };
      for (const [name, profile] of Object.entries(profiles)) {
      const where = `security.threatAssessment.profiles.${name}`;
      if (!isObject(profile)) {
        errors.push(`${where}: must be an object`);
        continue;
      }
      if (name in BUILTIN_PROFILES || name.startsWith(BUILTIN_PACK_PREFIX)) {
        errors.push(`${where}: project profiles cannot shadow built-in profiles`);
      }
      if (profile.mode !== undefined && !['off', 'audit', 'enforce'].includes(profile.mode)) {
        errors.push(`${where}.mode: must be off, audit, or enforce`);
      }
      if (profile.version !== undefined && (typeof profile.version !== 'string' || !profile.version.trim())) {
        errors.push(`${where}.version: must be a non-empty string`);
      }
      if (profile.ruleSets !== undefined) {
        if (!Array.isArray(profile.ruleSets) || !profile.ruleSets.every(pack => typeof pack === 'string')) {
          errors.push(`${where}.ruleSets: must be an array of strings`);
        } else {
          for (const pack of profile.ruleSets) {
            if (!BUILTIN_PACKS[pack] && !value.rulePacks?.[pack]) {
              errors.push(`${where}.ruleSets: unavailable rule pack '${pack}'`);
            }
          }
        }
      }
      if (profile.statements !== undefined) {
        if (!Array.isArray(profile.statements)) errors.push(`${where}.statements: must be an array`);
        else profile.statements.forEach((statement, index) =>
          validateStatement(statement, `${where}.statements[${index}]`, errors));
      }
      for (const [threshold, severity] of Object.entries(profile.thresholds ?? {})) {
        if (!['flag', 'requireAuthorization', 'reject'].includes(threshold) || !SEVERITIES.includes(severity)) {
          errors.push(`${where}.thresholds.${threshold}: must use a known action threshold and severity`);
        }
      }
      visit(name);
    }
  }
  const defaultName = value.defaultProfile ?? 'balanced';
  if (!(defaultName in BUILTIN_PROFILES) && !(defaultName in profiles)) {
    errors.push(`security.threatAssessment.defaultProfile: unknown profile '${defaultName}'`);
  }
  if (value.statements !== undefined) {
    if (!Array.isArray(value.statements)) errors.push('security.threatAssessment.statements: must be an array');
    else value.statements.forEach((statement, index) =>
      validateStatement(statement, `security.threatAssessment.statements[${index}]`, errors));
  }
  return Array.from(new Set(errors));
}

function mergeProfile(base, extension) {
  return {
    ...base,
    ...extension,
    thresholds: { ...(base.thresholds ?? {}), ...(extension.thresholds ?? {}) },
    ruleSets: extension.ruleSets ?? base.ruleSets ?? [],
    statements: [...(base.statements ?? []), ...(extension.statements ?? [])],
  };
}

function resolveProfile(name, config, stack = []) {
  const builtinName = String(name).replace(/^aiwg:/, '');
  if (BUILTIN_PROFILES[builtinName]) return structuredClone(BUILTIN_PROFILES[builtinName]);
  if (stack.includes(name)) throw new Error(`Cyclic threat-assessment profile inheritance: ${[...stack, name].join(' -> ')}`);
  const raw = config.profiles?.[name];
  if (!raw) throw new Error(`Unknown threat-assessment profile '${name}'`);
  let resolved = {};
  for (const parent of raw.extends ?? ['aiwg:balanced']) {
    resolved = mergeProfile(resolved, resolveProfile(parent, config, [...stack, name]));
  }
  return mergeProfile(resolved, raw);
}

export function resolveThreatAssessmentPolicy(rawConfig, surface) {
  const config = rawConfig ?? {};
  const errors = validateThreatAssessmentConfig(config);
  if (errors.length) throw new Error(`Invalid threat-assessment configuration:\n${errors.join('\n')}`);
  if (!THREAT_SURFACES.includes(surface)) throw new Error(`Unknown threat-assessment surface '${surface}'`);
  const surfaceConfig = config.surfaces?.[surface] ?? {};
  const profileName = surfaceConfig.profile ?? config.defaultProfile ?? 'balanced';
  const profile = resolveProfile(profileName, config);
  const mode = surfaceConfig.mode ?? config.mode ?? profile.mode ?? 'enforce';
  return {
    schemaVersion: config.schemaVersion ?? '1',
    mode,
    profileName,
    profile,
    surface,
    config,
    provenance: rawConfig
      ? { source: '.aiwg/aiwg.config', path: 'security.threatAssessment' }
      : { source: 'aiwg-default', path: 'aiwg:balanced' },
  };
}

