/** Grok Bot product UX hints behind the provider-neutral handoff command. */
export const grokbotHandoffGuidance: Record<string, string[]> = {
  routines: [
    'Ask the owning Bot to draft a routine using the proposed schedule and timezone below.',
    'Review the owning Bot, trigger interpretation, inputs, approval boundary, failure handling and existing routines before creating anything.',
    'Require a separate approval to create or change the routine. Do not overwrite an operator-authored routine.',
    'After creation, inspect it in conversation details → Routines. Test only after reviewing possible external actions; pause it there to disable.',
  ],
  teammates: [
    'Use the referenced AIWG agent template as source material for a proposed Bot name, role description and responsibilities.',
    'Show the proposed profile and identify any existing Bot with that role before asking for approval to create or edit.',
    'The operator can use Create new Bot and Edit Profile. Preserve operator-authored descriptions; do not create teammates automatically.',
  ],
  connectors: [
    'Treat this as a connector recommendation. Check whether the requested connector is available and permitted in Marketplace.',
    'Show the requested service and access scope for review. The operator chooses Add and completes product authentication.',
    'Do not generate OAuth tokens or native config, install plugins, or claim that an AIWG MCP server is registered.',
    'Use @ in chat to confirm the installed connector is available. The operator manages disablement in Marketplace.',
  ],
  memory: [
    'Propose only the short summary and source references below for the operator to review.',
    'Do not append to Grok memory until the operator separately approves the note in the product.',
    'Reopen current sources for consequential decisions. Never copy full artifact bodies, cookies, clipboard contents, credentials or sessions into memory.',
  ],
};
