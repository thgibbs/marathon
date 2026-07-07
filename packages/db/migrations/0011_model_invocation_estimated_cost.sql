-- Separate BILLABLE cost from the API-equivalent ESTIMATE (§4.1/§4.3).
--
-- Under Claude subscription auth there is no per-token dollar spend, so the
-- model's reported cost is a phantom API-equivalent number that must NOT deplete
-- a dollar budget. `cost_usd` now means "actual billable dollars" (0 under
-- subscription) and is what the budget sums; `estimated_cost_usd` always records
-- what the run would have cost at API prices, for observability.
alter table model_invocation add column estimated_cost_usd numeric(12,6);

-- Backfill: existing rows recorded the estimate in cost_usd — preserve it as the
-- estimate. (Reclassifying which historical rows were subscription-billed is a
-- data decision left to the operator, not this schema migration.)
update model_invocation set estimated_cost_usd = cost_usd where estimated_cost_usd is null;
