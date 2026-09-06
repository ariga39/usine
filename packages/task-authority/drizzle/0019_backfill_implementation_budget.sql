UPDATE `task_runs`
SET `result` = json_set(`result`, '$.blockerClassification', 'implementation_budget')
WHERE json_extract(`result`, '$.state') = 'blocked'
	AND json_extract(`result`, '$.blocker') = 'implementer activation budget exhausted'
	AND (
		json_extract(`result`, '$.blockerClassification') IN ('elapsed_budget', 'unknown')
		OR json_type(`result`, '$.blockerClassification') IS NULL
	);

UPDATE `task_events`
SET `data` = json_set(`data`, '$.reason', 'implementation_budget')
WHERE json_extract(`data`, '$.type') = 'task_blocked'
	AND json_extract(`data`, '$.reason') = 'elapsed_budget'
	AND `task_id` IN (
		SELECT `task_id`
		FROM `task_runs`
		WHERE json_extract(`result`, '$.state') = 'blocked'
			AND json_extract(`result`, '$.blocker') = 'implementer activation budget exhausted'
	);
