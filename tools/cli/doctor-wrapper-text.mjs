// Compact wrapper findings for text displays while preserving the collected JSON records.
function providerState(finding) {
  const match = finding.message.match(/Tier enforcement \([^)]+\): ([^;]+); effort: ([^.]+)\./);
  if (!match) return null;
  const model = match[1];
  const effort = match[2].startsWith('pinned') ? 'pinned'
    : model === 'global-only' ? 'global-only' : 'inherited';
  return { model, effort };
}

export function wrapperTextFindings(findings) {
  const result = [];
  const warnings = new Map();
  for (const finding of findings) {
    if (finding.name === 'Wrapper enforcement' && finding.status === 'info' && !finding.wrapper) {
      const state = providerState(finding);
      const wrappers = findings.filter(row => row.provider === finding.provider && row.name === finding.name && row.wrapper);
      const matching = wrappers.filter(row => row.modelEnforcement === state?.model && row.effortEnforcement === state?.effort);
      result.push({ ...finding, message: `${finding.message}${matching.length ? ` Wrappers: ${matching.map(row => row.wrapper).join(', ')}.` : ''}` });
    } else if (finding.name === 'Wrapper enforcement' && finding.status === 'info' && finding.wrapper) {
      const parent = findings.find(row => row.provider === finding.provider && row.name === finding.name && !row.wrapper && row.status === 'info');
      const state = parent && providerState(parent);
      if (state?.model === finding.modelEnforcement && state?.effort === finding.effortEnforcement) continue;
      result.push({ ...finding, message: `${finding.provider} ${finding.wrapper}: ${finding.modelEnforcement}; effort: ${finding.effortEnforcement}.` });
    } else if (finding.id && finding.wrapper && finding.remediation) {
      const template = finding.message.replaceAll(finding.wrapper, '<wrapper>');
      const key = JSON.stringify([finding.provider, finding.id, finding.status, template,
        finding.remediation.replaceAll(finding.wrapper, '<wrapper>')]);
      let group = warnings.get(key);
      if (!group) {
        group = { finding, template, wrappers: [] };
        warnings.set(key, group);
        result.push(group);
      }
      group.wrappers.push(finding.wrapper);
    } else result.push(finding);
  }
  return result.map(row => {
    if (!row.wrappers) return row;
    if (row.wrappers.length === 1) return row.finding;
    const prefix = `${row.finding.provider} <wrapper>`;
    const message = row.template.replace(prefix, `${row.finding.provider} ${row.wrappers.join(', ')}`);
    return { ...row.finding, message: `${message} Substitute each listed wrapper for <wrapper>.` };
  });
}
