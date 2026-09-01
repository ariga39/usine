UPDATE `task_runs`
SET `result` = json_set(
	`result`,
	'$.blockerClassification',
	COALESCE(
		(
			SELECT CASE
				WHEN json_extract(`task_events`.`data`, '$.reason') IN (
					'elapsed_budget',
					'invalid_phase',
					'missing_evidence',
					'provider_failure',
					'project_check_failure',
					'review_inconclusive',
					'delivery_failure',
					'unknown'
				) THEN json_extract(`task_events`.`data`, '$.reason')
				ELSE 'unknown'
			END
			FROM `task_events`
			WHERE `task_events`.`task_id` = `task_runs`.`task_id`
				AND json_extract(`task_events`.`data`, '$.type') = 'task_blocked'
			ORDER BY `task_events`.`sequence`
			LIMIT 1
		),
		'unknown'
	)
)
WHERE json_extract(`result`, '$.state') = 'blocked'
	AND COALESCE(json_type(`result`, '$.blockerClassification'), 'null') = 'null';
