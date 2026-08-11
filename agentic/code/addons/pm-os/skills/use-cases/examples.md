# Worked use case examples

Reference for [`SKILL.md`](SKILL.md) Step 4. Four examples spanning brief form through Cockburn's fully-dressed template, plus the recurring project patterns.

## Example 1 — Research → use cases

**Input:** 12 freelancers interviewed about invoicing pain points. Findings: 3+ hours/month on invoices; "I forget to bill for small tasks"; "clients take weeks to pay"; "I don't know which clients owe me money".

**Actors:** Freelancer (primary), Client (secondary), Payment processor (system)

**UC1: Log billable work** — Actor: Freelancer · Goal: record work done so it can be billed · Trigger: completes a task · Success: entry saved with project, time, description

**UC2: Generate invoice** — Actor: Freelancer · Goal: create and send an invoice for unpaid work · Trigger: end of billing period or manual request · Success: invoice sent to client with payment link

**UC3: Track payment status** — Actor: Freelancer · Goal: know which invoices are paid or pending · Trigger: opens dashboard · Success: clear list with status indicators

**UC4: Send payment reminder** — Actor: System · Goal: prompt client to pay an overdue invoice · Trigger: invoice past due date · Success: reminder sent, freelancer notified

## Example 2 — Broad idea → use cases

**Input:** "I want to build an AI meeting assistant." No research.

**Clarification questions asked:** who is in the meeting? (participants) · what does "help" mean? (recording, summarising, action items) · when does help happen? (during, after, or both)

**Actors:** Meeting participant (primary), Meeting organizer (primary), Team member not in the meeting (secondary)

**UC1: Join and record meeting** — Goal: capture meeting audio for later processing · Trigger: meeting starts, bot joins · Success: full recording available post-meeting

**UC2: Generate meeting summary** — Goal: get key points without rewatching · Trigger: meeting ends · Success: bullet summary delivered within 5 minutes

**UC3: Extract action items** — Goal: know what they need to do · Trigger: meeting ends · Success: action items with assignees and deadlines

**UC4: Search meeting history** — Actor: Team member · Goal: find when a topic was discussed · Trigger: manual search query · Success: relevant meeting segments identified

## Example 3 — Multi-actor approval workflow

**UC1: Submit request for approval** — Actor: Employee · Goal: get manager approval for an expense · Preconditions: logged in, has expense details · Trigger: employee submits form · Success: request in manager's queue, employee notified

**UC2: Review and approve request** — Actor: Manager · Goal: approve or reject a subordinate's request · Preconditions: request pending in queue · Trigger: manager opens request · Extensions: 2a. needs more info → return to employee with questions; 2b. delegate → assign to another approver · Success: decision recorded, employee notified

**UC3: Escalate overdue request** — Actor: System · Goal: ensure requests don't stall · Trigger: request unapproved for 48 hours · Success: notification to manager and their manager

## Example 4 — Fully-dressed use case (Cockburn template)

**Use Case UC7: Process ATM Withdrawal**

**Scope:** ATM Banking System
**Level:** User-goal (blue/sea level)
**Primary Actor:** Bank Customer

**Stakeholders & Interests:**
- Bank Customer: wants to access cash conveniently, wants the account debited correctly
- Bank Owners: want to prevent fraud, ensure accurate transactions
- Regulatory Agency: wants an audit trail of all transactions
- Network Provider: wants reliable communication for transaction authorization

**Preconditions:**
- ATM has cash available
- ATM is online with the banking network
- Customer has a valid ATM card

**Minimal Guarantees:**
- Transaction logged for audit
- Card returned if PIN entered
- Account not debited if cash not dispensed

**Success Guarantee:**
- Customer receives requested cash
- Account debited correct amount
- Receipt issued with transaction details
- Transaction logged for audit

**Trigger:** Customer inserts ATM card into the card reader

