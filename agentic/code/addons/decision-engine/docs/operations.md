# Decision Engine operations

Decision evaluation is disabled unless `AIWG_DECISION_ENABLED=1`. Install the
addon, author immutable definitions/rulesets/bindings under an authorized
artifact root, and invoke `decision-evaluate` with runtime configuration kept
outside those portable artifacts.

Jev uses `https://api.typesafe.ai/v1/systemone` with bearer authentication. A
binding stores only a logical `credentialRef`; the dispatcher request maps it
to an operator-provided environment-variable name. Production deployments
should provide that variable through their scoped secret reader. Logs and
receipts contain neither the value nor its private locator.

An LLM binding pins a subagent. The runtime adapter module must resolve that
exact pin and execute a bounded, tool-free structured-output task. A plan-only
route, missing terminal event, prose wrapper, or schema-invalid object fails
closed.

Timeouts and retries are bounded twice: by each target and by the binding's
total deadline/attempt ceiling. The dispatcher is the retry owner; FlowGraph
nodes invoking it must set graph-level retries to zero. A backend swap creates
a new binding pin and invocation. Existing receipts are never reinterpreted.

Outcomes are data. Any downstream action goes through the ordinary AIWG policy
and authorization gates independently.
