# 17. Evaluation design

> **Status: intentionally TBD.** This section is directional. The real eval design — replay
> fixtures against live tools/memory, grader rubrics, whether evals gate releases — will be
> shaped **with users**, once there is a feedback corpus to build from ([[open-questions]]
> OQ-8).

## 17.1 Sources of eval cases

Eval cases can come from:

* Manually written tests
* Failed tasks
* Negative feedback
* High-value successful tasks
* Regression bugs
* Agent owner examples

---

## 17.2 Eval case structure

An eval case should include:

```yaml
name: checkout_error_investigation
agent: bruce
input:
  # invocation fixture: any surface (a Slack thread or a document snapshot)
  source_type: slack
  source_fixture: fixtures/checkout_thread.json
  user_message: "Can you investigate the checkout error spike?"
expected:
  should_call_tools:
    - github.search_issues
    - datadog.query_logs
  should_not_call_tools:
    - github.create_issue
  final_answer_contains:
    - "likely cause"
    - "evidence"
    - "recommended next step"
grader:
  type: llm_and_rules
```

---

## 17.3 Eval types

### Rule-based evals

Good for:

* Required tool usage
* Disallowed tool usage
* Output contains required fields
* No high-risk effect executed without an approved proposal; autonomous-safe actions never prompt (§7.8/§7.9)

### LLM-graded evals

Good for:

* Helpfulness
* Completeness
* Reasoning quality
* Tone
* Relevance

### Human evals

Good for:

* High-value agents
* Ambiguous quality
* Sensitive workflows

---

## 17.4 Release process

Before publishing a new agent version:

1. Run eval suite.
2. Compare against current production version.
3. Check cost delta.
4. Check latency delta.
5. Check tool behavior.
6. Publish if acceptable.
7. Monitor feedback and failures.
8. Roll back if needed.
