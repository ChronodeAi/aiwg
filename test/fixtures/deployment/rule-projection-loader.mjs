// Count the actual projection boundary across CLI children and preparation
// workers, rather than inferring execution from deduplicated preview output.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/providers/rule-delivery.mjs')) return result;
  const boundary = 'function projectRules(opts, provider) {';
  const source = result.source.toString();
  if (!source.includes(boundary)) throw new Error('Rule projection instrumentation boundary changed');
  return {
    ...result,
    source: source.replace(boundary, `${boundary}
      fs.appendFileSync(process.env.AIWG_TEST_RULE_PROJECTION_TRACE, JSON.stringify(provider.name) + '\\n');`),
  };
}
