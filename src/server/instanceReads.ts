// Only these tools may run without an approval. Unknown names fail closed.
export const INSTANCE_READS: ReadonlySet<string> = new Set([
  'query_records', 'get_record', 'count_records', 'aggregate', 'get_table_schema', 'get_mandatory_fields', 'read_script',
]);
export const INSTANCE_WRITES: ReadonlySet<string> = new Set(['create_record', 'update_record', 'delete_record', 'run_script', 'setup_script_runner', 'remove_script_runner']);
