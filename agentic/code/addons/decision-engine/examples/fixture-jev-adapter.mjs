const usage = { inputTokens: 8, outputTokens: 2, costUsd: null };

function failure(reason, status = 'error') {
  return { status, reason, uncertainty: null, actualModel: null, usage, requestId: null };
}

function choiceFor(options) {
  const ids = options.map(option => option.id);
  const selected = ids.includes('bug') ? 'bug' : ids[0];
  const probabilities = Object.fromEntries(ids.map(id => [id, id === selected ? 0.9 : ids.length > 1 ? 0.1 / (ids.length - 1) : 0]));
  return {
    status: 'success',
    reason: 'none',
    value: selected,
    uncertainty: { profile: 'typesafe-distribution-v1', confidence: 0.9, distribution: probabilities },
    actualModel: 'offline:synthetic-fixture',
    usage,
    requestId: null,
  };
}

export default {
  id: 'jev',
  version: '1.0.0',
  async capabilities() {
    return { egress: { mode: 'none' } };
  },
  async evaluate(request) {
    if (request.definition.spec.answer.kind !== 'choice') return failure('unsupported-capability', 'unsupported');
    return choiceFor(request.definition.spec.answer.options);
  },
};
