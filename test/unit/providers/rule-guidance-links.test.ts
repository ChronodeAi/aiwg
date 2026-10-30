import { describe, expect, it } from 'vitest';
import { projectOnDemandReferences } from '../../../tools/agents/providers/rule-presentation.mjs';

const pointer = '`aiwg show rule policy-guidance --body`';
const reference = `[details](./policy-guidance.md) (${pointer}, on-demand)`;
function rules(activation = 'on-demand', text = reference) {
  return [
    { file: '/fixture/rules/policy.md', name: 'policy', tagged: true, activation: 'kernel', content: text, body: text, coreBody: text },
    { file: '/fixture/rules/policy-guidance.md', name: 'policy-guidance', tagged: true, activation, content: 'Guidance.', body: 'Guidance.' },
  ];
}

describe('deploy-time on-demand rule references', () => {
  it('projects every delivered body without changing catalog source objects', () => {
    const source = rules();
    const [projected] = projectOnDemandReferences(source);
    for (const key of ['content', 'body', 'coreBody']) expect(projected[key]).toBe(`${pointer} (on-demand)`);
    expect(source[0].content).toBe(reference);
    expect(projectOnDemandReferences(projectOnDemandReferences(source))).toEqual(projectOnDemandReferences(source));
  });

  it('normalizes the legacy pointer without --body and accepts a bare sibling path', () => {
    const text = '[details](policy-guidance.md) (`aiwg show rule policy-guidance`, on-demand)';
    expect(projectOnDemandReferences(rules('on-demand', text))[0].body).toBe(`${pointer} (on-demand)`);
  });

  it.each(['summary', 'bound', 'core', 'paths'])('uses the pointer for a %s sibling without a native rule file', activation => {
    expect(projectOnDemandReferences(rules(activation))[0].body).toBe(`${pointer} (on-demand)`);
  });

  it.each(['kernel', 'paths'])('keeps links to %s siblings selected for native deployment', activation => {
    expect(projectOnDemandReferences(rules(activation), true)[0].body).toBe(reference);
  });

  it.each([
    '[details](./missing.md) (`aiwg show rule missing --body`, on-demand)',
    '[details](./policy-guidance.md)',
    '[details](./policy-guidance.md) (`aiwg show rule different --body`, on-demand)',
    '[details](../policy-guidance.md) (`aiwg show rule policy-guidance --body`, on-demand)',
    '[details](https://example.test/policy-guidance.md) (`aiwg show rule policy-guidance --body`, on-demand)',
  ])('preserves references outside the matching sibling/on-demand contract: %s', text => {
    expect(projectOnDemandReferences(rules('on-demand', text))[0].body).toBe(text);
  });

  it('keeps a same-named rule from another source directory from authorizing a rewrite', () => {
    const source = rules();
    source[1].file = '/other/rules/policy-guidance.md';
    expect(projectOnDemandReferences(source)[0].body).toBe(reference);
  });
});
