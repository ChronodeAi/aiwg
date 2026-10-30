# Individual test oracle review

Review ID, reviewer and date: {{identity}}
Inventory ID, test file, line/body identity and source hash: {{source_binding}}
Runner lane/case IDs and evidence receipt: {{runner_binding}}
Observed evaluator model/vendor/family: {{observed_identity_or_unknown}}
Acceptance criteria reference: {{criteria_version_or_digest}}
Generator/evaluator disagreements and resolution/check references: {{disagreements}}
Previous review after material fixes (`reReviewOf`): {{previous_review_ref}}
Review scope: {{individual_case_or_complete_file}}
Sibling/parameterized cases covered and remaining: {{scope_accounting}}

| Dimension | Observation and concrete evidence | Conclusion / improvement |
| --- | --- | --- |
| Claimed requirement | {{intended_behavior}} | {{traceability}} |
| Actual SUT boundary | {{implementation_helpers_and_doubles}} | {{what_is_and_is_not_proven}} |
| Success oracle | {{actual_assertions_and_observable_result}} | {{meaningful_or_vacuous}} |
| Failure oracle | {{wrong_result_that_should_fail}} | {{negative_control_or_gap}} |
| Prerequisite handling | {{missing_resource_behavior}} | {{fail_skip_or_false_pass}} |
| Isolation/cleanup | {{owned_state_async_lifecycle}} | {{specific_risk_or_verified_cleanup}} |
| Normalization | {{target_fixture_naming_runner_conventions}} | {{needed_change_or_no_change}} |
| Anti-pattern candidates | {{lexical_leads_plus_control_flow_review}} | {{confirmed_rejected_or_unresolved}} |

Negative control command/change-plan, attributable failure, restored baseline and artifact hashes: {{control_evidence}}
Verdict and confidence: {{supported_defective_or_unresolved_with_basis}}
Repair acceptance condition: {{observable_verification}}

A source smell is not automatically a defect. A mocked boundary may be valid narrow evidence. Suspected flakiness needs
observed repeated outcomes before a rate is reported. A review is stale when its source binding changes. Do not mark a
file completely reviewed from one selected case; machine review input must match the actual completed scope.

Machine records carry these optional fields in `spec.evaluation`; see `$AIWG_ROOT/docs/decision/evaluator-calibration.md`.
Agreement is not proof; consequential conclusions need executable checks or accountable human acceptance.