**Main Success Scenario:**
1. Customer inserts ATM card
2. System validates card and reads account
3. System prompts for PIN
4. Customer enters PIN
5. System validates PIN
6. System displays transaction options
7. Customer selects "Withdraw Cash"
8. System prompts for amount
9. Customer enters amount
10. System validates sufficient funds
11. System dispenses cash
12. System debits account
13. System prints receipt
14. System ejects card
15. Customer takes cash, receipt and card

**Extensions:**
- 2a. Invalid card: System ejects card with error message
- 4a. Invalid PIN: System prompts to retry (max 3 attempts)
- 4b. Card retained after 3 failed PINs: System retains card, notifies bank
- 10a. Insufficient funds: System offers to withdraw available balance
- 10b. Daily limit exceeded: System shows remaining daily allowance
- 11a. Cash dispenser jam: System reverses debit, logs error, notifies bank

**Technology & Data Variations:**
- Card type: magnetic stripe or chip
- Receipt: printed or SMS/email
- Language: English, Spanish or Chinese based on customer preference

**Meta:** Frequency=Daily, Priority=Must-have

## Example 5 — B2B SaaS with permissions

Enterprise products carry permission structures — Admin, Editor, Viewer, Guest — and cross-organizational actors (internal users vs external clients). Document the permission in the preconditions: "User has Admin role".

**Use Case UC8: Generate Customer Health Report**

**Scope:** Customer Analytics Platform
**Level:** User-goal
**Primary Actor:** Account Manager (Editor role)

**Stakeholders & Interests:**
- Account Manager: monitors customer health proactively
- Customer Success Director: has visibility into portfolio health
- Customer: receives timely intervention before churn
- Data Team: reports are accurate and actionable

**Preconditions:**
- User is logged in with Editor or Admin role
- Customer data has been synced within the last 24 hours
- Target customer account is in the user's portfolio

**Minimal Guarantees:**
- Report not generated if data is stale (>7 days)
- User notified if permission insufficient
- All access attempts logged for audit

**Success Guarantee:**
- Report displays health score, usage trends and risk factors
- Data is current within 24 hours
- Report can be exported to PDF or shared via link

**Trigger:** Account Manager selects a customer and clicks "Generate Health Report"

**Main Success Scenario:**
1. Account Manager selects customer from portfolio
2. System verifies Editor/Admin role
3. System retrieves customer data from warehouse
4. System calculates health score using ML model
5. System generates trend visualization
6. System identifies risk factors
7. System displays complete health dashboard
8. Account Manager reviews insights
9. Account Manager exports report to PDF
10. System logs report generation for audit

**Extensions:**
- 2a. User has Viewer role only: System shows read-only preview, suggests upgrade
- 3a. Data stale: System warns about data age, offers to proceed with cached data
- 4a. ML model unavailable: System uses fallback heuristic scoring
- 7a. No risk factors detected: System shows "Healthy" status with trend confirmation
- 9a. Export fails: System retries, then offers email delivery

**Technology & Data Variations:**
- Data source: real-time API or cached warehouse
- Visualization: interactive chart or static image
- Export: PDF, PowerPoint or shared dashboard link

**Meta:** Frequency=Weekly, Priority=Should-have

## Recurring project patterns

**Research-first:** summarise findings → extract job-to-be-done statements → map jobs to actors → write a use case per job → validate against research quotes.

**Idea-first:** define the core value proposition → identify who benefits → describe a day in their life → find the moments where the product helps → write a use case per moment.

**Feature-first:** list what the feature does → ask "who does this help and how?" → work backwards to actor goals → check success criteria match business goals.

**MVP scope control:** must-have is the core value proposition (without it the product is useless); should-have is important but has a workaround and can be manual at first; nice-to-have is a delighter, added only after the core works.

## Handling awkward sessions

- **Argumentative user** ("that use case doesn't fit our model") — acknowledge, ask for their framing, find the common ground.
- **Extremely vague request** ("we need use cases") — ask about current pain points, existing workarounds, success stories.
- **Scope explosion** ("and also…") — capture each as a separate use case, prioritise, focus on must-haves first.
- **Circular dependencies** — identify the cycle, break it with a system actor, or merge into one use case.
