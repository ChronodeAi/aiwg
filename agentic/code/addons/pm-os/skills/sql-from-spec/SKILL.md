---
name: sql-from-spec
description: >-
  Use when requirements and a data-tables overview need turning into an
  optimized, readable SQL query with inline explanation of every major
  part. Not for defining the analytics events and schema to instrument
  in the first place (`tracking-schema`), or defining what metric to
  measure (`success-metric`).
---

# Write the query so the next engineer doesn't have to reverse it

## Step 1 — Take the requirements and table overview

Get the query requirements and the overview of the data tables involved.

Done when both the requirements and the table overview are in hand.

## Step 2 — Write the query

Write the SQL: correct joins and conditions across tables, the specified filters, and any needed aggregations or subqueries.

Done when the query fulfills every stated requirement, with no unaddressed filter or aggregation.

## Step 3 — Optimize it

Select only needed columns (no wildcard), use the correct JOIN type for each relationship, and consider indexes on frequently filtered columns.

Done when the query avoids unnecessary column selection and every JOIN type matches the actual data relationship.

## Step 4 — Document it

Use meaningful table/column aliases, format with clear indentation, and add inline comments on any non-obvious logic.

Done when the query is formatted for readability and every non-obvious join, condition, or calculation has an inline comment.

## Output

Present the query and a brief explanation of each major part (purpose of each join/subquery, reasoning behind complex conditions, any assumptions made). Save to `{project_path}/YYMMDD-sql-from-spec-{query-slug}.sql` if requested, resolving the path with `bash bin/memory/resolve-project.sh --project {slug} --json`.
