Based on the feedback provided, here's a revised design document draft for the recent commands view, focusing on aligning it with existing infrastructure and guidelines.

---

# Recent Commands View

## Overview
This document outlines a proposal for a Read-Only HTTP endpoint to display the recent commands executed within Marathon. The view will leverage existing data stored in the database to provide insights into tool invocations, ensuring compliance with pre-existing protocols and structures.

## 1. Data Source
The data for this view will be sourced from existing records within Marathon. Specific tables and APIs to be utilized include:

- **Tool Invocations**: Data will be pulled from the `tool_invocation` table, which records every governed tool call, including brokered commands such as `github.exec` and `git.exec`, along with their respective arguments and exit codes.
- **Model Calls**: Information will be retrieved from the `model_invocation` table, documenting calls made to models.
- **Task Steps**: Logs from the `task_step` table will also be utilized to provide a comprehensive overview.

The existing observability tools located in `@marathon/observability` offer endpoints `getTaskTimeline` and `getTaskReport`, which we will integrate to present the timeline for recent tasks.

### Definition of Command
For the purpose of this document, "command" refers explicitly to tool invocations, including their status and error outputs.

## 2. Page Location and Structure
Given that Marathon currently lacks a web UI (with the admin console deferred as per design §16, §0.5), this implementation will take the form of:

- A read-only HTTP endpoint serving plain server-rendered HTML.
- This will be housed in a new small package or integrated alongside an existing application.

### Tenant Isolation
The timeline will maintain tenant-scoped reads per existing protocols, ensuring data isolation. The endpoint will bind to `localhost` by default, as there is no plan for external exposure or authentication in v1.

## 3. Project Scope and Non-goals
This implementation emphasizes pragmatic minimalism. The following features will not be included in v1:

- Real-time WebSocket updates
- In-page filters and sorting mechanisms

A simple page refresh will suffice to retrieve the latest data, with these features noted as explicit non-goals for future considerations.

## 4. Data Redaction
To ensure the security of sensitive information, command arguments and outputs that might contain confidential text will be processed through the existing redaction mechanism (`redactSecrets` in `@marathon/core`). This requirement will be treated as a priority in the development cycle, rather than a subsequent addition.

## 5. Verification
A concrete verification section will be included in the implementation. The following checks will be enforced as part of the build stage:

- `pnpm typecheck`
- `pnpm test`
- A new unit test specifically targeting the rendering of the recent commands view.

## Conclusion
This document proposes a foundational structure for the Recent Commands View within Marathon, designed to integrate with existing data sources, maintain tenant isolation, and comply with security measures while adhering to the principles of pragmatic minimalism.

---

Next, I'll submit this revision to the document management system for review. 