"""Diagnostic branch only. Emit bounded structural data from the offline fixture."""

from workflow_bench import process_control, proposal_evaluation
from pathlib import Path


def pytest_configure(config):
    run_claude = proposal_evaluation.run_claude
    grade = proposal_evaluation.grade
    group_exists = process_control._group_exists

    def snapshot(pgid):
        found = group_exists(pgid)
        if found:
            members = []
            for path in Path("/proc").glob("[0-9]*/stat"):
                try:
                    name, record = path.read_text().rsplit(")", 1)
                    state, _, group = record.strip().split()[:3]
                    if group == str(pgid):
                        members.append((name, state))
                except OSError:
                    continue
            print("process group at exit", pgid, members, flush=True)
        return found

    def session(*args, **kwargs):
        row = run_claude(*args, **kwargs)
        if not row["ok"] or row["cost_usd"] is None:
            detail = row["error_detail"] or {}
            print("session failure", kwargs["transcript_output_prefix"],
                  row["error_kind"], row["cost_usd"],
                  {k: detail.get(k) for k in ("subtype", "process_state", "process_detail", "returncode", "event_stream_error")},
                  row.get("evidence_diagnostics"), flush=True)
        return row

    def grading(*args, **kwargs):
        try:
            return grade(*args, **kwargs)
        except Exception as exc:
            print("grading failure", type(exc).__name__, str(exc)[:500], flush=True)
            raise

    process_control._group_exists = snapshot
    proposal_evaluation.run_claude = session
    proposal_evaluation.grade = grading
