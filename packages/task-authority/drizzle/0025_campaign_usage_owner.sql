-- campaign_model_runs is the observation-bearing owner of Campaign role usage.
-- Older releases wrote the same amounts into assessment, replacement-result,
-- and proposal projections. Copy only rows that have no canonical observation;
-- the compatibility adapter makes the historical provenance explicit.
INSERT INTO `campaign_model_runs` (
	`invocation_id`, `campaign_id`, `outcome_id`, `role`, `assessment_id`, `evidence_hash`,
	`status`, `failure_class`, `started_at_epoch_ms`, `completed_at_epoch_ms`, `elapsed_ms`,
	`repository_id`, `repository`, `profile`, `configured_provider`, `configured_model`,
	`actual_provider`, `actual_model`, `adapter`, `service_tier`, `reasoning_effort`, `usage`
)
SELECT
	a.`assessment_id`, a.`campaign_id`, a.`outcome_id`, 'assessor', a.`assessment_id`, a.`evidence_hash`,
	'completed', NULL, a.`started_at_epoch_ms`, a.`completed_at_epoch_ms`,
	MAX(0, a.`completed_at_epoch_ms` - a.`started_at_epoch_ms`),
	NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'legacy-compatibility', NULL, NULL,
	json_extract(a.`assessment`, '$.usage')
FROM `campaign_assessments` a
WHERE json_valid(a.`assessment`) = 1
	AND json_extract(a.`assessment`, '$.usage') IS NOT NULL
	AND EXISTS (
		SELECT 1
		FROM json_each(a.`assessment`, '$.usage') AS usage
		WHERE usage.`key` IN (
			'inputTokens', 'cachedInputTokens', 'uncachedInputTokens',
			'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'
		)
			AND usage.`type` = 'integer'
			AND json_type(usage.`value`) = 'integer'
	)
	AND NOT EXISTS (
		SELECT 1 FROM `campaign_model_runs` m WHERE m.`invocation_id` = a.`assessment_id`
	);
--> statement-breakpoint
INSERT INTO `campaign_model_runs` (
	`invocation_id`, `campaign_id`, `outcome_id`, `role`, `assessment_id`, `evidence_hash`,
	`status`, `failure_class`, `started_at_epoch_ms`, `completed_at_epoch_ms`, `elapsed_ms`,
	`repository_id`, `repository`, `profile`, `configured_provider`, `configured_model`,
	`actual_provider`, `actual_model`, `adapter`, `service_tier`, `reasoning_effort`, `usage`
)
SELECT
	r.`invocation_id`, r.`campaign_id`, r.`outcome_id`, 'replacement-planner', r.`assessment_id`, r.`evidence_hash`,
	'completed', NULL,
	r.`started_at_epoch_ms`, COALESCE(r.`completed_at_epoch_ms`, r.`started_at_epoch_ms`),
	MAX(0, COALESCE(r.`completed_at_epoch_ms`, r.`started_at_epoch_ms`) - r.`started_at_epoch_ms`),
	NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'legacy-compatibility', NULL, NULL,
	r.`usage`
FROM `campaign_replacement_runs` r
WHERE json_valid(r.`usage`) = 1
	AND r.`usage` IS NOT NULL
	AND EXISTS (
		SELECT 1
		FROM json_each(r.`usage`) AS usage
		WHERE usage.`key` IN (
			'inputTokens', 'cachedInputTokens', 'uncachedInputTokens',
			'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'
		)
			AND usage.`type` = 'integer'
			AND json_type(usage.`value`) = 'integer'
	)
	AND NOT EXISTS (
		SELECT 1 FROM `campaign_model_runs` m WHERE m.`invocation_id` = r.`invocation_id`
	);
--> statement-breakpoint
-- Preserve the compatibility columns, but remove copied amounts so migrated
-- rows cannot become a second mutable usage authority.
UPDATE `campaign_assessments`
SET `assessment` = json_set(`assessment`, '$.usage', NULL)
WHERE EXISTS (
	SELECT 1 FROM `campaign_model_runs` m
	WHERE m.`invocation_id` = `campaign_assessments`.`assessment_id`
);
--> statement-breakpoint
UPDATE `campaign_replacement_runs`
SET `usage` = NULL
WHERE EXISTS (
	SELECT 1 FROM `campaign_model_runs` m
	WHERE m.`invocation_id` = `campaign_replacement_runs`.`invocation_id`
);
--> statement-breakpoint
UPDATE `campaign_proposals`
SET `replacement_usage` = NULL
WHERE `replacement_usage` IS NOT NULL
	AND EXISTS (
		SELECT 1
		FROM `campaign_replacement_runs` r
		JOIN `campaign_model_runs` m ON m.`invocation_id` = r.`invocation_id`
		WHERE r.`campaign_id` = `campaign_proposals`.`campaign_id`
			AND r.`outcome_id` = `campaign_proposals`.`outcome_id`
			AND r.`assessment_id` = `campaign_proposals`.`replacement_assessment_id`
	);
