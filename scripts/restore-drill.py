#!/usr/bin/env python3
"""Offline backup recovery exercise. Never starts services or opens a live store."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import tarfile
import time

TIERS = {"store": "store.db", "skills": "skills.tar.gz", "runs": "runs.tar.gz",
         "archive": "archive.tar.gz", "projects": "projects.tar.gz", "supervisor": "supervisor.tar.gz"}


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def archive_members(archive, expected_root):
    for member in archive:
        path = PurePosixPath(member.name)
        if (path.is_absolute() or ".." in path.parts or "\\" in member.name
                or any(":" in part or part.rstrip(" .") != part for part in path.parts)
                or not path.parts or path.parts[0] != expected_root
                or not (member.isdir() or member.isfile())):
            raise ValueError(f"Unsupported or unsafe archive entry: {member.name!r}")
        yield member, path


def component(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError("Invalid structured project/run identity")
    return value


def inspect_store(store, projects):
    # No production open helper: it could apply DDL or reconcile interrupted runs.
    with sqlite3.connect(store.as_uri() + "?mode=ro", uri=True) as db:
        db.execute("PRAGMA query_only=ON")
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("Restored SQLite integrity check failed")
        if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError("Restored SQLite foreign-key check failed")
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        result = {"integrity": "ok", "projectTable": "present" if "project_runs" in tables else "absent",
                  "projectRuns": [], "issues": []}
        if "project_runs" not in tables:
            return result
        db.row_factory = sqlite3.Row
        for row in db.execute("SELECT project_run_id,project_id,org_id,status,trace_id,started_at,ended_at FROM project_runs ORDER BY created_at,project_run_id"):
            run_id = component(row["project_run_id"])
            relative = Path("orgs") / component(row["org_id"]) / "projects" / component(row["project_id"]) / "runs" / run_id
            folder = projects / relative
            found = {"runId": run_id, "status": row["status"], "workspace": (folder / "workspace").is_dir(),
                     "log": (folder / "run.log").is_file(), "trace": None}
            if row["trace_id"]:
                trace_id = component(row["trace_id"])
                found["trace"] = (folder / "traces" / (trace_id + ".json")).is_file()
                if not found["trace"]:
                    result["issues"].append({"runId": run_id, "reason": "missing-trace"})
            if row["started_at"] and not found["log"]:
                result["issues"].append({"runId": run_id, "reason": "missing-log"})
            if row["status"] == "delivered" and not found["workspace"]:
                result["issues"].append({"runId": run_id, "reason": "missing-delivered-workspace"})
            if row["status"] in ("queued", "running"):
                result["issues"].append({"runId": run_id, "reason": "nonterminal-row-no-reconciliation-performed"})
            result["projectRuns"].append(found)
        return result


def drill(snapshot, destination):
    started = time.monotonic()
    snapshot = snapshot.resolve(strict=True)
    destination = destination.absolute()
    # Resolve the parent before comparing, but never follow a pre-existing destination.
    destination = destination.parent.resolve(strict=True) / destination.name
    if destination.exists() or destination.is_symlink():
        raise ValueError("Destination must not exist; recovery never overwrites a directory")
    if destination == snapshot or snapshot in destination.parents or destination in snapshot.parents:
        raise ValueError("Snapshot and destination must be separate trees")
    manifest_path = snapshot / "manifest.json"
    if manifest_path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError("Oversized backup manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    captured = manifest.get("captured")
    if not isinstance(captured, list) or not all(isinstance(x, str) for x in captured):
        raise ValueError("Missing captured inventory")
    if len(captured) != len(set(captured)) or set(captured) - set(TIERS.values()) or "store.db" not in captured:
        raise ValueError("Invalid captured inventory or missing store")
    # WHICH ABSENCES THIS DEPLOYMENT DECLARED. A tier absent from a host is
    # either a shape fact (no ~/.atoma/archive on a server that runs no
    # benchmarks) or a loss (no skills/ on that same server). Requiring all
    # six made every deployed-shape snapshot exit 2; forgiving every skip
    # would make this drill reassuring about exactly the case it exists to
    # catch. So the snapshot declares, and everything undeclared stays
    # mandatory — an old manifest with no declaration still requires all six.
    optional = manifest.get("optionalTiers", [])
    if not isinstance(optional, list) or not all(isinstance(x, str) for x in optional):
        raise ValueError("Invalid optionalTiers declaration")
    optional = set(optional)
    if optional - set(TIERS):
        raise ValueError("Unknown tier in optionalTiers declaration")
    if "store" in optional:
        raise ValueError("The store tier cannot be declared optional")
    expected = set(TIERS) - optional
    verified = {}
    # Verify ALL archives before creating the destination, then copy only verified bytes.
    for tier, filename in TIERS.items():
        if filename not in captured:
            if tier in manifest:
                raise ValueError(f"Tier {tier} disagrees with captured inventory")
            continue
        item = manifest.get(tier)
        source = snapshot / filename
        if not isinstance(item, dict) or source.is_symlink() or not source.is_file():
            raise ValueError(f"Missing regular snapshot file: {filename}")
        if source.stat().st_size != item.get("bytes") or digest(source) != item.get("sha256"):
            raise ValueError(f"Size or SHA-256 mismatch: {filename}")
        root_name = re.split(r"[/\\]", str(item.get("source", "")).rstrip("/\\"))[-1]
        if tier != "store":
            with tarfile.open(source, "r:gz") as archive:
                for _ in archive_members(archive, root_name):
                    pass
        verified[tier] = {"filename": filename, "root": root_name, "sha256": item["sha256"]}
    destination.mkdir(mode=0o700)
    report = {"schema": "atoma.restore-drill/v1", "manifestSha256": digest(manifest_path),
              "verified": verified, "skipped": manifest.get("skipped", []),
              "expectedTiers": sorted(expected), "notApplicableTiers": sorted(optional),
              "missingExpectedTiers": sorted(expected - set(verified)),
              "excluded": {tier: manifest[tier].get("excluded", []) for tier in verified},
              "servicesStarted": False}
    # Copy the input to pin it against later source changes; recheck before extraction.
    inputs = destination / "verified-input"
    inputs.mkdir()
    for tier, info in verified.items():
        local = inputs / info["filename"]
        shutil.copyfile(snapshot / info["filename"], local)
        if digest(local) != info["sha256"]:
            raise ValueError("Snapshot changed during recovery")
        if tier == "store":
            shutil.copyfile(local, destination / "store.db")
            continue
        target = destination / tier
        target.mkdir()
        with tarfile.open(local, "r:gz") as archive:
            for member, relative in archive_members(archive, info["root"]):
                path = target.joinpath(*relative.parts)
                if member.isdir():
                    path.mkdir(parents=True, exist_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as source, path.open("xb") as output:
                        shutil.copyfileobj(source, output)
                    os.chmod(path, member.mode & 0o777)
    report["store"] = inspect_store(destination / "store.db", destination / "projects")
    report["elapsedSeconds"] = round(time.monotonic() - started, 3)
    # Every EXPECTED tier restored, and nothing the snapshot itself reported
    # as expected-and-missing. A declared-optional tier that turned out to be
    # present is verified above and counts for the deployment, not against it.
    report["completeInventory"] = not report["missingExpectedTiers"] and not report["skipped"]
    report["status"] = "incomplete" if report["store"]["issues"] or not report["completeInventory"] else "verified"
    (destination / "restore-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "verified" else 2


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--dest", type=Path, required=True, help="New isolated directory under an existing parent")
    args = parser.parse_args()
    try:
        raise SystemExit(drill(args.snapshot, args.dest))
    except (ValueError, OSError, sqlite3.Error, tarfile.TarError) as error:
        parser.exit(1, f"Restore drill refused: {error}\n")
